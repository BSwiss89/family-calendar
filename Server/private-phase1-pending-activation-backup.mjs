// New-household pre-activation snapshot only. No live household or central
// database is copied or changed here; coordinated backups remain separate.
// Call only from the reviewed runtime, before spawning the target child.
import fs from 'node:fs'
import path from 'node:path'
import {createHash,randomBytes} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {resolveHouseholdStorage} from './household-storage.mjs'
import {hasVerifiedInvitedOwner} from './private-household-activation-records.mjs'
function need(ok){if(!ok)throw Error('Pending household storage or backup verification failed.')}
function physicalDir(p){
 const s=fs.lstatSync(p);need(s.isDirectory()&&!s.isSymbolicLink())
 const real=fs.realpathSync(p);need(real===p);return real
}
function regular(p){
 const s=fs.lstatSync(p);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&fs.realpathSync(p)===p)
}
function exact(p,entries){need(JSON.stringify(fs.readdirSync(p).sort())===JSON.stringify([...entries].sort()))}
function sha(p){regular(p);return createHash('sha256').update(fs.readFileSync(p)).digest('hex')}
function verifyEmpty(p){
 regular(p)
 const db=new DatabaseSync(p,{readOnly:true})
 try{
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  need(tables.length===1&&tables[0].name==='event_people'&&!db.prepare('SELECT 1 FROM event_people LIMIT 1').get())
  const integrity=db.prepare('PRAGMA quick_check').all()
  need(integrity.length===1&&integrity[0].quick_check==='ok'&&db.prepare('PRAGMA foreign_key_check').all().length===0)
 }finally{db.close()}
}
function writeNew(p,value){const fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
export function capturePendingActivationBackup({paths,identityDatabase,householdId}){
 need(/^family-[a-f0-9]{24}$/.test(householdId)&&hasVerifiedInvitedOwner(identityDatabase,householdId))
 need(!identityDatabase.prepare('SELECT 1 FROM private_activated_households a JOIN household_registry h ON h.id=a.household_id WHERE h.storage_id=?').get(householdId))
 const root=physicalDir(paths.root),storage=physicalDir(paths.storage)
 need(path.dirname(storage)===root)
 const home=physicalDir(path.join(physicalDir(path.join(storage,'households')),householdId))
 const resolved=resolveHouseholdStorage({serverDirectory:paths.server,storageRoot:storage,householdId})
 const data=physicalDir(path.join(home,'data')),uploads=physicalDir(path.join(home,'uploads'))
 need(resolved.dataFolder===data&&resolved.uploadFolder===uploads&&resolved.databasePath===path.join(data,'calendar.db'))
 const marker=path.join(home,'.family-calendar-household.json'),db=resolved.databasePath
 function verifySource(){exact(home,['.family-calendar-household.json','data','uploads']);exact(data,['calendar.db']);exact(uploads,[]);verifyEmpty(db);regular(marker)}
 verifySource()
 const hashes=[sha(marker),sha(db)]
 const parent=path.join(root,'pending-activation-backups')
 try{fs.mkdirSync(parent,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}
 physicalDir(parent)
 const bundle=path.join(parent,householdId+'-'+randomBytes(16).toString('hex'))
 fs.mkdirSync(bundle,{mode:0o700})
 writeNew(path.join(bundle,'INCOMPLETE.json'),{kind:'pending-activation-backup-incomplete-v1',householdId})
 fs.mkdirSync(path.join(bundle,'data'),{mode:0o700})
 fs.mkdirSync(path.join(bundle,'uploads'),{mode:0o700})
 const markerCopy=path.join(bundle,'.family-calendar-household.json'),dbCopy=path.join(bundle,'data','calendar.db')
 fs.copyFileSync(marker,markerCopy,fs.constants.COPYFILE_EXCL)
 fs.copyFileSync(db,dbCopy,fs.constants.COPYFILE_EXCL)
 for(const file of [markerCopy,dbCopy]){const fd=fs.openSync(file,'r+');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
 verifyEmpty(dbCopy)
 verifySource()
 need(sha(markerCopy)===hashes[0]&&sha(dbCopy)===hashes[1]&&sha(marker)===hashes[0]&&sha(db)===hashes[1])
 writeNew(path.join(bundle,'BACKUP-REVIEW.json'),{kind:'pending-activation-backup-v1',householdId,markerSha256:hashes[0],databaseSha256:hashes[1],sourceUnchanged:true,verifiedAt:Date.now(),restoreAuthorized:false})
 fs.unlinkSync(path.join(bundle,'INCOMPLETE.json'))
 return Object.freeze({verified:true})
}
