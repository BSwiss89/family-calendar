// Synthetic-only Windows CI regression for the TEST deployment log reader.
// Never inspect the owner's real logfile, scheduled tasks, SQLite, Funnel,
// checkouts, or running LIVE/TEST services.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const helper = path.join(root, 'scripts/read-secure-test-success-receipt.ps1')
const report = path.join(root, 'scripts/report-secure-test-deployment.ps1')
const quote = value => "'" + value.replaceAll("'", "''") + "'"

function parseLog(t, lines) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fc-receipt-fixture-'))
  t.after(() => fs.rmSync(work, { recursive: true, force: true }))
  const log = path.join(work, 'synthetic-test-auto-deploy.log')
  fs.writeFileSync(log, lines.join('\r\n') + '\r\n', 'utf8')
  const script = ". " + quote(helper) + "; $r = Read-SecureTestLastSuccessReceipt -LogFile " +
    quote(log) + "; $r | ConvertTo-Json -Compress"
  const p = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', script,
  ], { encoding: 'utf8', timeout: 15000 })
  assert.equal(p.status, 0, p.stderr)
  assert(!p.stderr.includes('synthetic-test-auto-deploy.log'))
  return JSON.parse(p.stdout.trim())
}

test('report must use historical receipt reader, not a small transcript tail', () => {
  const source = fs.readFileSync(report, 'utf8')
  assert.match(source, /\. \$parser/)
  assert.match(source, /Read-SecureTestLastSuccessReceipt -LogFile \$logFile/)
  assert.doesNotMatch(source, /Get-Content.*-Tail\s+6000/)
  const reader = fs.readFileSync(helper, 'utf8')
  assert.match(reader, /System\.IO\.File\]::ReadLines/)
  assert.doesNotMatch(reader, /Start-ScheduledTask|Stop-ScheduledTask|Set-Item|Remove-Item|sqlite3|node:sqlite/i)
})

test('older successful TEST receipt survives 7000 later polling checks', {
  skip: process.platform !== 'win32',
}, t => {
  const sha = '7'.repeat(40)
  const backup = 'C:\\ProgramData\\FamilyCalendar\\SecureTestAutoDeploy\\backups\\old-sha'
  const lines = [
    'TEST AUTO DEPLOY CHECK 2026-11-20T19:46:00.0000000-06:00',
    'TEST AUTO DEPLOY SUCCESS ' + sha + '. Backup: ' + backup,
    ...Array.from({ length: 7001 }, (_, i) =>
      'TEST AUTO DEPLOY CHECK 2026-11-22T16:12:35.0000000-06:00 ' + i),
    'TEST already at approved SHA 7777777.',
  ]
  const receipt = parseLog(t, lines)
  assert.equal(receipt.LastSuccessSha, sha)
  assert.equal(receipt.LastSuccessAt, '2026-11-20T19:46:00.0000000-06:00')
  assert.equal(receipt.LastBackup, backup)
})

test('most recent complete success wins; malformed records never become receipts', {
  skip: process.platform !== 'win32',
}, t => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40)
  const receipt = parseLog(t, [
    'TEST AUTO DEPLOY CHECK 2026-11-20T11:00:00-06:00',
    'TEST AUTO DEPLOY SUCCESS ' + a + '. Backup: C:\\safe\\older',
    'TEST AUTO DEPLOY CHECK 2026-11-20T12:00:00-06:00',
    'TEST AUTO DEPLOY SUCCESS short. Backup: C:\\unsafe',
    'TEST AUTO DEPLOY SUCCESS ' + b.toUpperCase() + '. Backup: C:\\safe\\newest',
  ])
  assert.equal(receipt.LastSuccessSha, b)
  assert.equal(receipt.LastSuccessAt, '2026-11-20T12:00:00-06:00')
  assert.equal(receipt.LastBackup, 'C:\\safe\\newest')
})

test('no successful deployment remains UNKNOWN (never manufacture receipt)', {
  skip: process.platform !== 'win32',
}, t => {
  const receipt = parseLog(t, [
    'TEST AUTO DEPLOY CHECK 2026-11-22T16:12:35-06:00',
    'TEST already at approved SHA 76caa3e.',
  ])
  assert.deepEqual(receipt, {
    LastSuccessSha: 'UNKNOWN',
    LastSuccessAt: 'UNKNOWN',
    LastBackup: 'UNKNOWN',
  })
})
