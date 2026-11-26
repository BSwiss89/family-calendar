// Source-shaped synthetic legacy database. Schema definitions transcribed
// from installed TEST source 76caa3e4 (index, family-auth, list-features,
// smart-stores, list-icons, emoji markers, invitations, push, notifications).
// event_people's two-column composite key is an inferred legacy relationship,
// not independently verified historical DDL. No actual archived SQL is loaded.
// Matching the archived aggregate counts does NOT prove exact historical DDL.
import test from 'node:test'
import {installPrivateEventIdentity} from '../Server/private-event-identity.mjs'
import {reconcileNotificationMutations} from '../Server/notification-event-mutation-capture.mjs'
import {createEventShareTables} from '../Server/event-only-shares.mjs'
import {createEventShareSyncJournal} from '../Server/event-share-sync-journal.mjs'
import {captureDisposableCoordinatedHouseholdSnapshot} from '../Server/private-disposable-coordinated-snapshot.mjs'
import {copyVerifiedPrivateRestoreSet} from '../Server/private-offline-restore-rehearsal.mjs'
import {verifyOfflinePrivateRestoreSet} from '../Server/private-restore-preflight.mjs'
import {reviewDisposablePhase1PostWriteRollback} from '../Server/private-phase1-post-write-rollback-review.mjs'
import {rehearseOfflineCentralOwner,verifyOfflineCentralOwnerPassword} from './private-phase1-offline-central-owner-rehearsal.mjs'
import {EventEmitter} from 'node:events'
import {readHiddenOwnerPassword} from './private-phase1-local-owner-password-proof.mjs'
import {rehearseOfflineHouseholdCopy,rehearseOfflineCoordinatedPrimaryFamily,rehearseOfflineCoordinatedPrimaryStartupPlan,rehearseOfflineCoordinatedPrimaryBoot,prepareInactivePhase1TestMigrationStage} from './private-phase1-offline-household-copy-rehearsal.mjs'
import {reviewLegacyTableDefinitionDifference as reviewDdl,reviewEventPeopleReferencePlacement} from './private-phase1-legacy-ddl-difference-review.mjs'
import {compareSourceShapedLegacyMetadata} from './private-phase1-source-shaped-schema-parity.mjs'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes,createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { hashFamilyPassword, verifyFamilyPassword } from '../Server/family-auth.mjs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createPrivateActivationRecords } from '../Server/private-household-activation-records.mjs'
import { createIndependentHouseholdInvitationTables } from '../Server/independent-household-invitations.mjs'
import { launchDisposableReviewedPhase1Gateway } from '../Server/private-disposable-reviewed-phase1-gateway-runtime.mjs'
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

test('event_people review accepts only the two reviewed cascade relationships',()=>{
 const inline='CREATE TABLE event_people (event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, PRIMARY KEY(event_id,person_id)) STRICT'
 const table='CREATE TABLE event_people (event_id INTEGER NOT NULL, person_id INTEGER NOT NULL, PRIMARY KEY(event_id,person_id), FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE, FOREIGN KEY(person_id) REFERENCES people(id) ON DELETE CASCADE) STRICT'
 assert.equal(reviewEventPeopleReferencePlacement(inline),true)
 assert.equal(reviewEventPeopleReferencePlacement(table),true)
 for(const sql of [
  table.replace('ON DELETE CASCADE','ON DELETE RESTRICT'),
  table.replace('ON DELETE CASCADE','ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED'),
  table.replace('PRIMARY KEY(event_id,person_id)','PRIMARY KEY(person_id,event_id)'),
  table.replace('PRIMARY KEY(event_id,person_id)','PRIMARY KEY(event_id,person_id) ON CONFLICT REPLACE'),
  table.replace('REFERENCES events(id)','REFERENCES people(id)'),
  table.replace('STRICT','STRICT, WITHOUT ROWID'),
  table.replace('INTEGER NOT NULL','INTEGER')
 ])assert.equal(reviewEventPeopleReferencePlacement(sql),false)
})

