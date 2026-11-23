// This is a short static contract for an operator-run test of a REAL 34-file
// historical snapshot; CI must never launch the user's installed calendar.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const file=fileURLToPath(new URL('./rehearse-private-phase1-existing-test-restored-boot.mjs',import.meta.url))
const source=fs.readFileSync(file,'utf8')
test('real isolated recovery boot tool syntax parses',()=>{
  const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8',timeout:15000})
  assert.equal(r.status,0,r.stderr)
})
test('historical restore boot is fixed, local and cannot modify deployed tasks/routes',()=>{
  for(const text of [
    "const SNAPSHOT='TEST-20261122-163327-c8b184db'",
    "const INSTALLED_SHA='76caa3e46186c3c5c6408f11b55800eb06779776'",
    "FAMILY_CALENDAR_HOST:'127.0.0.1'",
    "FAMILY_CALENDAR_AUTH_MODE:'required'",
    "git(['clone','--quiet','--local','--no-hardlinks','--no-checkout'",
    "readOnly:true",
    "original_backup_unchanged=YES",
    "installed_sites_written=NO",
    "const original=exactFiles(backup)",
    "child=spawn(nodeBinary,",
    "await shutDown(child)",
    "child.kill()",
    "process.argv.length!==2",
  ])assert(source.includes(text),text)
  assert.doesNotMatch(source,/\b(Stop-ScheduledTask|Start-ScheduledTask|Disable-ScheduledTask|Register-ScheduledTask|netsh|schtasks|Start-Service|Stop-Service|Restart-Computer)\b/i)
  assert.doesNotMatch(source,/https?:\/\/(?!127\.0\.0\.1)/i)
})
