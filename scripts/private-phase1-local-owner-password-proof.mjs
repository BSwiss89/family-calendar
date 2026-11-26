// Local interactive archived-Owner proof. No password argument, environment
// variable, piped input, HTTP service, saved proof, or deployment capability.
import {StringDecoder} from 'node:string_decoder'
import {pathToFileURL} from 'node:url'
import {verifyOfflineLegacyTestSnapshot} from '../Server/private-phase1-legacy-snapshot-verification.mjs'
import {verifyOfflineCentralOwnerPassword} from './private-phase1-offline-central-owner-rehearsal.mjs'

const refusal=()=>new Error('Local Owner password input refused')

export function readHiddenOwnerPassword(input,output,{timeoutMs=120000,promptKind='owner'}={}){
 if(!['owner','operator','operator-confirm'].includes(promptKind)||input?.isTTY!==true||output?.isTTY!==true||input.isRaw||
    typeof input.setRawMode!=='function'||!Number.isSafeInteger(timeoutMs)||
    timeoutMs<1||timeoutMs>120000)return Promise.reject(refusal())
 return new Promise((resolve,reject)=>{
  const decoder=new StringDecoder('utf8')
  let password='',timer,done=false,raw=false
  function finish(ok){
   if(done)return
   done=true
   clearTimeout(timer)
   input.removeListener('data',onData)
   input.removeListener('error',onEnd)
   input.removeListener('end',onEnd)
   input.removeListener('close',onEnd)
   try{
    if(raw)input.setRawMode(false)
    input.pause()
    output.write('\n')
   }catch{ok=false}
   if(ok&&password.length>0)resolve(password)
   else reject(refusal())
   password=''
  }
  function onEnd(){finish(false)}
  function onData(chunk){
   // A terminal supplies bytes, never a line read with local echo enabled.
   if(!Buffer.isBuffer(chunk)){finish(false);return}
   const value=decoder.write(chunk)
   for(const ch of value){
    if(ch==='\r'||ch==='\n'){
     // Reject extra input after Enter except its optional LF.
     const suffix=value.slice(value.indexOf(ch)+1)
     finish((suffix===''||suffix==='\n')&&decoder.lastNeed===0)
     return
    }
    if(ch==='\b'||ch==='\x7f'){
     password=Array.from(password).slice(0,-1).join('')
    }else if(/[\u0000-\u001f\u007f-\u009f\ufffd]/u.test(ch)){
     // Ctrl-C, ESC/arrow sequences and other controls fail closed.
     finish(false);return
    }else{
     password+=ch
     if(password.length>200){finish(false);return}
    }
   }
  }
  try{
   input.setRawMode(true);raw=true
   output.write(({owner:'Enter archived TEST Owner password',operator:'Choose separate platform operator password (14+ characters)', 'operator-confirm':'Confirm separate platform operator password'})[promptKind]+' (hidden; Enter submits, Ctrl-C cancels): ')
   input.on('data',onData)
   input.once('error',onEnd)
   input.once('end',onEnd)
   input.once('close',onEnd)
   timer=setTimeout(()=>finish(false),timeoutMs)
   input.resume()
  }catch{finish(false)}
 })
}

async function main(){
 const [recoveryParent,snapshotRoot,expectedInstalledTestSha]=process.argv.slice(2)
 if(process.argv.length!==5||!process.stdin.isTTY||!process.stdout.isTTY)throw refusal()
 const args={recoveryParent,snapshotRoot,expectedInstalledTestSha}
 // Reject wrong archive before prompting. Verify again during password proof.
 verifyOfflineLegacyTestSnapshot(args)
 let password=await readHiddenOwnerPassword(process.stdin,process.stdout)
 try{
  const r=await verifyOfflineCentralOwnerPassword(args,password)
  if(!r.passwordOwnershipVerified||!r.historicalCredentialOnly||
     r.currentTestCredentialVerified||r.loginSessionCreated||
     r.accountActivationAuthorized||r.testDeploymentAuthorized||
     r.liveDeploymentAuthorized||!r.archiveUnchanged||!r.memoryDatabaseClosed)throw refusal()
  console.log('OFFLINE_OWNER_PASSWORD_PROOF=PASS | HISTORICAL_CREDENTIAL_ONLY=YES | CURRENT_TEST_CREDENTIAL_VERIFIED=NO | LOGIN_SESSION_CREATED=NO | ACCOUNT_ACTIVATION_AUTHORIZED=NO | ARCHIVE_UNCHANGED=YES | DEPLOYMENT_AUTHORIZED=NO')
 }finally{password=undefined}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{await main()}catch{
  // Never report raw errors, input, account identifiers or credential hashes.
  console.error('OFFLINE_OWNER_PASSWORD_PROOF=REFUSED | DEPLOYMENT_AUTHORIZED=NO')
  process.exitCode=1
 }
}
