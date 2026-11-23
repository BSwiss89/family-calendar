// Only synthetic OS-temp fixture data. No installed LIVE or TEST paths,
// Windows services/tasks, actual backup archive or real credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { hashFamilyPassword } from '../Server/family-auth.mjs'
import { listPrivatePhase1LegacyDispositionRules } from '../Server/private-phase1-legacy-table-disposition-review.mjs'
import { stageDisposablePhase1PrimaryFamily as convert }
  from '../Server/private-phase1-disposable-primary-conversion.mjs'

const secret='THIS_IS_A_SYNTHETIC_PRIVATE_EVENT_AND_USERNAME_DO_NOT_PRINT'
const suffix=()=>randomBytes(8).toString('hex')
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function fixture(t) {
  const codeRoot=fs.mkdtempSync(path.join(os.tmpdir(),'fc-phase1-synthetic-code-'))
  const src=path.join(os.tmpdir(),'fc-phase1-disposable-legacy-'+suffix())
  const dest=path.join(os.tmpdir(),'fc-phase1-disposable-converted-'+suffix())
  t.after(()=>{
    for(const dir of [codeRoot,src,dest]) fs.rmSync(dir,{recursive:true,force:true})
  })
  const serverDirectory=path.join(codeRoot,'Server')
  fs.mkdirSync(serverDirectory)
  fs.mkdirSync(src)
  fs.mkdirSync(path.join(src,'data'))
  fs.mkdirSync(path.join(src,'uploads'))
  fs.mkdirSync(path.join(src,'uploads','people'))
  fs.mkdirSync(path.join(src,'uploads','empty-folder'))
  fs.writeFileSync(path.join(src,'.phase1-disposable-legacy-fixture.json'),
    JSON.stringify({kind:'phase1-disposable-synthetic-legacy-only',
      version:1,realCalendarDataAllowed:false}))
  const avatar=path.join(src,'uploads','people','portrait.bin')
  fs.writeFileSync(avatar,Buffer.from([0,3,255,16]))
  const dbFile=path.join(src,'data','calendar.db')
  const db=new DatabaseSync(dbFile)
  try {
    db.exec('PRAGMA foreign_keys=ON')
    for(const rule of listPrivatePhase1LegacyDispositionRules()){
      let sql
      switch(rule.table) {
        case 'family_users':
          sql='CREATE TABLE family_users(id INTEGER PRIMARY KEY,username TEXT,display_name TEXT,password_hash TEXT,account_kind TEXT,disabled INTEGER)'
          break
        case 'family_sessions':
          sql='CREATE TABLE family_sessions(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES family_users(id),token_hash TEXT,revoked_at INTEGER,expires_at INTEGER)'
          break
        case 'people':
          sql='CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT)'
          break
        case 'events':
          sql='CREATE TABLE events(id INTEGER PRIMARY KEY,title TEXT,payload BLOB)'
          break
        case 'event_people':
          sql='CREATE TABLE event_people(id INTEGER PRIMARY KEY,event_id INTEGER REFERENCES events(id),person_id INTEGER REFERENCES people(id))'
          break
        case 'lists':
          sql='CREATE TABLE lists(id INTEGER PRIMARY KEY,name TEXT)'
          break
        case 'list_items':
          sql='CREATE TABLE list_items(id INTEGER PRIMARY KEY,list_id INTEGER REFERENCES lists(id),title TEXT)'
          break
        case 'test_event_invitations':
          sql='CREATE TABLE test_event_invitations(id INTEGER PRIMARY KEY,event_id INTEGER REFERENCES events(id),status TEXT)'
          break
        case 'shopping_stores':
          sql='CREATE TABLE shopping_stores(id INTEGER PRIMARY KEY,title TEXT)'
          break
        case 'shopping_store_preferences':
          sql='CREATE TABLE shopping_store_preferences(id INTEGER PRIMARY KEY,store_id INTEGER REFERENCES shopping_stores(id),value TEXT)'
          break
        default:
          sql='CREATE TABLE "'+rule.table+'"(id INTEGER PRIMARY KEY,value TEXT)'
      }
      db.exec(sql)
    }
    const password=hashFamilyPassword('Synthetic Only Long Example Password 12345!')
    db.prepare('INSERT INTO family_users VALUES(?,?,?,?,?,?)')
      .run(1,'syntheticowner','Synthetic Owner',password,'person',0)
    const now=Date.now()
    db.prepare('INSERT INTO family_sessions VALUES(?,?,?,?,?)')
      .run(1,1,'f'.repeat(64),null,now+3600000)
    db.prepare('INSERT INTO family_sessions VALUES(?,?,?,?,?)')
      .run(2,1,'e'.repeat(64),now-10,now-5)
    db.prepare('INSERT INTO people VALUES (?,?)').run(7,secret)
    db.prepare('INSERT INTO events VALUES (?,?,?)')
      .run(46,secret,new Uint8Array([0,4,255,200]))
    db.prepare('INSERT INTO event_people VALUES (?,?,?)').run(1,46,7)
    db.prepare('INSERT INTO lists VALUES (?,?)').run(2,'Private Groceries')
    db.prepare('INSERT INTO list_items VALUES (?,?,?)').run(23,2,'Milk')
    db.prepare('INSERT INTO shopping_stores VALUES (?,?)').run(3,'H-E-B')
    db.prepare('INSERT INTO shopping_store_preferences VALUES (?,?,?)')
      .run(1,3,'manual-lock')
    db.prepare('INSERT INTO test_event_invitations VALUES (?,?,?)')
      .run(11,46,'accepted')
    for(const table of ['daily_notes','emoji_markers','meal_plans',
      'meal_plan_items','notification_event_baselines',
      'assignment_notification_outbox','test_assignment_acknowledgements',
      'test_push_subscriptions','test_push_deliveries']) {
      db.prepare('INSERT INTO "'+table+'"(id,value) VALUES (?,?)').run(1,secret)
    }
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
  } finally {db.close()}
  return {serverDirectory,sourceRoot:src,destinationRoot:dest,dbFile,avatar}
}
const stage=f=>convert({
  serverDirectory:f.serverDirectory,sourceRoot:f.sourceRoot,
  destinationRoot:f.destinationRoot,
})
test('synthetic first family split preserves all 22 data/history tables while disabling central owner and discarding activated sessions',t=>{
  const f=fixture(t)
  const beforeDb=hash(f.dbFile),beforeAvatar=hash(f.avatar)
  const r=stage(f)
  assert.equal(r.kind,'phase1-disposable-primary-family-split-rehearsal-v1')
  assert.equal(r.sourceFixtureOnly,true)
  assert.equal(r.preservedHouseholdAndNoticeTables,22)
  assert.equal(r.copiedUploadFiles,1)
  assert.equal(r.stagedOwnersDisabled,1)
  assert.equal(r.centralActiveSessions,0)
  assert.equal(r.archivedLegacySessionsNotActivated,true)
  assert.equal(r.sourceCredentialsNotPlacedInHouseholdDatabase,true)
  assert.equal(r.savedPushDeviceSubscriptionsNotActivated,true)
  assert.equal(r.fullLegacySchemaCompatibilityProven,false)
  for(const key of ['centralGatewayBootProven','activeRealCalendarDataHandled',
    'actualTestMigrationExecuted','automatedReactivationAllowed',
    'backupAuthorized','rollbackAuthorized','testDeploymentAuthorized',
    'liveDeploymentAuthorized'])assert.equal(r[key],false,key)
  const centralPath=path.join(f.destinationRoot,'central','identity.db')
  const familyPath=path.join(f.destinationRoot,'households','primary-family',
    'data','calendar.db')
  const c=new DatabaseSync(centralPath,{readOnly:true})
  const h=new DatabaseSync(familyPath,{readOnly:true})
  try {
    assert.equal(c.prepare('SELECT COUNT(*) AS n FROM family_users').get().n,1)
    assert.equal(c.prepare('SELECT disabled FROM family_users').get().disabled,1)
    assert.equal(c.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n,0)
    assert.equal(c.prepare('SELECT COUNT(*) AS n FROM household_memberships WHERE role=? AND disabled=1').get('owner').n,1)
    assert.equal(c.prepare('SELECT COUNT(*) AS n FROM household_registry WHERE disabled=1').get().n,1)
    const names=new Set(h.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x=>x.name))
    for(const table of ['family_users','family_sessions','test_push_subscriptions',
      'test_push_deliveries','capture_inbox']) assert.equal(names.has(table),false)
    for(const table of ['events','people','lists','list_items','emoji_markers',
      'meal_plans','assignment_notification_outbox',
      'notification_event_baselines','test_event_invitations',
      'test_assignment_acknowledgements']) assert.equal(names.has(table),true)
    assert.equal(h.prepare('SELECT title FROM events').get().title,secret)
    assert.deepEqual([...h.prepare('SELECT payload FROM events').get().payload],
      [0,4,255,200])
    assert.equal(h.prepare('SELECT name FROM people').get().name,secret)
    assert.equal(h.prepare('SELECT status FROM test_event_invitations').get().status,'accepted')
    assert.equal(h.prepare('PRAGMA foreign_key_check').all().length,0)
  } finally {c.close();h.close()}
  assert.equal(hash(f.dbFile),beforeDb)
  assert.equal(hash(f.avatar),beforeAvatar)
  assert.equal(hash(path.join(f.destinationRoot,'households','primary-family',
    'uploads','people','portrait.bin')),beforeAvatar)
  assert.equal(fs.existsSync(path.join(f.destinationRoot,'households',
    'primary-family','uploads','empty-folder')),true)
  const raw=JSON.stringify(r)
  assert.doesNotMatch(raw,/syntheticowner|Private Groceries|THIS_IS_A_SYNTHETIC/)
  assert.throws(()=>stage(f),/refused/)
})
test('real recovery layout and unmarked source are never eligible for conversion',t=>{
  const f=fixture(t)
  fs.writeFileSync(path.join(f.sourceRoot,'.phase1-disposable-legacy-fixture.json'),
    '{"kind":"phase1-offline-legacy-test-snapshot-v1"}')
  assert.throws(()=>stage(f),/refused/)
  assert.equal(fs.existsSync(f.destinationRoot),false)
  const other=fixture(t)
  const replacement=path.join(os.tmpdir(),'family-calendar-phase1-recovery')
  assert.throws(()=>convert({...other,sourceRoot:replacement}),/refused|ENOENT/)
})
test('new table, WAL, excluded foreign key or retired inbox content fail closed and leave no staged output',t=>{
  for(const change of [
    f=>fs.writeFileSync(f.dbFile+'-wal','unsafe'),
    f=>{
      const db=new DatabaseSync(f.dbFile)
      try{db.exec('CREATE TABLE leaked_sensitivity(id INTEGER PRIMARY KEY)')}
      finally{db.close()}
    },
    f=>{
      const db=new DatabaseSync(f.dbFile)
      try{db.prepare('INSERT INTO capture_inbox(id,value) VALUES(1,?)').run(secret)}
      finally{db.close()}
    },
    f=>{
      const db=new DatabaseSync(f.dbFile)
      try{
        db.exec('ALTER TABLE daily_notes ADD COLUMN owner_id INTEGER REFERENCES family_users(id)')
      }finally{db.close()}
    },
    f=>{
      const db=new DatabaseSync(f.dbFile)
      try{db.exec('CREATE VIEW unsafe_view AS SELECT * FROM family_users')}
      finally{db.close()}
    },
  ]) {
    const f=fixture(t);change(f)
    assert.throws(()=>stage(f),/refused/)
    assert.equal(fs.existsSync(f.destinationRoot),false)
  }
})
test('untrusted destination collision, linked uploads, unsupported owner and separate code/source boundaries fail closed',t=>{
  const f=fixture(t)
  fs.mkdirSync(f.destinationRoot)
  assert.throws(()=>stage(f),/refused/)
  fs.rmdirSync(f.destinationRoot)
  const sym=path.join(f.sourceRoot,'uploads','unsafe-link')
  // Windows CI runners may not grant unprivileged symlink creation.
  let linked=false
  try {fs.symlinkSync(f.avatar,sym,'file');linked=true}
  catch(error) {
    if(process.platform!=='win32'||!['EPERM','EACCES','ENOSYS'].includes(error.code))throw error
  }
  if(linked) {
    assert.throws(()=>stage(f),/refused/)
    fs.rmSync(sym)
  }
  const db=new DatabaseSync(f.dbFile)
  try{
    db.exec("UPDATE family_users SET account_kind='hub'")
  } finally {db.close()}
  assert.throws(()=>stage(f),/refused/)
  assert.equal(fs.existsSync(f.destinationRoot),false)
})
