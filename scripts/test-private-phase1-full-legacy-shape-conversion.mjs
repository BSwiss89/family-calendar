// Source-shaped synthetic legacy database. Schema definitions transcribed
// from installed TEST source 76caa3e4 (index, family-auth, list-features,
// smart-stores, list-icons, emoji markers, invitations, push, notifications).
// event_people's two-column composite key is an inferred legacy relationship,
// not independently verified historical DDL. No actual archived SQL is loaded.
// Matching the archived aggregate counts does NOT prove exact historical DDL.
import test from 'node:test'
import {reviewLegacyTableDefinitionDifference as reviewDdl} from './private-phase1-legacy-ddl-difference-review.mjs'
import {compareSourceShapedLegacyMetadata} from './private-phase1-source-shaped-schema-parity.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes,createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { hashFamilyPassword } from '../Server/family-auth.mjs'
import {installSourceShapedSyntheticLegacyBase,installSourceShapedSyntheticLegacyNotifications} from './private-phase1-source-shaped-legacy-schema.mjs'
import { stageDisposablePhase1PrimaryFamily } from '../Server/private-phase1-disposable-primary-conversion.mjs'
import { listPrivatePhase1LegacyDispositionRules } from '../Server/private-phase1-legacy-table-disposition-review.mjs'

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
  installSourceShapedSyntheticLegacyBase(db)
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
  installSourceShapedSyntheticLegacyNotifications(db)
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

test('schema comparison detects structural differences even with the same column and table counts',t=>{
 const f=buildFixture(t)
 const db=new DatabaseSync(f.file)
 try {
  const exact=compareSourceShapedLegacyMetadata(db)
  assert.equal(exact.structuralMatches,27)
  assert.equal(exact.exactTableDdlMatches,27)
  assert.equal(exact.columnOrderMatches,27)
  assert.equal(exact.exactExplicitIndexDdlMatches,27)
  assert.equal(exact.fullSchemaCompatibilityProven,false)
  db.exec('ALTER TABLE lists RENAME COLUMN icon TO fixture_icon')
  const changed=compareSourceShapedLegacyMetadata(db)
  assert.equal(changed.tables,27)
  assert.equal(changed.structuralMatches,26)
  assert(changed.details.find(x=>x.table==='lists').differences.includes('columns'))
  assert.equal(changed.realMigrationExecuted,false)
  assert.equal(changed.rawArchivedSqlExposed,false)
 } finally {db.close()}
})

test('table definition review distinguishes whitespace and declaration order from real token drift',()=>{
 const expected="CREATE TABLE sample (id INTEGER PRIMARY KEY, label TEXT DEFAULT 'A B', n INTEGER CHECK(n > 0)) STRICT"
 assert.equal(reviewDdl(expected,expected).classification,'EXACT')
 assert.equal(reviewDdl("create table sample ( id integer primary key, /* format */ label text default 'A B', n integer check ( n>0 )) strict",expected).classification,'LEXICAL_MATCH')
 assert.equal(reviewDdl("CREATE TABLE sample (n INTEGER CHECK(n > 0), id INTEGER PRIMARY KEY, label TEXT DEFAULT 'A B') STRICT",expected).classification,'DECLARATION_REORDER_ONLY')
 assert.equal(reviewDdl(expected.replace("'A B'","'a b'"),expected).classification,'REVIEW_REQUIRED')
 const changed=reviewDdl(expected.replace('n > 0','n >= 0'),expected)
 assert.equal(changed.classification,'REVIEW_REQUIRED')
 assert.equal(changed.checkExpressionTokensMatch,false)
 assert.equal(changed.semanticEquivalenceProven,false)
 const conflict=reviewDdl(expected.replace('PRIMARY KEY','PRIMARY KEY ON CONFLICT REPLACE'),expected)
 assert.equal(conflict.classification,'REVIEW_REQUIRED')
 assert.equal(conflict.checkExpressionTokensMatch,true)
 assert.equal(reviewDdl('unknown @ sql',expected).classification,'UNRECOGNIZED_DDL_REVIEW_REQUIRED')
 assert(!JSON.stringify(changed).includes('n > 0'))
})
