// Create or reset a family login without putting passwords in PowerShell history,
// GitHub, source code, or command-line arguments.
// Usage: node scripts/manage-family-account.mjs <calendar.db> <username> <display name>
// Password is read from stdin and must not be echoed by the caller.
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { setFamilyAccount } from '../Server/family-auth.mjs'

const [filename, username, displayName, ...extra] = process.argv.slice(2)
if (!filename || !username || !displayName || extra.length) {
  throw new Error('Usage: node scripts/manage-family-account.mjs <calendar.db> <username> <display-name> (password via stdin)')
}
const databaseFile = path.resolve(filename)
const expectedSuffix = path.join('Server', 'data', 'calendar.db').toLowerCase()
if (!databaseFile.toLowerCase().endsWith(expectedSuffix)) {
  throw new Error('Only an existing Family Calendar data database may be used.')
}
if (!fs.existsSync(databaseFile)) throw new Error('Database missing. Refusing to create a new one.')
const rootName = path.basename(path.dirname(path.dirname(path.dirname(databaseFile))))
if (!['family-calendar-preview', 'family-calendar-test'].includes(rootName) && process.env.FAMILY_AUTH_ALLOW_LIVE !== 'YES') {
  throw new Error('Production account changes are disabled unless explicitly authorized during a later deployment.')
}
let input = ''
for await (const chunk of process.stdin) {
  input += chunk.toString('utf8')
  if (input.length > 2048) throw new Error('Password input is unexpectedly long.')
}
const password = input.replace(/(?:\r?\n)+$/, '')
if (!password) throw new Error('No password was provided on stdin.')
const database = new DatabaseSync(databaseFile)
try {
  database.exec('PRAGMA foreign_keys = ON')
  setFamilyAccount(database, username, displayName, password)
  console.log('Family account created or updated. Any earlier trusted devices for this account were revoked.')
} finally {
  database.close()
}