function buildVerifiedOfflineFixture(t){
 const f=buildFixture(t)
 const outer=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'fc-phase1-archive-test-'))
 t.after(()=>fs.rmSync(outer,{recursive:true,force:true}))
 const recoveryParent=path.join(outer,'family-calendar-phase1-recovery')
 const snapshotRoot=path.join(recoveryParent,'OFFLINE-LEGACY-TEST-20261122-212047-'+randomBytes(16).toString('hex'))
 fs.mkdirSync(snapshotRoot,{recursive:true})
 const file=path.join(snapshotRoot,'calendar.db')
 fs.copyFileSync(f.file,file)
 const db=new DatabaseSync(file)
 try{
  const current=db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='notify_event_insert'").get().sql
  const old=current.replace('DELETE FROM notification_deleted_event_details WHERE event_id=NEW.id;\n','')
  assert.notEqual(old,current)
  db.exec('DROP TRIGGER notify_event_insert')
  db.exec(old)
 }finally{db.close()}
 fs.cpSync(path.join(f.src,'uploads'),path.join(snapshotRoot,'uploads'),{recursive:true})
 fs.mkdirSync(path.join(snapshotRoot,'dist'))
 fs.writeFileSync(path.join(snapshotRoot,'dist','index.html'),'synthetic')
 fs.writeFileSync(path.join(snapshotRoot,'start-secure-test-patched.ps1'),'# synthetic')
 const files=['calendar.db','dist/index.html','uploads/people/avatar.bin','uploads/recipes/photo.bin','start-secure-test-patched.ps1'].map(p=>({path:p,sha256:hash(path.join(snapshotRoot,p))}))
 const expectedInstalledTestSha='76caa3e46186c3c5c6408f11b55800eb06779776'
 fs.writeFileSync(path.join(snapshotRoot,'OFFLINE-LEGACY-REVIEW.json'),JSON.stringify({
  kind:'phase1-offline-legacy-test-snapshot-v1',sourceSha:expectedInstalledTestSha,capturedAt:'2026-11-22T21:20:47Z',
  databaseSha256:hash(file),supervisorSha256:hash(path.join(snapshotRoot,'start-secure-test-patched.ps1')),sqliteIntegrity:'ok',
  uploads:2,dist:1,fileCount:files.length,files,restoreBootVerified:false,coordinatedCentralAndFamilySnapshot:false,
  safeToCutover:false,testDeploymentAuthorized:false,liveDeploymentAuthorized:false
 }))
 return {recoveryParent,snapshotRoot,expectedInstalledTestSha}
}
test('verified offline rehearsal repairs only disposable copy and preserves all household history',t=>{
 const args=buildVerifiedOfflineFixture(t)
 const source=path.join(args.snapshotRoot,'calendar.db'),before=hash(source)
 const r=rehearseOfflineHouseholdCopy(args)
 assert.equal(r.preservedTables,22)
 assert.equal(r.currentTriggers,14)
 assert.equal(r.excludedTables,5)
 assert.equal(r.notices,31)
 assert.equal(r.acknowledgements,14)
 assert.equal(r.uploads,2)
 assert.equal(r.temporaryCopyRemoved,true)
 assert.equal(r.archiveUnchanged,true)
 assert.equal(r.identityMigrationExecuted,false)
 assert.equal(r.actualTestMigrationExecuted,false)
 assert.equal(r.testDeploymentAuthorized,false)
 assert.equal(hash(source),before)
})
test('offline rehearsal refuses altered verified archive',t=>{
 const args=buildVerifiedOfflineFixture(t)
 fs.appendFileSync(path.join(args.snapshotRoot,'uploads','people','avatar.bin'),'tampered')
 assert.throws(()=>rehearseOfflineHouseholdCopy(args))
})

test('verified legacy central Owner stays disabled in memory and no old sessions are imported',t=>{
 const args=buildVerifiedOfflineFixture(t)
 const source=path.join(args.snapshotRoot,'calendar.db')
 const before=hash(source)
 const r=rehearseOfflineCentralOwner(args)
 assert.equal(r.stagedDisabledOwners,1)
 assert.equal(r.stagedDisabledMemberships,1)
 assert.equal(r.stagedDisabledHouseholds,1)
 assert.equal(r.archivedSessionsNotImported,1)
 assert.equal(r.centralSessions,0)
 assert.equal(r.centralSelections,0)
 assert.equal(r.ownerAccessDenied,true)
 assert.equal(r.credentialFormatAndExactTransferVerified,true)
 assert.equal(r.passwordOwnershipVerified,false)
 assert.equal(r.persistentIdentityCreated,false)
 assert.equal(r.archiveUnchanged,true)
 assert.equal(r.memoryDatabaseClosed,true)
 assert.equal(hash(source),before)
 assert(!JSON.stringify(r).includes('syntheticowner'))
 assert(!JSON.stringify(r).includes('scrypt-v1'))
})

