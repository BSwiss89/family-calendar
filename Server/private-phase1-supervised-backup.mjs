// Local supervisor-only offline capture. No task/route changes or restart.
// The caller must hold the exclusive supervisor instance throughout capture.
// Copies are made only into a new child of its own reviewed data/fixture root.
// This is not OS-wide writer exclusion or a disaster-recovery replication job.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import {createHash,randomBytes} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {hasVerifiedInvitedOwner,listApprovedPrivateHouseholds} from './private-household-activation-records.mjs'
import {attestOfflinePrivateRestoreSet,verifyOfflinePrivateRestoreSet} from './private-restore-preflight.mjs'

const refuse=()=>{throw Error('Phase 1 supervised backup refused; manual review required.')}
function need(v){if(!v)refuse()}
function inside(a,b){const r=path.relative(a,b);return r!==''&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r)}
function folder(p){const s=fs.lstatSync(p);need(s.isDirectory()&&!s.isSymbolicLink());return fs.realpathSync(p)}
function regular(p){const s=fs.lstatSync(p);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1);return fs.realpathSync(p)}
function exact(p,n){need(JSON.stringify(fs.readdirSync(p).sort())===JSON.stringify([...n].sort()))}
function hash(p){const fd=fs.openSync(regular(p),'r'),h=createHash('sha256'),b=Buffer.alloc(1024*1024);try{for(;;){const n=fs.readSync(fd,b,0,b.length,null);if(!n)break;h.update(b.subarray(0,n))}}finally{fs.closeSync(fd)}return h.digest('hex')}
function noJournal(p){for(const suffix of ['-wal','-shm','-journal']){try{fs.lstatSync(p+suffix);refuse()}catch(e){if(e.code!=='ENOENT')throw e}}}
function inventory(paths,ids){
 const root=folder(paths.storage),identity=regular(paths.identity)
 need(inside(paths.root,root)&&inside(paths.root,identity))
 noJournal(identity)
 const homes=folder(path.join(root,'households'))
 need(path.dirname(homes)===root)
 exact(homes,ids)
 const items=[['central/identity.db',identity]]
 function uploads(p,rel,depth){
  need(depth<=24)
  for(const e of fs.readdirSync(p,{withFileTypes:true})){
   const name=path.join(p,e.name),key=rel+'/'+e.name
   need(!e.isSymbolicLink()&&/^[a-zA-Z0-9._/-]+$/.test(key)&&inside(p,fs.realpathSync(name)))
   if(e.isDirectory())uploads(folder(name),key,depth+1)
   else items.push([key,regular(name)])
   need(items.length<=50000)
  }
 }
 for(const id of ids){
  need(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(id))
  const home=folder(path.join(homes,id))
  need(path.dirname(home)===homes)
  exact(home,['.family-calendar-household.json','data','uploads'])
  const data=folder(path.join(home,'data')),up=folder(path.join(home,'uploads'))
  need(path.dirname(data)===home&&path.dirname(up)===home)
  exact(data,['calendar.db'])
  const base='households/'+id
  items.push([base+'/.family-calendar-household.json',regular(path.join(home,'.family-calendar-household.json'))])
  const db=regular(path.join(data,'calendar.db'))
  noJournal(db)
  items.push([base+'/data/calendar.db',db])
  uploads(up,base+'/uploads',0)
 }
 return items.sort((a,b)=>a[0].localeCompare(b[0],'en')).map(([name,source])=>({name,source,sha:hash(source)}))
}
export function digestClosedPhase1Source(paths,ids){
 return createHash('sha256').update(JSON.stringify(inventory(paths,[...ids].sort()).map(({name,sha})=>({name,sha})))).digest('hex')
}
async function closed(port){
 need(Number.isSafeInteger(port)&&port>=1024&&port<=65535&&![3001,11434,13001,13002,13003].includes(port))
 await new Promise((resolve,reject)=>{
  const socket=net.connect({host:'127.0.0.1',port});let done=false
  const finish=ok=>{if(done)return;done=true;socket.destroy();ok?resolve():reject(Error('Supervised backup listener closure unverified.'))}
  socket.once('connect',()=>finish(false));socket.once('error',e=>finish(e.code==='ECONNREFUSED'));socket.setTimeout(1200,()=>finish(false))
 })
}
function writeNew(p,v){const fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(v,null,2)+'\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
export async function captureClosedPhase1SupervisorBackup({paths,plan,guard,backends,gatewayPort}){
 need(guard.snapshot().phase==='capturing'&&guard.snapshot().allCapturedChildrenExited&&backends.length===plan.householdCount&&backends.every(x=>x.child.exitCode===0))
 // Re-read the closed central registry: invitations can be redeemed after boot.
 const registryDb=new DatabaseSync(paths.identity,{readOnly:true})
 let ids
 try{
  const rows=registryDb.prepare('SELECT storage_id AS id,disabled FROM household_registry ORDER BY storage_id').all()
  ids=rows.map(r=>r.id)
  const approved=listApprovedPrivateHouseholds(registryDb)
  need(rows.every(r=>r.disabled===0)&&JSON.stringify([plan.primaryHouseholdId,...approved].sort())===JSON.stringify([...plan.householdIds].sort()))
  need(ids.includes(plan.primaryHouseholdId)&&ids.every(id=>id===plan.primaryHouseholdId||hasVerifiedInvitedOwner(registryDb,id)))
 }finally{registryDb.close()}
 const ports=[gatewayPort,...backends.map(x=>x.port)]
 return captureVerifiedClosedPhase1Files({paths,ids,ports,checkExclusive:()=>{
  need(guard.snapshot().phase==='capturing'&&guard.snapshot().allCapturedChildrenExited)
 },supervised:true})
}

// Internal local helper. The caller must establish and repeatedly verify
// exclusive offline ownership; no browser or service endpoint calls this.
export async function captureVerifiedClosedPhase1Files({paths,ids,ports,checkExclusive,supervised=false}){
 need(typeof checkExclusive==='function'&&Array.isArray(ids)&&ids.length>0&&new Set(ids).size===ids.length&&Array.isArray(ports)&&ports.length>0&&new Set(ports).size===ports.length)
 ids=[...ids].sort()
 checkExclusive()
 for(const p of ports)await closed(p)
 const before=inventory(paths,ids)
 const sourceDigest=createHash('sha256').update(JSON.stringify(before.map(({name,sha})=>({name,sha})))).digest('hex')
 const parent=path.join(paths.root,'coordinated-backups')
 try{fs.mkdirSync(parent,{mode:0o700})}catch(e){if(e.code!=='EEXIST')throw e}
 need(path.dirname(folder(parent))===paths.root)
 const name='backup-'+new Date().toISOString().replace(/[^0-9]/g,'').slice(0,14)+'-'+randomBytes(16).toString('hex')
 const bundle=path.join(parent,name)
 fs.mkdirSync(bundle,{mode:0o700})
 const snapshot=path.join(bundle,'snapshot')
 fs.mkdirSync(snapshot,{mode:0o700})
 // A partially published bundle is never a valid backup. Keep it for review.
 writeNew(path.join(bundle,'INCOMPLETE.json'),{kind:'phase1-backup-incomplete-v1'})
 for(const item of before){
  const dest=path.join(snapshot,...item.name.split('/'))
  fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700})
  fs.copyFileSync(item.source,dest,fs.constants.COPYFILE_EXCL)
  need(hash(dest)===item.sha&&hash(item.source)===item.sha)
 }
 for(const id of ids)fs.mkdirSync(path.join(snapshot,'households',id,'uploads'),{recursive:true,mode:0o700})
 const dbFile=path.join(snapshot,'central','identity.db')
 const db=new DatabaseSync(dbFile)
 let sessionsRevoked
 try{
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE')
  try{
   sessionsRevoked=db.prepare('UPDATE family_sessions SET revoked_at=? WHERE revoked_at IS NULL').run(Date.now()).changes
   db.exec('DELETE FROM household_session_selections')
   need(db.prepare('SELECT COUNT(*) AS n FROM family_sessions WHERE revoked_at IS NULL').get().n===0)
   need(db.prepare('PRAGMA foreign_key_check').all().length===0)
   db.exec('COMMIT')
  }catch(e){db.exec('ROLLBACK');throw e}
 }finally{db.close()}
 noJournal(dbFile)
 writeNew(path.join(snapshot,'.family-calendar-restore-review.json'),{kind:'private-household-offline-restore-review',version:1})
 const attestation=attestOfflinePrivateRestoreSet({serverDirectory:paths.server,restoreRoot:snapshot})
 need(verifyOfflinePrivateRestoreSet({serverDirectory:paths.server,restoreRoot:snapshot},attestation).ok)
 need(JSON.stringify(inventory(paths,ids))===JSON.stringify(before))
 for(const p of ports)await closed(p)
 checkExclusive()
 writeNew(path.join(bundle,'ATTESTATION.json'),attestation)
 writeNew(path.join(bundle,'BACKUP-REVIEW.json'),{kind:supervised?'phase1-supervised-coordinated-backup-v1':'phase1-manual-closed-backup-v1',households:ids.length,files:attestation.files.length,attestationSha256:attestation.sha256,sourceDigest,sessionsRevokedInCopy:sessionsRevoked,sourceSessionsUnchanged:true,sourceFilesUnchanged:true,restoreAuthorized:false,automaticRestartAllowed:false})
 fs.unlinkSync(path.join(bundle,'INCOMPLETE.json'))
 return Object.freeze({backupName:name,households:ids.length,files:attestation.files.length,sourceDigest,attestationSha256:attestation.sha256,sessionsRevokedInCopy:sessionsRevoked,sourceSessionsUnchanged:true,sourceFilesUnchanged:true,coordinatedBackupVerified:true,supervisorHeldDuringCapture:supervised,allSystemWritersFenced:false,restoreAuthorized:false,automaticRestartAllowed:false})
}
