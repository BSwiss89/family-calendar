import test from 'node:test'
import assert from 'node:assert/strict'
import {createECDH,createHmac,createDecipheriv,createPublicKey,createVerify,randomBytes} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {approvedPushEndpoint,encodePush,publicVapidKey} from '../Server/test-web-push-crypto.mjs'
import {installTestInformationalPush} from '../Server/test-informational-push.mjs'
import {installAssignmentNotificationOutbox} from '../Server/event-assignment-notifications.mjs'
import {installNotificationMutationCapture} from '../Server/notification-event-mutation-capture.mjs'

const b64=bytes=>bytes.toString('base64url')
const fixed=Date.now()
function keypair() {const e=createECDH('prime256v1');e.generateKeys();return e}
const vapid=keypair()
const config={privateKey:b64(vapid.getPrivateKey()),subject:'mailto:family@example.com'}
const browser=keypair()
const authSecret=randomBytes(16)
const subscription={
  endpoint:'https://web.push.apple.com/test-browser-subscription',
  keys:{p256dh:b64(browser.getPublicKey(undefined,'uncompressed')),auth:b64(authSecret)}
}
const hExtract=(salt,data)=>createHmac('sha256',salt).update(data).digest()
const hExpand=(prk,info,n)=>createHmac('sha256',prk).update(info).update(Buffer.from([1])).digest().subarray(0,n)

test('VAPID JWT is correctly signed and RFC8291 aes128gcm payload can be decrypted',()=>{
  const data={title:'Family Calendar',body:'An event involving you was added.',url:'/'}
  const out=encodePush({...config,...subscription.keys,...{endpoint:subscription.endpoint,payload:data}})
  const body=out.body
  assert.equal(body.subarray(16,20).readUInt32BE(),4096)
  assert.equal(body[20],65)
  const salt=body.subarray(0,16)
  const serverPublic=body.subarray(21,86)
  const prk=hExtract(authSecret,browser.computeSecret(serverPublic))
  const info=Buffer.concat([Buffer.from('WebPush: info\0'),browser.getPublicKey(undefined,'uncompressed'),serverPublic])
  const ikm=hExpand(prk,info,32)
  const master=hExtract(salt,ikm)
  const key=hExpand(master,Buffer.from('Content-Encoding: aes128gcm\0'),16)
  const nonce=hExpand(master,Buffer.from('Content-Encoding: nonce\0'),12)
  const ct=body.subarray(86,body.length-16)
  const decipher=createDecipheriv('aes-128-gcm',key,nonce)
  decipher.setAuthTag(body.subarray(body.length-16))
  const plain=Buffer.concat([decipher.update(ct),decipher.final()])
  assert.equal(plain[plain.length-1],2)
  assert.deepEqual(JSON.parse(plain.subarray(0,-1).toString('utf8')),data)
  const raw=Buffer.from(publicVapidKey(config.privateKey),'base64url')
  const k=createPublicKey({key:{kty:'EC',crv:'P-256',
    x:b64(raw.subarray(1,33)),y:b64(raw.subarray(33))},format:'jwk'})
  const token=out.headers.Authorization.match(/t=([^, ]+)/)[1]
  const pieces=token.split('.')
  const v=createVerify('sha256');v.update(pieces[0]+'.'+pieces[1]);v.end()
  assert.equal(v.verify({key:k,dsaEncoding:'ieee-p1363'},Buffer.from(pieces[2],'base64url')),true)
  assert.equal(JSON.parse(Buffer.from(pieces[1],'base64url').toString()).aud,'https://web.push.apple.com')
})

test('Push delivery destinations reject URLs that could reach local/internal hosts',()=>{
  for(const endpoint of ['https://127.0.0.1/push','http://web.push.apple.com/a',
    'https://push.apple.com.evil.example/push','https://user@web.push.apple.com/a',
    'https://fcm.googleapis.com:443/a','https://example.com/a']) {
    assert.equal(approvedPushEndpoint(endpoint),false,endpoint)
  }
  assert.equal(approvedPushEndpoint(subscription.endpoint),true)
})