test('converted synthetic primary household becomes a coordinated restorable set without active sessions',t=>{
 const f=buildFixture(t),original=hash(f.file)
 const receipt=stageDisposablePhase1PrimaryFamily({serverDirectory:f.serverDirectory,sourceRoot:f.src,destinationRoot:f.out,prepareEventIdentityAndNotices:true})
 assert.equal(receipt.eventIdentityAndNoticePreparation.uidOnlyIntentsQueued,0)
 assert.equal(receipt.eventIdentityAndNoticePreparation.pendingMutationQueueDrained,true)
 const temp=fs.realpathSync(os.tmpdir())
 const work=fs.mkdtempSync(path.join(temp,'fc-phase1-converted-recovery-'))
 t.after(()=>fs.rmSync(work,{recursive:true,force:true}))
 const centralPath=path.join(f.out,'central','identity.db')
 const familyPath=path.join(f.out,'households','primary-family','data','calendar.db')
 const central=new DatabaseSync(centralPath)
 try{
  createEventShareTables(central)
  createEventShareSyncJournal(central)
  assert.equal(central.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n,0)
  assert.equal(central.prepare('SELECT disabled FROM family_users').get().disabled,1)
 }finally{central.close()}
 const db=new DatabaseSync(familyPath)
 let uid
 try{
  const source=new DatabaseSync(f.file,{readOnly:true})
  let originalEvent
  try{originalEvent=source.prepare('SELECT * FROM events WHERE id=46').get()}finally{source.close()}
  const {event_uid,...remaining}=db.prepare('SELECT * FROM events WHERE id=46').get()
  uid=event_uid
  assert.match(uid,/^[a-f0-9]{32}$/)
  assert.deepEqual(remaining,{...originalEvent})
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assignment_notification_outbox').get().n,31)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM test_assignment_acknowledgements').get().n,14)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_dirty_events').get().n,0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_dirty_event_fields').get().n,0)
 }finally{db.close()}
 const args={serverDirectory:f.serverDirectory,sourceRoot:f.out}
 const first=captureDisposableCoordinatedHouseholdSnapshot({...args,destinationRoot:path.join(work,'baseline')})
 assert.equal(first.householdCount,1)
 assert.equal(first.sourceWritersVerifiedStopped,false)
 const restored=path.join(work,'restored')
 copyVerifiedPrivateRestoreSet({serverDirectory:f.serverDirectory,sourceRoot:first.snapshotRoot,destinationRoot:restored,approvedAttestation:first.attestation})
 assert.equal(verifyOfflinePrivateRestoreSet({serverDirectory:f.serverDirectory,restoreRoot:restored},first.attestation).ok,true)
 const restoredFamily=new DatabaseSync(path.join(restored,'households','primary-family','data','calendar.db'),{readOnly:true})
 try{
  assert.equal(restoredFamily.prepare('SELECT event_uid FROM events WHERE id=46').get().event_uid,uid)
  assert.equal(restoredFamily.prepare('SELECT COUNT(*) AS n FROM assignment_notification_outbox').get().n,31)
  assert.equal(restoredFamily.prepare('SELECT COUNT(*) AS n FROM test_assignment_acknowledgements').get().n,14)
 }finally{restoredFamily.close()}
 const restoredCentral=new DatabaseSync(path.join(restored,'central','identity.db'),{readOnly:true})
 try{
  assert.equal(restoredCentral.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n,0)
  assert.equal(restoredCentral.prepare('SELECT disabled FROM family_users').get().disabled,1)
 }finally{restoredCentral.close()}
 const laterDb=new DatabaseSync(familyPath)
 try{laterDb.prepare('INSERT INTO lists(name) VALUES(?)').run('Synthetic new list after backup')}finally{laterDb.close()}
 const second=captureDisposableCoordinatedHouseholdSnapshot({...args,destinationRoot:path.join(work,'after-write')})
 const review=reviewDisposablePhase1PostWriteRollback({serverDirectory:f.serverDirectory,baselineSnapshotRoot:first.snapshotRoot,baselineAttestation:first.attestation,laterSnapshotRoot:second.snapshotRoot,laterAttestation:second.attestation})
 assert.equal(review.changedCategories.database,1)
 assert.equal(review.possibleNewerDataLoss,true)
 assert.equal(review.automaticRollbackAllowed,false)
 assert.equal(review.restoreAuthorized,false)
 assert.equal(hash(f.file),original)
})



// Reconcile legacy pending mutations before UID backfill: UID updates advance
// the dirty revision even when the material hash is unchanged. Doing this in
// the opposite order can invalidate a previously exact actor attribution.
for (const scenario of ['clean','pending change','attributed self change']) {
 test('UID-only reconciliation preserves historical notices: '+scenario,t=>{
  const f=buildFixture(t),original=hash(f.file)
  stageDisposablePhase1PrimaryFamily({serverDirectory:f.serverDirectory,sourceRoot:f.src,destinationRoot:f.out})
  const db=new DatabaseSync(path.join(f.out,'households','primary-family','data','calendar.db'))
  try {
   const outbox=()=>db.prepare('SELECT * FROM assignment_notification_outbox ORDER BY id').all()
   const acknowledgements=()=>db.prepare('SELECT * FROM test_assignment_acknowledgements ORDER BY notification_id').all()
   const baselines=()=>db.prepare('SELECT * FROM notification_event_baselines ORDER BY event_id').all()
   const prior=outbox(),acks=acknowledgements()
   assert.equal(prior.length,31)
   assert.equal(acks.length,14)
   assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notification_dirty_events').get().n,0)
   if(scenario!=='clean'){
    db.prepare('UPDATE events SET title=? WHERE id=46').run('Synthetic genuine pending edit')
    if(scenario==='attributed self change'){
     const {revision}=db.prepare('SELECT revision FROM notification_dirty_events WHERE event_id=46').get()
     db.prepare('INSERT INTO notification_dirty_event_attribution(event_id,person_id,revision) VALUES(?,?,?)').run(46,7,revision)
    }
   }
   const expected=Number(scenario==='pending change')
   assert.deepEqual(reconcileNotificationMutations(db,{at:1000}),{
    processed:Number(scenario!=='clean'),queued:expected,remaining:0
   })
   const reconciled=outbox(),baseline=baselines()
   assert.deepEqual(reconciled.slice(0,31),prior)
   assert.deepEqual(acknowledgements(),acks)
   assert.equal(reconciled.length,31+expected)
   if(expected){
    const notice=reconciled[31]
    assert.equal(notice.event_id,46)
    assert.equal(notice.person_id,7)
    assert.equal(notice.kind,'changed')
    assert.equal(notice.change_mask,1)
    assert.equal(notice.delivered_at,null)
   }
   installPrivateEventIdentity(db)
   const {event_uid}=db.prepare('SELECT event_uid FROM events WHERE id=46').get()
   assert.match(event_uid,/^[a-f0-9]{32}$/)
   assert.equal(db.prepare('SELECT change_mask FROM notification_dirty_event_fields WHERE event_id=46').get().change_mask,0)
   assert.deepEqual(reconcileNotificationMutations(db,{at:2000}),{processed:1,queued:0,remaining:0})
   assert.deepEqual(outbox(),reconciled)
   assert.deepEqual(acknowledgements(),acks)
   assert.deepEqual(baselines(),baseline)
   assert.deepEqual(reconcileNotificationMutations(db,{at:3000}),{processed:0,queued:0,remaining:0})
   for(const table of ['notification_dirty_events','notification_dirty_event_fields','notification_dirty_event_attribution','notification_deleted_event_details']){
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0)
   }
   assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
   assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
  }finally{db.close()}
  assert.equal(hash(f.file),original)
 })
}


