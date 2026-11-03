// Real backend, synthetic account/photos, disposable SQLite/uploads, loopback only.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
import {createServer} from 'node:net'
import {once} from 'node:events'
import {DatabaseSync} from 'node:sqlite'
import sharp from 'sharp'
import {setFamilyAccount} from '../Server/family-auth.mjs'

const source = fileURLToPath(new URL('../', import.meta.url))

test('profile photos can be replaced, preserved and explicitly removed', {timeout:45000}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-photo-edit-'))
  const serverDir = path.join(root, 'Server')
  fs.mkdirSync(path.join(serverDir, 'data'), {recursive:true})
  fs.mkdirSync(path.join(root, 'scripts'))
  fs.mkdirSync(path.join(root, 'dist'))
  fs.writeFileSync(path.join(root, 'dist/index.html'), '<!doctype html><title>Disposable photo test</title>')
  fs.copyFileSync(path.join(source, 'scripts/dependency-release-boot-guard.mjs'),
    path.join(root, 'scripts/dependency-release-boot-guard.mjs'))
  for (const name of fs.readdirSync(path.join(source, 'Server'))) {
    if (name.endsWith('.mjs')) fs.copyFileSync(path.join(source, 'Server', name), path.join(serverDir, name))
  }
  fs.cpSync(path.join(source, 'Server/auth-ui'), path.join(serverDir, 'auth-ui'), {recursive:true})
  fs.symlinkSync(path.join(source, 'node_modules'), path.join(root, 'node_modules'), 'junction')
  const database = path.join(serverDir, 'data/calendar.db')
  const seed = new DatabaseSync(database)
  // Same legacy join-table baseline used by the existing real-backend fixture.
  seed.exec('CREATE TABLE event_people (event_id INTEGER NOT NULL, person_id INTEGER NOT NULL, PRIMARY KEY (event_id, person_id)) STRICT')
  setFamilyAccount(seed, 'photo-tester', 'Photo tester', 'Disposable-Photo-Testing-Password-Only')
  seed.close()
  const probe = createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  assert.ok(![3001,13001,13002,13003,11434,443,8443].includes(port))
  const env = {...process.env, FAMILY_CALENDAR_HOST:'127.0.0.1', FAMILY_CALENDAR_PORT:String(port),
    FAMILY_CALENDAR_AUTH_MODE:'required'}
  for (const key of Object.keys(env)) {
    if (/^FAMILY_CALENDAR_(HOUSEHOLD_|PRIVATE_|LIVE_|TEST_|NOTIFICATION_)/.test(key)) delete env[key]
  }
  const child = spawn(process.execPath, [path.join(serverDir, 'index.mjs')], {
    cwd:root, env, windowsHide:true, stdio:['ignore','pipe','pipe'],
  })
  let log = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk })
  const base = `http://127.0.0.1:${port}`
  const origin = `https://127.0.0.1:${port}`
  try {
    let healthy = false
    for (let attempt=0; attempt<60; attempt++) {
      if (child.exitCode !== null) break
      try { healthy = (await fetch(base+'/api/health', {signal:AbortSignal.timeout(500)})).ok } catch {}
      if (healthy) break
      await new Promise(resolve => setTimeout(resolve,100))
    }
    assert.ok(healthy, log.slice(-2000))
    const login = await fetch(base+'/api/auth/login', {method:'POST',
      headers:{Origin:origin,'Content-Type':'application/json'},
      body:JSON.stringify({username:'photo-tester',password:'Disposable-Photo-Testing-Password-Only'}),
    })
    assert.equal(login.status,200)
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const png = await sharp({create:{width:8,height:8,channels:3,background:'#4477aa'}}).png().toBuffer()
    const uploadDir = path.join(serverDir,'uploads')
    const edit = (id, {photo=false, remove, name='Photo Person', cookieOverride=cookie, originOverride=origin}={}) => {
      const body = new FormData()
      body.append('name',name); body.append('color','#4477aa')
      if (remove !== undefined) body.append('removeImage',remove)
      if (photo) body.append('image',new Blob([png],{type:'image/png'}),'synthetic.png')
      return fetch(base+'/api/people'+(id ? '/'+id : ''), {
        method:id ? 'PUT' : 'POST',headers:{Cookie:cookieOverride,Origin:originOverride},body,
      })
    }
    let person
    await t.test('upload creates an optimized profile photo', async () => {
      const response = await edit(null,{photo:true})
      assert.equal(response.status,201)
      person = await response.json()
      assert.match(person.image,/^avatar-.*\.webp$/)
      assert.ok(fs.existsSync(path.join(uploadDir,person.image)))
    })
    const db = new DatabaseSync(database)
    db.prepare('INSERT INTO events(date,title,person) VALUES (?,?,?)')
      .run('2026-11-03','Unchanged event',person.name)
    const event = db.prepare('SELECT * FROM events').get()
    db.prepare('INSERT INTO event_people(event_id,person_id) VALUES (?,?)').run(event.id,person.id)
    db.close()
    await t.test('saving other profile fields without a photo flag preserves the photo', async () => {
      const response = await edit(person.id)
      assert.equal(response.status,200)
      assert.equal((await response.json()).image,person.image)
    })
    await t.test('replacement updates the photo and removes the superseded upload', async () => {
      const old = person.image
      const response = await edit(person.id,{photo:true})
      assert.equal(response.status,200)
      person = await response.json()
      assert.notEqual(person.image,old)
      assert.equal(fs.existsSync(path.join(uploadDir,old)),false)
    })
    await t.test('unauthenticated and cross-origin removal attempts are blocked', async () => {
      assert.equal((await edit(person.id,{remove:'true',cookieOverride:''})).status,401)
      assert.equal((await edit(person.id,{remove:'true',originOverride:'https://other.example'})).status,403)
      assert.ok(fs.existsSync(path.join(uploadDir,person.image)))
    })
    await t.test('ambiguous replacement/removal and invalid flags leave photo and uploads unchanged', async () => {
      const files = fs.readdirSync(uploadDir).sort()
      assert.equal((await edit(person.id,{remove:'true',photo:true})).status,400)
      assert.equal((await edit(person.id,{remove:'maybe'})).status,400)
      assert.deepEqual(fs.readdirSync(uploadDir).sort(),files)
    })
    await t.test('a failed profile save does not delete the existing photo', async () => {
      assert.equal((await edit(null,{name:'Another Person'})).status,201)
      assert.equal((await edit(person.id,{name:'Another Person',remove:'true'})).status,409)
      assert.ok(fs.existsSync(path.join(uploadDir,person.image)))
    })
    await t.test('explicit removal is saved, idempotent, and preserves the person and event', async () => {
      const old = person.image
      const response = await edit(person.id,{remove:'true'})
      assert.equal(response.status,200)
      const saved = await response.json()
      assert.equal(saved.id,person.id)
      assert.equal(saved.image,null)
      assert.equal(fs.existsSync(path.join(uploadDir,old)),false)
      assert.equal((await edit(person.id,{remove:'true'})).status,200)
      const check = new DatabaseSync(database,{readOnly:true})
      try {
        assert.equal(check.prepare('SELECT image FROM people WHERE id=?').get(person.id).image,null)
        assert.deepEqual(check.prepare('SELECT * FROM events').get(),event)
        assert.deepEqual({...check.prepare('SELECT * FROM event_people').get()},{event_id:event.id,person_id:person.id})
      } finally {check.close()}
    })
    await t.test('removing one profile photo preserves another profile using the same stored image', async () => {
      const response = await edit(person.id,{photo:true})
      assert.equal(response.status,200)
      const withPhoto = await response.json()
      const db = new DatabaseSync(database)
      db.prepare('UPDATE people SET image=? WHERE name=?').run(withPhoto.image,'Another Person')
      db.close()
      assert.equal((await edit(person.id,{remove:'true'})).status,200)
      assert.ok(fs.existsSync(path.join(uploadDir,withPhoto.image)))
      const check = new DatabaseSync(database,{readOnly:true})
      try { assert.equal(check.prepare('SELECT image FROM people WHERE name=?').get('Another Person').image,withPhoto.image) }
      finally {check.close()}
    })
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child,'exit')
      child.kill()
      await exited
    }
    fs.rmSync(root,{recursive:true,force:true})
  }
})