function fixture() {
  const db=new DatabaseSync(':memory:')
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE family_users(id INTEGER PRIMARY KEY,disabled INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE family_sessions(
      id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,
      selected_profile_kind TEXT,selected_person_id INTEGER,
      revoked_at INTEGER,expires_at INTEGER NOT NULL);
    CREATE TABLE people(id INTEGER PRIMARY KEY);
    CREATE TABLE events(id INTEGER PRIMARY KEY,date TEXT,title TEXT,time TEXT,
      end_date TEXT,end_time TEXT,notes TEXT,location TEXT,
      repeat_unit TEXT,repeat_interval INTEGER,repeat_end_type TEXT,
      repeat_end_date TEXT,repeat_count INTEGER);
    CREATE TABLE event_people(event_id INTEGER,person_id INTEGER);
    CREATE TABLE event_exceptions(event_id INTEGER,occurrence_date TEXT);
    INSERT INTO people(id) VALUES (1),(2);
    INSERT INTO family_users(id) VALUES (1);
  `)
  db.prepare('INSERT INTO family_sessions(id,user_id,selected_profile_kind,selected_person_id,expires_at) VALUES (?,?,?,?,?)')
    .run(10,1,'person',2,fixed+3600000)
  installAssignmentNotificationOutbox(db)
  installNotificationMutationCapture(db)
  const methods={get:new Map(),post:new Map(),delete:new Map()}
  const app={}
  for(const method of ['get','post','delete']){
    app[method]=(path,handler)=>methods[method].set(path,handler)
  }
  function call(method,path,body={},account={id:10,user_id:1}) {
    const handler=methods[method].get(path)
    assert.ok(handler,'Missing route '+method+' '+path)
    const result={status:200,body:null,headers:{}}
    const res={
      set(name,value){result.headers[name]=value;return this},
      status(n){result.status=n;return this},
      json(value){result.body=value;return this},
    }
    handler({body,familyAccount:account},res)
    return result
  }
  return {db,app,call}
}

test('TEST-only flag and port prevent accidental release to LIVE',()=>{
  const x=fixture()
  assert.equal(installTestInformationalPush(x.app,x.db,{flag:'disabled'}).enabled,false)
  assert.throws(()=>installTestInformationalPush(x.app,x.db,{
    flag:'enabled',port:3001,authMode:'required',rootFolder:'/tmp/family-calendar-test-gated',
    ...config,
  }))
  x.db.close()
})

test('Trusted device profile opt-in sends once, Home and revoked sessions prevent delivery',async()=>{
  const x=fixture()
  const sent=[]
  const pilot=installTestInformationalPush(x.app,x.db,{
    flag:'enabled',port:13002,authMode:'required',
    rootFolder:'/tmp/family-calendar-test-pilot',...config,
    now:()=>fixed,schedule:false,
    send:async (sub,payload)=>{sent.push({endpoint:sub.endpoint,payload});return 201},
  })
  assert.equal(pilot.enabled,true)
  assert.equal(x.call('get','/api/test-push/config').body.publicKey,publicVapidKey(config.privateKey))
  assert.equal(x.call('post','/api/test-push/subscriptions',{
    endpoint:subscription.endpoint,keys:subscription.keys,
  }).body.personId,2)
  x.db.exec("INSERT INTO events(id,date,title) VALUES (1,'2026-11-02','Secret detail not in push')")
  x.db.exec('INSERT INTO event_people(event_id,person_id) VALUES(1,2)')
  assert.equal((await pilot.tick()).accepted,1)
  assert.equal(sent.length,1)
  assert.equal(sent[0].payload.title,'Family Calendar')
  assert.equal(JSON.stringify(sent[0].payload).includes('Secret'),false)
  assert.equal((await pilot.tick()).accepted,0)
  x.db.exec("UPDATE family_sessions SET selected_profile_kind='home',selected_person_id=NULL WHERE id=10")
  x.db.exec("INSERT INTO events(id,date,title) VALUES (2,'2026-11-02','Second event')")
  x.db.exec('INSERT INTO event_people(event_id,person_id) VALUES(2,2)')
  assert.equal((await pilot.tick()).accepted,0)
  assert.equal(x.call('post','/api/test-push/subscriptions',{
    endpoint:subscription.endpoint,keys:subscription.keys,
  }).status,403)
  x.db.exec("UPDATE family_sessions SET selected_profile_kind='person',selected_person_id=2,revoked_at=? WHERE id=10".replace('?',String(fixed)))
  assert.equal((await pilot.tick()).accepted,0)
  pilot.close();x.db.close()
})

test('Subscription rejects arbitrary endpoints and other sessions cannot impersonate a device',()=>{
  const x=fixture()
  const pilot=installTestInformationalPush(x.app,x.db,{
    flag:'enabled',port:13002,authMode:'required',
    rootFolder:'/tmp/family-calendar-test-pilot',...config,now:()=>fixed,schedule:false,
  })
  assert.equal(x.call('post','/api/test-push/subscriptions',{
    endpoint:'https://127.0.0.1/private',keys:subscription.keys,
  }).status,400)
  assert.equal(x.call('post','/api/test-push/subscriptions',{
    endpoint:subscription.endpoint,keys:subscription.keys,
  },{id:11,user_id:1}).status,401)
  assert.equal(x.call('get','/api/test-push/status',{}, {id:11,user_id:1}).status,401)
  pilot.close();x.db.close()
})