for(const scenario of ['clean','pending edit','self edit','missing baseline','unlinked transient']){
 test('guarded disposable conversion prepares notices: '+scenario,t=>{
  const f=buildFixture(t)
  const src=new DatabaseSync(f.file)
  let prior,acks
  try{
   if(scenario==='pending edit'||scenario==='self edit'){
    src.prepare('UPDATE events SET title=? WHERE id=46').run('Synthetic pending edit before conversion')
    if(scenario==='self edit'){
     const {revision}=src.prepare('SELECT revision FROM notification_dirty_events WHERE event_id=46').get()
     src.prepare('INSERT INTO notification_dirty_event_attribution(event_id,person_id,revision) VALUES(?,?,?)').run(46,7,revision)
    }
   }else if(scenario==='missing baseline'){
    src.exec('DELETE FROM notification_event_baselines WHERE event_id=46')
   }else if(scenario==='unlinked transient'){
    src.exec('INSERT INTO notification_dirty_event_fields(event_id,change_mask) VALUES(46,1)')
   }
   prior=src.prepare('SELECT * FROM assignment_notification_outbox ORDER BY id').all()
   acks=src.prepare('SELECT * FROM test_assignment_acknowledgements ORDER BY notification_id').all()
  }finally{src.close()}
  const before=hash(f.file)
  const args={serverDirectory:f.serverDirectory,sourceRoot:f.src,destinationRoot:f.out,prepareEventIdentityAndNotices:true}
  if(scenario==='missing baseline'||scenario==='unlinked transient'){
   assert.throws(()=>stageDisposablePhase1PrimaryFamily(args),/UID-only backfill changed|unlinked notification transient/)
   assert.equal(fs.existsSync(f.out),false)
  }else{
   const r=stageDisposablePhase1PrimaryFamily(args)
   const expected=Number(scenario==='pending edit')
   assert.equal(r.eventIdentityAndNoticePreparation.legitimateLegacyIntentsQueued,expected)
   assert.equal(r.eventIdentityAndNoticePreparation.legacyDirtyEventsProcessed,Number(scenario!=='clean'))
   assert.equal(r.eventIdentityAndNoticePreparation.uidDirtyEventsProcessed,1)
   assert.equal(r.eventIdentityAndNoticePreparation.uidOnlyIntentsQueued,0)
   assert.equal(r.eventIdentityAndNoticePreparation.pushTransmitted,false)
   assert.equal(r.actualTestMigrationExecuted,false)
   assert.equal(r.testDeploymentAuthorized,false)
   const db=new DatabaseSync(path.join(f.out,'households','primary-family','data','calendar.db'),{readOnly:true})
   try{
    const notices=db.prepare('SELECT * FROM assignment_notification_outbox ORDER BY id').all()
    assert.equal(notices.length,prior.length+expected)
    assert.deepEqual(notices.slice(0,prior.length),prior)
    assert.deepEqual(db.prepare('SELECT * FROM test_assignment_acknowledgements ORDER BY notification_id').all(),acks)
    assert.match(db.prepare('SELECT event_uid FROM events WHERE id=46').get().event_uid,/^[a-f0-9]{32}$/)
    if(expected)assert.equal(notices.at(-1).change_mask,1)
    for(const table of ['notification_dirty_events','notification_dirty_event_fields','notification_dirty_event_attribution','notification_deleted_event_details']){
     assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n,0)
    }
   }finally{db.close()}
  }
  assert.equal(hash(f.file),before)
 })
}


test('offline Owner password proof verifies transferred credential without activation or session',async t=>{
 const args=buildVerifiedOfflineFixture(t)
 const source=path.join(args.snapshotRoot,'calendar.db'),before=hash(source)
 const password='Synthetic Full Shape Example 123!'
 const r=await verifyOfflineCentralOwnerPassword(args,password)
 assert.equal(r.passwordOwnershipVerified,true)
 assert.equal(r.historicalCredentialOnly,true)
 assert.equal(r.currentTestCredentialVerified,false)
 assert.equal(r.ownerAccessDenied,true)
 assert.equal(r.loginSessionCreated,false)
 assert.equal(r.centralSessions,0)
 assert.equal(r.centralSelections,0)
 assert.equal(r.stagedDisabledOwners,1)
 assert.equal(r.stagedDisabledMemberships,1)
 assert.equal(r.stagedDisabledHouseholds,1)
 assert.equal(r.persistentIdentityCreated,false)
 assert.equal(r.accountActivationAuthorized,false)
 assert.equal(r.testDeploymentAuthorized,false)
 assert.equal(r.liveDeploymentAuthorized,false)
 assert.equal(r.memoryDatabaseClosed,true)
 for(const privateValue of [password,'syntheticowner','scrypt-v1']){
  assert(!JSON.stringify(r).includes(privateValue))
 }
 for(const wrong of ['wrong synthetic password','',null,'x'.repeat(201)]){
  await assert.rejects(()=>verifyOfflineCentralOwnerPassword(args,wrong),/Offline Owner password proof refused/)
 }
 assert.equal(hash(source),before)
 fs.appendFileSync(path.join(args.snapshotRoot,'uploads','people','avatar.bin'),'tampered')
 await assert.rejects(()=>verifyOfflineCentralOwnerPassword(args,password))
})


function hiddenProofTerminal({tty=true}={}){
 const input=new EventEmitter()
 input.isTTY=tty
 input.isRaw=false
 input.setRawMode=value=>{input.isRaw=value}
 input.resume=()=>{}
 input.pause=()=>{}
 const writes=[]
 const output={isTTY:tty,write:value=>writes.push(value)}
 return {input,output,writes}
}

