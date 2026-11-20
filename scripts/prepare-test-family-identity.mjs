#!/usr/bin/env node
// OFFLINE operator tool, not an HTTP endpoint. This never updates TEST/LIVE.
// Default mode is READ ONLY. --execute-new creates ONE new, separate,
// explicitly approved permissions SQLite; no overwrite or in-place migration.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  inspectExistingTestFamilyPlan, provisionFreshTestFamilyIdentity,
} from '../Server/test-family-offline-provisioning.mjs'

function fail(message) { throw new Error(message) }
function parseArgs(argv) {
  const values = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (key === '--execute-new') {
      if (values.execute) fail('Duplicate execute flag.')
      values.execute = true
      continue
    }
    if (!['--test-db', '--plan', '--identity-out', '--approve-fingerprint']
      .includes(key) || Object.hasOwn(values, key) || !argv[i + 1] ||
      argv[i + 1].startsWith('--')) {
      fail('Use --test-db, --plan, --identity-out and optionally --execute-new --approve-fingerprint.')
    }
    values[key] = argv[++i]
  }
  for (const required of ['--test-db', '--plan', '--identity-out']) {
    if (typeof values[required] !== 'string' ||
        !path.isAbsolute(values[required])) {
      fail('All input and output paths must be absolute.')
    }
  }
  if (values.execute && !/^[a-f0-9]{64}$/.test(values['--approve-fingerprint'] ?? '')) {
    fail('Executing requires the exact SHA-256 approval fingerprint from the read-only preflight.')
  }
  if (!values.execute && values['--approve-fingerprint']) {
    fail('Approval fingerprint is for explicit creation only.')
  }
  return values
}

function within(pathToCheck, directory) {
  const relative = path.relative(directory, pathToCheck)
  return relative === '' || (!relative.startsWith('..' + path.sep) &&
    relative !== '..' && !path.isAbsolute(relative))
}

export function localPlanFingerprint(testDb, planText) {
  const users = testDb.prepare([
    'SELECT id, username, display_name, disabled, account_kind',
    'FROM family_users ORDER BY id',
  ].join(' ')).all()
  const people = testDb.prepare('SELECT id FROM people ORDER BY id').all()
  // Hash the exact PLAN and the entire existing account/profile inventory.
  // Do not print personal names, People IDs, password hashes or session data.
  return createHash('sha256').update(
    JSON.stringify({ users, people, planText })
  ).digest('hex')
}

export function runOfflineTestFamilyPlan(argv) {
  const flags = parseArgs(argv)
  const repoRoot = fs.realpathSync(path.resolve(path.dirname(
    fileURLToPath(import.meta.url)), '..'))
  const inputPath = fs.realpathSync(flags['--test-db'])
  const planPath = fs.realpathSync(flags['--plan'])
  const outputPath = path.resolve(flags['--identity-out'])
  const parent = fs.realpathSync(path.dirname(outputPath))
  const resolvedOutput = path.join(parent, path.basename(outputPath))
  if (within(resolvedOutput.toLowerCase(), repoRoot.toLowerCase()) ||
      within(planPath.toLowerCase(), repoRoot.toLowerCase()) ||
      inputPath.toLowerCase() === resolvedOutput.toLowerCase() ||
      planPath.toLowerCase() === resolvedOutput.toLowerCase() ||
      !/\.(sqlite|sqlite3|db)$/i.test(resolvedOutput)) {
    fail('Use separate external identity and private plan paths; never the app checkout or source file.')
  }
  if (fs.existsSync(resolvedOutput)) {
    fail('The identity target already exists. This tool will not overwrite it.')
  }
  const planText = fs.readFileSync(planPath, 'utf8')
  if (Buffer.byteLength(planText) > 64 * 1024) fail('Identity plan is too large.')
  let plan
  try { plan = JSON.parse(planText) }
  catch { fail('Plan must be valid private JSON; no credentials are allowed.') }
  const source = new DatabaseSync(inputPath, { readOnly: true })
  let tempPath = null
  try {
    const normalized = inspectExistingTestFamilyPlan(source, plan)
    const approval = localPlanFingerprint(source, planText)
    const summary = {
      mode: flags.execute ? 'new-permissions-file' : 'read-only-preflight',
      accounts: normalized.accountCount,
      owners: 1,
      adultMembers: normalized.people.filter(u =>
        u.membershipRole === 'member' && u.memberType === 'adult').length,
      childMembers: normalized.people.filter(u =>
        u.membershipRole === 'member' && u.memberType === 'child').length,
      linkedPeople: normalized.linkedPeopleCount,
      fingerprint: approval,
    }
    if (!flags.execute) return summary
    if (approval !== flags['--approve-fingerprint']) {
      fail('Source accounts, People or plan changed since preflight. Review again.')
    }
    if (fs.existsSync(resolvedOutput)) {
      fail('A permissions file appeared after preflight; refusing overwrite.')
    }
    tempPath = path.join(parent, '.' + path.basename(resolvedOutput) +
      '.unpublished-' + randomUUID() + '.sqlite')
    // Creating a random temporary SQLite in an external private folder does
    // not change the installed calendar or its authentication/session store.
    const candidate = new DatabaseSync(tempPath)
    try {
      const result = provisionFreshTestFamilyIdentity(source, candidate, plan)
      if (result.accounts !== summary.accounts || result.owners !== 1 ||
          result.sessionsCopied !== 0 || result.realPasswordHashesCopied !== 0) {
        fail('Unacceptable new identity verification result.')
      }
      const integrity = candidate.prepare('PRAGMA integrity_check').get()
      if (!integrity || Object.values(integrity)[0] !== 'ok') {
        fail('New identity SQLite failed integrity verification.')
      }
    } finally {
      candidate.close()
    }
    // COPYFILE_EXCL is creation-only, never replacement. In a crash, any
    // incomplete output is held for manual operator investigation, not reused.
    fs.copyFileSync(tempPath, resolvedOutput, fs.constants.COPYFILE_EXCL)
    const readback = new DatabaseSync(resolvedOutput, { readOnly: true })
    try {
      const owners = readback.prepare([
        "SELECT COUNT(*) AS n FROM household_memberships WHERE role='owner' AND disabled=0",
      ].join(' ')).get().n
      const sessionCount = readback.prepare('SELECT COUNT(*) AS n FROM family_sessions').get().n
      const good = readback.prepare('PRAGMA integrity_check').get()
      if (owners !== 1 || sessionCount !== 0 ||
          Object.values(good)[0] !== 'ok') {
        fail('Created identity file did not survive readback verification.')
      }
    } finally {
      readback.close()
    }
    return { ...summary, created: true, noExistingLoginOrCalendarChanged: true }
  } finally {
    source.close()
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
  }
}

// No action when imported by unit tests.
if (process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runOfflineTestFamilyPlan(process.argv.slice(2))
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (error) {
    // Privacy-safe summary: no paths, passwords, usernames or source details.
    process.stderr.write('TEST_IDENTITY_PREFLIGHT=BLOCKED: ' +
      (error instanceof Error ? error.message.replace(/([A-Z]:)?[\\/][^\s]+/g, '[path]') :
        'unknown offline error') + '\n')
    process.exitCode = 1
  }
}
