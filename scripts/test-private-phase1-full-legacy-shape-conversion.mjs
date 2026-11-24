// Source-shaped synthetic legacy database. Schema definitions transcribed
// from installed TEST source 76caa3e4 (index, family-auth, list-features,
// smart-stores, list-icons, emoji markers, invitations, push, notifications).
// event_people's two-column composite key is an inferred legacy relationship,
// not independently verified historical DDL. No actual archived SQL is loaded.
// Matching the archived aggregate counts does NOT prove exact historical DDL.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes,createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createFamilyAuthTables,hashFamilyPassword } from '../Server/family-auth.mjs'
import { installAssignmentNotificationOutbox } from '../Server/event-assignment-notifications.mjs'
import { installNotificationMutationCapture } from '../Server/notification-event-mutation-capture.mjs'
import { stageDisposablePhase1PrimaryFamily } from '../Server/private-phase1-disposable-primary-conversion.mjs'
import { listPrivatePhase1LegacyDispositionRules } from '../Server/private-phase1-legacy-table-disposition-review.mjs'

const schema = `
CREATE TABLE events (
 id INTEGER PRIMARY KEY,date TEXT NOT NULL,end_date TEXT,title TEXT NOT NULL,
 time TEXT,end_time TEXT,person TEXT,notes TEXT,batch_id TEXT,location TEXT,
 repeat_unit TEXT,repeat_interval INTEGER,repeat_end_type TEXT,
 repeat_end_date TEXT,repeat_count INTEGER
) STRICT;
CREATE TABLE people (
 id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,color TEXT NOT NULL,
 image TEXT,sort_order INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE event_people (
 event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
 PRIMARY KEY(event_id,person_id)
) STRICT;
CREATE TABLE event_exceptions (
 event_id INTEGER NOT NULL,occurrence_date TEXT NOT NULL,
 PRIMARY KEY(event_id,occurrence_date),
 FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE lists (
 id INTEGER PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 store_enabled INTEGER NOT NULL DEFAULT 0,icon TEXT
) STRICT;
CREATE TABLE list_items (
 id INTEGER PRIMARY KEY,list_id INTEGER NOT NULL,text TEXT NOT NULL,
 completed INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 sort_order INTEGER NOT NULL DEFAULT 0,category TEXT NOT NULL DEFAULT 'General',
 store_id INTEGER,store_manual INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY(list_id) REFERENCES lists(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE meal_plans (
 id INTEGER PRIMARY KEY,date TEXT NOT NULL UNIQUE,dinner TEXT NOT NULL,notes TEXT
) STRICT;
CREATE TABLE daily_notes (
 date TEXT PRIMARY KEY,note TEXT NOT NULL DEFAULT '',
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE TABLE recipes (
 id INTEGER PRIMARY KEY,name TEXT NOT NULL,image TEXT,servings INTEGER,
 prep_time TEXT,cook_time TEXT,ingredients TEXT NOT NULL DEFAULT '',
 instructions TEXT NOT NULL DEFAULT '',notes TEXT,tags TEXT,
 favorite INTEGER NOT NULL DEFAULT 0,source_url TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,source_image TEXT
) STRICT;
CREATE TABLE meal_plan_items (
 id INTEGER PRIMARY KEY,date TEXT NOT NULL,meal_type TEXT NOT NULL,
 recipe_id INTEGER,title TEXT NOT NULL,notes TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(recipe_id) REFERENCES recipes(id) ON DELETE SET NULL,
 UNIQUE(date,meal_type)
) STRICT;
CREATE TABLE capture_inbox (
 id INTEGER PRIMARY KEY,image TEXT NOT NULL,original_name TEXT,mime_type TEXT,note TEXT,
 status TEXT NOT NULL DEFAULT 'new',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,capture_type TEXT,
 analysis_status TEXT NOT NULL DEFAULT 'pending',analysis_json TEXT
) STRICT;
CREATE TABLE shopping_stores (
 id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE COLLATE NOCASE,
 enabled INTEGER NOT NULL DEFAULT 1,sort_order INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE shopping_store_preferences (
 item_key TEXT PRIMARY KEY,store_id INTEGER REFERENCES shopping_stores(id) ON DELETE SET NULL
) STRICT;
CREATE TABLE emoji_markers (
 id INTEGER PRIMARY KEY,date TEXT NOT NULL,emoji TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',
 repeat_unit TEXT,repeat_interval INTEGER,repeat_weekdays TEXT,repeat_month_pattern TEXT,
 repeat_end_type TEXT,repeat_end_date TEXT,repeat_count INTEGER
) STRICT;
CREATE TABLE emoji_marker_exceptions (
 marker_id INTEGER NOT NULL,occurrence_date TEXT NOT NULL,
 PRIMARY KEY(marker_id,occurrence_date),
 FOREIGN KEY(marker_id) REFERENCES emoji_markers(id) ON DELETE CASCADE
) STRICT;
CREATE TABLE test_event_invitations (
 id INTEGER PRIMARY KEY,event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
 invited_by_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','accepted','declined')),
 created_at INTEGER NOT NULL,responded_at INTEGER,UNIQUE(event_id,person_id)
) STRICT;
CREATE INDEX test_invitations_pending ON test_event_invitations(person_id,status,created_at);
CREATE TABLE test_push_subscriptions (
 endpoint_hash TEXT PRIMARY KEY,endpoint TEXT NOT NULL,p256dh TEXT NOT NULL,auth TEXT NOT NULL,
 user_id INTEGER NOT NULL,session_id INTEGER NOT NULL,person_id INTEGER NOT NULL,
 subscribed_at INTEGER NOT NULL
) STRICT;
CREATE INDEX test_push_profiles ON test_push_subscriptions(person_id,session_id);
CREATE TABLE test_push_deliveries (
 notification_id INTEGER NOT NULL,endpoint_hash TEXT NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending',PRIMARY KEY(notification_id,endpoint_hash)
) STRICT;
`
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function tables(db) {
 return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(x=>x.name)
}
function aggregate(db) {
 const names=tables(db)
 return {tables:names.length,
   columns:names.reduce((sum,n)=>sum+db.prepare('PRAGMA table_xinfo("'+n+'")').all().length,0),
   indexes:names.reduce((sum,n)=>sum+db.prepare('PRAGMA index_list("'+n+'")').all().length,0),
   foreignKeys:names.reduce((sum,n)=>sum+new Set(db.prepare('PRAGMA foreign_key_list("'+n+'")').all().map(x=>x.id)).size,0),
   triggers:db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'").get().n,
   views:db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='view'").get().n}
}
function buildFixture(t) {
 const temp=fs.realpathSync(os.tmpdir())
 const suffix=randomBytes(8).toString('hex')
 const src=path.join(temp,'fc-phase1-disposable-legacy-'+suffix)
 const out=path.join(temp,'fc-phase1-disposable-converted-'+suffix)
 const checkout=fs.mkdtempSync(path.join(temp,'fc-phase1-synthetic-code-'))
 const serverDirectory=path.join(checkout,'Server')
 t.after(()=>{for(const root of [src,out,checkout])fs.rmSync(root,{recursive:true,force:true})})
 fs.mkdirSync(serverDirectory)
 fs.mkdirSync(path.join(src,'data'),{recursive:true})
 fs.mkdirSync(path.join(src,'uploads','people'),{recursive:true})
 fs.mkdirSync(path.join(src,'uploads','recipes'))
 fs.writeFileSync(path.join(src,'.phase1-disposable-legacy-fixture.json'),JSON.stringify({
  kind:'phase1-disposable-synthetic-legacy-only',version:1,realCalendarDataAllowed:false,
  notificationSchema:'source-generated-v1'
 }))
 fs.writeFileSync(path.join(src,'uploads','people','avatar.bin'),Buffer.from([0,255,23]))
 fs.writeFileSync(path.join(src,'uploads','recipes','photo.bin'),Buffer.from([99,0,21]))
 const file=path.join(src,'data','calendar.db')
 const db=new DatabaseSync(file)
 const passwordHash=hashFamilyPassword('Synthetic Full Shape Example 123!')
 const sessionHash='b'.repeat(64)
 const deviceSecret='synthetic-device-credential-unique-marker'
 try {
  db.exec('PRAGMA foreign_keys=ON')
  db.exec(schema)
  createFamilyAuthTables(db)
  db.prepare('INSERT INTO family_users(id,username,display_name,password_hash) VALUES(1,?,?,?)')
   .run('syntheticowner','Synthetic Owner',passwordHash)
  db.prepare('INSERT INTO family_sessions(id,user_id,token_hash,device_label,created_at,last_seen_at,expires_at,selected_profile_kind,selected_person_id) VALUES(1,1,?,\'fixture\',1,1,9999999999999,\'person\',7)').run(sessionHash)
  db.exec(`
    INSERT INTO people(id,name,color,image) VALUES(7,'Synthetic Person','#123456','people/avatar.bin');
    INSERT INTO events(id,date,end_date,title,time,end_time,person,notes,batch_id,location,repeat_unit,repeat_interval,repeat_end_type,repeat_end_date,repeat_count)
    VALUES(46,'2026-11-24','2026-11-24','Synthetic event','09:00','10:00','Synthetic Person','Synthetic notes','fixture','Synthetic venue','week',2,'count',NULL,4);
    INSERT INTO event_people VALUES(46,7);
    INSERT INTO event_exceptions VALUES(46,'2026-12-08');
    INSERT INTO lists(id,name,store_enabled,icon) VALUES(2,'Synthetic groceries',1,'cart');
    INSERT INTO shopping_stores(id,name) VALUES(3,'Synthetic Store');
    INSERT INTO list_items(id,list_id,text,completed,sort_order,category,store_id,store_manual)
    VALUES(23,2,'Synthetic milk',1,4,'Dairy',3,1);
    INSERT INTO shopping_store_preferences VALUES('synthetic milk',3);
    INSERT INTO daily_notes(date,note) VALUES('2026-11-24','Synthetic note');
    INSERT INTO recipes(id,name,image,servings,ingredients,instructions,source_image) VALUES(4,'Synthetic recipe','recipes/photo.bin',2,'milk','mix','synthetic-source');
    INSERT INTO meal_plans(id,date,dinner,notes) VALUES(5,'2026-11-24','Synthetic dinner','notes');
    INSERT INTO meal_plan_items(id,date,meal_type,recipe_id,title) VALUES(6,'2026-11-24','dinner',4,'Synthetic dinner');
    INSERT INTO emoji_markers(id,date,emoji,label,repeat_unit,repeat_interval,repeat_end_type,repeat_count)
    VALUES(8,'2026-11-24','★','Synthetic marker','week',2,'count',4);
    INSERT INTO emoji_marker_exceptions VALUES(8,'2026-12-08');
    INSERT INTO test_event_invitations(id,event_id,person_id,status,created_at,responded_at)
    VALUES(11,46,7,'accepted',1,2);
  `)
  installAssignmentNotificationOutbox(db)
  installNotificationMutationCapture(db)
  db.exec('CREATE TABLE test_assignment_acknowledgements(notification_id INTEGER PRIMARY KEY REFERENCES assignment_notification_outbox(id),acknowledged_at INTEGER NOT NULL CHECK(acknowledged_at > 0)) STRICT')
  const notice=db.prepare('INSERT INTO assignment_notification_outbox(id,event_id,person_id,kind,created_at,delivered_at,cancelled_details_json) VALUES(?,?,?,?,?,?,?)')
  for(let n=1;n<=31;n++)notice.run(n,n<=4?1000+n:46,n===5||n===6?2000+n:7,'cancelled',100+n,200+n,JSON.stringify({title:'Synthetic historical notice '+n,date:'2026-11-24'}))
  const ack=db.prepare('INSERT INTO test_assignment_acknowledgements VALUES(?,?)')
  for(let n=1;n<=14;n++)ack.run(n,300+n)
  db.prepare('INSERT INTO test_push_subscriptions VALUES(?,?,?,?,1,1,7,1)')
   .run('synthetic-endpoint-hash','https://example.invalid/synthetic-push','synthetic-key',deviceSecret)
  db.exec("INSERT INTO test_push_deliveries(notification_id,endpoint_hash) VALUES(1,'synthetic-endpoint-hash')")
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
  assert.deepEqual(tables(db),listPrivatePhase1LegacyDispositionRules().map(x=>x.table).sort())
  assert.deepEqual(aggregate(db),{tables:27,columns:162,indexes:20,foreignKeys:12,triggers:14,views:0})
 } finally {db.close()}
 return {src,out,file,serverDirectory,passwordHash,sessionHash,deviceSecret}
}

test('source-shaped 27-table/162-column first-family synthetic fixture splits and preserves calendar features',t=>{
 const f=buildFixture(t)
 const original=hash(f.file)
 const receipt=stageDisposablePhase1PrimaryFamily({serverDirectory:f.serverDirectory,sourceRoot:f.src,destinationRoot:f.out})
 assert.equal(receipt.preservedHouseholdAndNoticeTables,22)
 assert.equal(receipt.sourceGeneratedCurrentNotificationTriggersPreserved,14)
 assert.equal(receipt.copiedUploadFiles,2)
 assert.equal(receipt.historicalOutboxRowsPreserved,31)
 assert.equal(receipt.orphanedEventNoticeReferencesPreserved,4)
 assert.equal(receipt.orphanedPersonNoticeReferencesPreserved,2)
 assert.equal(receipt.historicalAcknowledgementRowsPreserved,14)
 assert.equal(receipt.fullLegacySchemaCompatibilityProven,false)
 assert.equal(receipt.actualTestMigrationExecuted,false)
 assert.equal(receipt.testDeploymentAuthorized,false)
 assert.equal(receipt.liveDeploymentAuthorized,false)
 const home=path.join(f.out,'households','primary-family')
 const file=path.join(home,'data','calendar.db')
 const bytes=fs.readFileSync(file)
 for(const secret of [f.passwordHash,f.sessionHash,f.deviceSecret,'syntheticowner','https://example.invalid/synthetic-push']){
  assert.equal(bytes.includes(Buffer.from(secret)),false)
 }
 for(const relative of ['people/avatar.bin','recipes/photo.bin']){
  assert.equal(hash(path.join(home,'uploads',relative)),hash(path.join(f.src,'uploads',relative)))
 }
 const db=new DatabaseSync(file)
 try {
  assert.equal(db.prepare('SELECT repeat_interval FROM events WHERE id=46').get().repeat_interval,2)
  assert.equal(db.prepare('SELECT store_manual FROM list_items WHERE id=23').get().store_manual,1)
  assert.equal(db.prepare('SELECT recipe_id FROM meal_plan_items WHERE id=6').get().recipe_id,4)
  assert.equal(db.prepare('SELECT status FROM test_event_invitations WHERE id=11').get().status,'accepted')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emoji_marker_exceptions').get().n,1)
  assert.equal(db.prepare('SELECT note FROM daily_notes').get().note,'Synthetic note')
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
  assert.equal(db.prepare('PRAGMA freelist_count').get().freelist_count,0)
  db.exec("DELETE FROM recipes WHERE id=4")
  assert.equal(db.prepare('SELECT recipe_id FROM meal_plan_items WHERE id=6').get().recipe_id,null)
  db.exec("DELETE FROM emoji_markers WHERE id=8")
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emoji_marker_exceptions').get().n,0)
  db.exec("DELETE FROM shopping_stores WHERE id=3")
  assert.equal(db.prepare('SELECT store_id FROM shopping_store_preferences').get().store_id,null)
  db.exec("DELETE FROM events WHERE id=46")
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM event_exceptions').get().n,0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM test_event_invitations').get().n,0)
  assert.equal(db.prepare('SELECT title FROM notification_deleted_event_details WHERE event_id=46').get().title,'Synthetic event')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assignment_notification_outbox').get().n,31)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM test_assignment_acknowledgements').get().n,14)
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
 } finally {db.close()}
 assert.equal(hash(f.file),original)
})