test('local Owner prompt hides input, handles editing and restores normal terminal mode',async()=>{
 const {input,output,writes}=hiddenProofTerminal()
 const result=readHiddenOwnerPassword(input,output,{timeoutMs:1000})
 assert.equal(input.isRaw,true)
 input.emit('data',Buffer.from('syntheticx'))
 input.emit('data',Buffer.from([127]))
 const unicode=Buffer.from('é')
 input.emit('data',unicode.subarray(0,1))
 input.emit('data',unicode.subarray(1))
 input.emit('data',Buffer.from('\r'))
 assert.equal(await result,'syntheticé')
 assert.equal(input.isRaw,false)
 assert.equal(input.listenerCount('data'),0)
 assert(!writes.join('').includes('synthetic'))
 assert(!writes.join('').includes('é'))
})

test('local Owner prompt fails closed for redirected input, controls, excessive length and timeout',async()=>{
 const redirected=hiddenProofTerminal({tty:false})
 await assert.rejects(()=>readHiddenOwnerPassword(redirected.input,redirected.output))
 assert.equal(redirected.input.isRaw,false)
 for(const value of ['\x03','\x1b[A','x'.repeat(201),'\r','secret\rmore']){
  const {input,output,writes}=hiddenProofTerminal()
  const result=readHiddenOwnerPassword(input,output,{timeoutMs:1000})
  input.emit('data',Buffer.from(value))
  await assert.rejects(()=>result)
  assert.equal(input.isRaw,false)
  assert.equal(input.listenerCount('data'),0)
  assert(!writes.join('').includes('secret'))
 }
 const timed=hiddenProofTerminal()
 await assert.rejects(()=>readHiddenOwnerPassword(timed.input,timed.output,{timeoutMs:5}))
 assert.equal(timed.input.isRaw,false)
})


test('verified legacy archive becomes coordinated restorable inactive primary family in temporary storage',t=>{
 const args=buildVerifiedOfflineFixture(t)
 const source=path.join(args.snapshotRoot,'calendar.db')
 const manifest=path.join(args.snapshotRoot,'OFFLINE-LEGACY-REVIEW.json')
 const before=hash(source),manifestBefore=hash(manifest)
 const r=rehearseOfflineCoordinatedPrimaryFamily(args)
 assert.equal(r.coordinatedArchiveCopyVerified,true)
 assert.equal(r.restoredHouseholds,1)
 assert.equal(r.permanentEventIdentities,1)
 assert.equal(r.oldSessionsNotImported,1)
 assert.equal(r.centralSessions,0)
 assert.equal(r.centralSelections,0)
 assert.equal(r.restoredOwnerDisabled,true)
 assert.equal(r.ownerAccessDenied,true)
 assert.equal(r.notices,31)
 assert.equal(r.acknowledgements,14)
 assert.equal(r.notificationPreparation.uidOnlyIntentsQueued,0)
 assert.equal(r.notificationPreparation.historyAndAcknowledgementsPreserved,true)
 assert.equal(r.temporaryCopyRemoved,true)
 assert.equal(r.archiveUnchanged,true)
 assert.equal(r.persistentIdentityCreated,false)
 assert.equal(r.installedCalendarsAccessed,false)
 assert.equal(r.actualTestMigrationExecuted,false)
 assert.equal(r.testDeploymentAuthorized,false)
 assert.equal(r.liveDeploymentAuthorized,false)
 assert.equal(hash(source),before)
 assert.equal(hash(manifest),manifestBefore)
 assert(!JSON.stringify(r).includes('scrypt-v1'))
 assert(!JSON.stringify(r).includes('syntheticowner'))
})

test('coordinated archived conversion refuses tampered input and preserves archive bytes',t=>{
 const args=buildVerifiedOfflineFixture(t)
 const source=path.join(args.snapshotRoot,'calendar.db')
 const before=hash(source)
 fs.appendFileSync(path.join(args.snapshotRoot,'uploads','people','avatar.bin'),'tampered')
 assert.throws(()=>rehearseOfflineCoordinatedPrimaryFamily(args))
 assert.equal(hash(source),before)
})


test('password-proven archive startup plan activates only a temporary identity copy',async t=>{
 const args=buildVerifiedOfflineFixture(t)
 const source=path.join(args.snapshotRoot,'calendar.db')
 const manifest=path.join(args.snapshotRoot,'OFFLINE-LEGACY-REVIEW.json')
 const before=hash(source),manifestBefore=hash(manifest)
 await assert.rejects(()=>rehearseOfflineCoordinatedPrimaryStartupPlan(args,'wrong synthetic password'))
 const r=await rehearseOfflineCoordinatedPrimaryStartupPlan(args,'Synthetic Full Shape Example 123!')
 assert.deepEqual(r.startupPlanRehearsal,{
  archivedOwnerPasswordVerified:true,inactiveStartupDenied:true,
  disposableOwnerActivationRehearsed:true,separateTemporaryOperator:true,
  plannedHouseholds:1,centralSessions:0,centralSelections:0,
  originalRestoredOwnerStillDisabled:true,backendBooted:false,
  persistentAccountActivated:false,testDeploymentAuthorized:false})
 assert.equal(r.temporaryCopyRemoved,true)
 assert.equal(r.archiveUnchanged,true)
 assert.equal(r.backendBooted,false)
 assert.equal(r.testDeploymentAuthorized,false)
 assert.equal(hash(source),before)
 assert.equal(hash(manifest),manifestBefore)
 assert(!JSON.stringify(r).includes('syntheticowner'))
 assert(!JSON.stringify(r).includes('scrypt-v1'))
 assert(!JSON.stringify(r).includes('Synthetic Full Shape Example'))
})


// CI only: start from the source-shaped synthetic legacy fixture, NOT an
// installed calendar or an actual recovery archive. No fixed port or routing.
test('converted source-shaped legacy household boots through the reviewed Phase 1 supervisor', {timeout:120000},async t=>{
 const f=buildFixture(t),sourceBefore=hash(f.file)
 const stage=stageDisposablePhase1PrimaryFamily({serverDirectory:f.serverDirectory,sourceRoot:f.src,destinationRoot:f.out,prepareEventIdentityAndNotices:true})
 assert.equal(stage.eventIdentityAndNoticePreparation.uidOnlyIntentsQueued,0)
 const central=new DatabaseSync(path.join(f.out,'central','identity.db'))
 try{
  createEventShareTables(central)
  createEventShareSyncJournal(central)
 }finally{central.close()}
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fc-phase1-converted-boot-fixture-'))
 t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:6,retryDelay:150}))
 const serverDirectory=fileURLToPath(new URL('../Server/',import.meta.url))
 const baseline=captureDisposableCoordinatedHouseholdSnapshot({serverDirectory,sourceRoot:f.out,destinationRoot:path.join(root,'snapshot')})
 const storageRoot=path.join(root,'restored')
 copyVerifiedPrivateRestoreSet({serverDirectory,sourceRoot:baseline.snapshotRoot,destinationRoot:storageRoot,approvedAttestation:baseline.attestation})
 assert.equal(verifyOfflinePrivateRestoreSet({serverDirectory,restoreRoot:storageRoot},baseline.attestation).ok,true)
 const identityDatabasePath=path.join(root,'startup-identity.db')
 fs.copyFileSync(path.join(storageRoot,'central','identity.db'),identityDatabasePath,fs.constants.COPYFILE_EXCL)
 const stateDirectory=path.join(root,'state')
 fs.mkdirSync(stateDirectory)
 const password='Synthetic Full Shape Example 123!'
 const operatorPassword=randomBytes(32).toString('hex')
 let operatorId
 const db=new DatabaseSync(identityDatabasePath)
 try{
  db.exec('PRAGMA foreign_keys=ON')
  createIndependentHouseholdInvitationTables(db)
  createPrivateActivationRecords(db)
  const owner=db.prepare('SELECT * FROM family_users').get()
  assert.equal(owner.disabled,1)
  assert.equal(await verifyFamilyPassword(password,owner.password_hash),true)
  db.exec('BEGIN IMMEDIATE')
  try{
   operatorId=Number(db.prepare("INSERT INTO family_users(username,display_name,password_hash,account_kind,disabled) VALUES(?,?,?,'person',0)").run('bootoperator','Disposable Operator',hashFamilyPassword(operatorPassword)).lastInsertRowid)
   assert.equal(db.prepare('UPDATE family_users SET disabled=0 WHERE id=? AND disabled=1').run(owner.id).changes,1)
   assert.equal(db.prepare("UPDATE household_registry SET disabled=0 WHERE storage_id='primary-family' AND disabled=1").run().changes,1)
   assert.equal(db.prepare("UPDATE household_memberships SET disabled=0 WHERE user_id=? AND role='owner' AND disabled=1").run(owner.id).changes,1)
   assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n,0)
   db.exec('COMMIT')
  }catch(e){db.exec('ROLLBACK');throw e}
 }finally{db.close()}
 const file=path.join(storageRoot,'households','primary-family','data','calendar.db')
 const readFamily=()=>{
  const d=new DatabaseSync(file,{readOnly:true})
  try{
   assert.equal(d.prepare('PRAGMA integrity_check').get().integrity_check,'ok')
   assert.equal(d.prepare('PRAGMA foreign_key_check').all().length,0)
   return {events:d.prepare('SELECT id,event_uid,title FROM events ORDER BY id').all(),
    notices:d.prepare('SELECT * FROM assignment_notification_outbox ORDER BY id').all(),
    acks:d.prepare('SELECT * FROM test_assignment_acknowledgements ORDER BY notification_id').all()}
  }finally{d.close()}
 }
 const before=readFamily()
 const runtime=await launchDisposableReviewedPhase1Gateway({fixtureRoot:root,storageRoot,stateDirectory,identityDatabasePath,serverDirectory,primaryHouseholdId:'primary-family',operatorUserIds:[operatorId]})
 let closed=false
 try{
  const status=runtime.snapshot()
  assert.equal(status.supervisorAdmissionOpen,true)
  assert.equal(status.householdCount,1)
  assert.equal(status.gatewayLocalhostOnly,true)
  const request=async(route,{cookie,body}={})=>{
   const r=await fetch(runtime.base+route,{method:body?'POST':'GET',redirect:'manual',signal:AbortSignal.timeout(7000),headers:{
    ...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json',Origin:'https://'+new URL(runtime.base).host}:{}),
   },...(body?{body:JSON.stringify(body)}:{})})
   const payload=r.headers.get('content-type')?.includes('application/json')?await r.json():await r.text()
   return {r,payload}
  }
  assert.equal((await request('/api/events')).r.status,401)
  const direct=await fetch('http://127.0.0.1:'+status.childPorts[0]+'/api/events',{signal:AbortSignal.timeout(5000)})
  assert.equal(direct.status,403)
  await direct.body?.cancel()
  async function login(username,password){
   const {r}=await request('/api/auth/login',{body:{username,password,deviceLabel:'Disposable conversion boot'}})
   assert.equal(r.status,200)
   const cookie=r.headers.get('set-cookie')
   assert.match(cookie,/__Host-fc_gateway_session=/)
   return cookie.split(';')[0]
  }
  const cookie=await login('syntheticowner',password)
  const operatorCookie=await login('bootoperator',operatorPassword)
  for(const [route,name] of [['/api/events','Synthetic event'],['/api/people','Synthetic Person'],['/api/lists','Synthetic groceries']]){
   const {r,payload}=await request(route,{cookie})
   assert.equal(r.status,200)
   assert(JSON.stringify(payload).includes(name))
   assert.equal((await request(route,{cookie:operatorCookie})).r.status,404)
  }
  assert.equal((await request('/api/admin/household-overview',{cookie})).r.status,404)
  assert.equal((await request('/api/admin/household-overview',{cookie:operatorCookie})).r.status,200)
  assert.equal((await request('/api/recipes',{cookie})).r.status,404)
  assert.equal((await runtime.shutdown()).allChildrenExited,true)
  closed=true
 }finally{if(!closed){try{await runtime.shutdown()}catch{/* retain hold for fixture review */}}}
 assert.deepEqual(readFamily(),before)
 assert.equal(hash(f.file),sourceBefore)
 assert.equal(verifyOfflinePrivateRestoreSet({serverDirectory,restoreRoot:baseline.snapshotRoot},baseline.attestation).ok,true)
})


test('verified synthetic cold archive boots through password-gated offline rehearsal and cleans up', {timeout:120000},async t=>{
 const args=buildVerifiedOfflineFixture(t)
 const source=path.join(args.snapshotRoot,'calendar.db')
 const manifest=path.join(args.snapshotRoot,'OFFLINE-LEGACY-REVIEW.json')
 const before=hash(source),manifestBefore=hash(manifest)
 await assert.rejects(()=>rehearseOfflineCoordinatedPrimaryBoot(args,'incorrect password'))
 const r=await rehearseOfflineCoordinatedPrimaryBoot(args,'Synthetic Full Shape Example 123!')
 for(const flag of ['backendBooted','gatewayBooted','ownerLoginVerified','operatorIsolationVerified','anonymousAccessDenied','directAccessDenied','eventAndNoticeRecordsUnchanged','uploadedFilesUnchanged','allChildrenExited','temporaryCopyRemoved','archiveUnchanged'])assert.equal(r[flag],true,flag)
 for(const flag of ['persistentAccountActivated','testDeploymentAuthorized','liveDeploymentAuthorized','installedCalendarsAccessed','actualTestMigrationExecuted'])assert.equal(r[flag],false,flag)
 assert.equal(r.existingEventCount,1)
 assert.equal(r.existingPeopleCount,1)
 assert.equal(r.existingListCount,1)
 assert.equal(hash(source),before)
 assert.equal(hash(manifest),manifestBefore)
 assert(!JSON.stringify(r).includes('syntheticowner'))
 assert(!JSON.stringify(r).includes('scrypt-v1'))
 assert(!JSON.stringify(r).includes('Synthetic Full Shape Example'))
})


test('inactive migration bundle is exclusive, disabled, independently verifiable and never boot-authorized',t=>{
 const args=buildVerifiedOfflineFixture(t)
 const destinationParent=path.dirname(args.recoveryParent)
 const destination=path.join(destinationParent,'family-calendar-phase1-test-data')
 const options={destinationParent,candidateSha:'a'.repeat(40),scope:'disposable-test-fixture'}
 const archiveFile=path.join(args.snapshotRoot,'calendar.db'),before=hash(archiveFile)
 assert.throws(()=>prepareInactivePhase1TestMigrationStage(args,{...options,candidateSha:'wrong'}))
 assert.equal(fs.existsSync(destination),false)
 const r=prepareInactivePhase1TestMigrationStage(args,options)
 for(const flag of ['inactiveMigrationBundleCreated','stageOwnerDisabled','persistentIdentityCreated','archiveUnchanged','temporaryCopyRemoved'])assert.equal(r[flag],true,flag)
 for(const flag of ['stageStartupAuthorized','persistentAccountActivated','hostWriterFenceVerified','testDeploymentAuthorized','liveDeploymentAuthorized','actualTestMigrationExecuted','backendBooted'])assert.equal(r[flag],false,flag)
 const read=name=>JSON.parse(fs.readFileSync(path.join(destination,name),'utf8'))
 assert.equal(read('DO-NOT-START.json').automaticStartupAllowed,false)
 const review=read('INACTIVE-STAGE-REVIEW.json')
 const attestation=read('COORDINATED-BACKUP-ATTESTATION.json')
 assert.equal(review.candidateSha,options.candidateSha)
 assert.equal(review.sourceArchiveName,path.basename(args.snapshotRoot))
 assert.equal(review.sourceDatabaseSha256,before)
 assert.equal(review.coordinatedAttestationSha256,attestation.sha256)
 const serverDirectory=fileURLToPath(new URL('../Server/',import.meta.url))
 assert.equal(verifyOfflinePrivateRestoreSet({serverDirectory,restoreRoot:path.join(destination,'data')},attestation).ok,true)
 const db=new DatabaseSync(path.join(destination,'data','central','identity.db'),{readOnly:true})
 try{
  assert.equal(db.prepare('SELECT disabled FROM family_users').get().disabled,1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n,0)
 }finally{db.close()}
 const reviewHash=hash(path.join(destination,'INACTIVE-STAGE-REVIEW.json'))
 assert.throws(()=>prepareInactivePhase1TestMigrationStage(args,options))
 assert.equal(hash(path.join(destination,'INACTIVE-STAGE-REVIEW.json')),reviewHash)
 assert.equal(hash(archiveFile),before)
 assert(!JSON.stringify(r).includes('scrypt-v1'))
 assert(!JSON.stringify(r).includes('syntheticowner'))
})
test('inactive stage refuses altered archive and a foreign target',t=>{
 const args=buildVerifiedOfflineFixture(t)
 const destinationParent=path.dirname(args.recoveryParent)
 const options={destinationParent,candidateSha:'b'.repeat(40),scope:'disposable-test-fixture'}
 assert.throws(()=>prepareInactivePhase1TestMigrationStage(args,{...options,destinationParent:args.recoveryParent}))
 fs.appendFileSync(path.join(args.snapshotRoot,'uploads','people','avatar.bin'),'changed')
 assert.throws(()=>prepareInactivePhase1TestMigrationStage(args,options))
 assert.equal(fs.existsSync(path.join(destinationParent,'family-calendar-phase1-test-data')),false)
})


test('inactive startup preflight binds candidate, archive, credential and durable hold without activation',async t=>{
 const {reviewInactivePhase1TestStage}=await import('../Server/private-phase1-inactive-stage-startup-preflight.mjs')
 const args=buildVerifiedOfflineFixture(t)
 const destinationParent=path.dirname(args.recoveryParent)
 const root=path.join(destinationParent,'family-calendar-phase1-test-data')
 const candidateSha='a'.repeat(40)
 const scope='disposable-test-fixture'
 prepareInactivePhase1TestMigrationStage(args,{destinationParent,candidateSha,scope})
 const options={serverDirectory:fileURLToPath(new URL('../Server/',import.meta.url)),destinationParent,scope,
  expectedCandidateSha:candidateSha,expectedInstalledTestSha:args.expectedInstalledTestSha,
  expectedArchiveName:path.basename(args.snapshotRoot),expectedManifestSha256:hash(path.join(args.snapshotRoot,'OFFLINE-LEGACY-REVIEW.json'))}
 const hold=path.join(root,'DO-NOT-START.json')
 const original=fs.readFileSync(hold)
 const r=reviewInactivePhase1TestStage(options)
 assert.equal(r.result,'PASS')
 for(const flag of ['archiveAndStageVerified','ownerCredentialContinuityVerified','ownerDisabled','durableStartupHoldPresent'])assert.equal(r[flag],true,flag)
 for(const flag of ['windowsAclVerified','hostWriterFenceVerified','stageFreshnessComparedToInstalledTest','accountActivationAuthorized','stageStartupAuthorized','testDeploymentAuthorized','liveDeploymentAuthorized','filesOrServicesModified'])assert.equal(r[flag],false,flag)
 assert.equal(r.oldSessionsImported,0)
 assert.throws(()=>reviewInactivePhase1TestStage({...options,expectedCandidateSha:'b'.repeat(40)}))
 assert.throws(()=>reviewInactivePhase1TestStage({...options,expectedManifestSha256:'c'.repeat(64)}))
 const changed=JSON.parse(original)
 changed.automaticStartupAllowed=true
 fs.writeFileSync(hold,JSON.stringify(changed))
 assert.throws(()=>reviewInactivePhase1TestStage(options))
 fs.writeFileSync(hold,original)
 const dbPath=path.join(root,'data','central','identity.db')
 const db=new DatabaseSync(dbPath)
 try{db.exec('UPDATE family_users SET disabled=0')}finally{db.close()}
 assert.throws(()=>reviewInactivePhase1TestStage(options))
 assert.deepEqual(fs.readFileSync(hold),original)
 assert(!JSON.stringify(r).includes('scrypt-v1'))
 assert(!JSON.stringify(r).includes('syntheticowner'))
})


test('native Windows stage DACL is protected before data copy and refuses a foreign reader', {skip:process.platform!=='win32',timeout:90000},t=>{
 const dir=path.join(fs.realpathSync(os.tmpdir()),'fc-phase1-acl-fixture-'+randomBytes(16).toString('hex'))
 const ps=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
 const script=fileURLToPath(new URL('./private-phase1-windows-stage-acl.ps1',import.meta.url))
 const invoke=mode=>spawnSync(ps,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Scope','disposable-acl-fixture','-Mode',mode,'-Directory',dir],{encoding:'utf8',windowsHide:true,timeout:20000})
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:6,retryDelay:150}))
 let r=invoke('Create')
 assert.equal(r.status,0,r.stderr)
 assert.match(r.stdout,/PRIVATE_DACL=YES/)
 assert.deepEqual(fs.readdirSync(dir),[])
 assert.notEqual(invoke('Create').status,0)
 fs.mkdirSync(path.join(dir,'data'))
 const file=path.join(dir,'data','synthetic.txt')
 fs.writeFileSync(file,'fixture')
 r=invoke('Verify')
 assert.equal(r.status,0,r.stderr)
 const grant=spawnSync('icacls.exe',[file,'/grant','*S-1-1-0:(R)'],{encoding:'utf8',windowsHide:true,timeout:10000})
 assert.equal(grant.status,0,grant.stderr)
 assert.notEqual(invoke('Verify').status,0)
 assert.equal(fs.readFileSync(file,'utf8'),'fixture')
})
