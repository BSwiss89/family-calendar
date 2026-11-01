// Private multi-household storage foundation. Not yet connected to HTTP routing.
//
// A household is selected by trusted server configuration, never an incoming
// URL, request body, cookie, or user-supplied file path. No automatic household
// creation is permitted during a normal server startup.
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const METADATA_FILE = '.family-calendar-household.json'
const HOUSEHOLD_ID = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

function validateHouseholdId(id) {
  if (typeof id !== 'string' || !HOUSEHOLD_ID.test(id)) {
    throw new Error('Invalid household ID: use 3–40 lowercase letters, digits or dashes.')
  }
  return id
}

function within(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return relative !== '' && relative !== '..'
    && !relative.startsWith('..' + path.sep)
    && !path.isAbsolute(relative)
}

function validateRoot(serverDirectory, storageRoot) {
  if (typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    throw new Error('Household storage root must be an absolute, existing directory.')
  }
  const rootReal = fs.realpathSync(storageRoot)
  if (!fs.statSync(rootReal).isDirectory()) {
    throw new Error('Household storage root is not a directory.')
  }
  const checkoutReal = path.dirname(fs.realpathSync(serverDirectory))
  if (rootReal === checkoutReal || within(checkoutReal, rootReal)
      || within(rootReal, checkoutReal)) {
    throw new Error('Household storage must be outside the application checkout.')
  }
  return rootReal
}

function requireContainedDirectory(parent, filename) {
  const resolved = fs.realpathSync(filename)
  if (!within(parent, resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Household directory is missing or points outside its storage boundary.')
  }
  return resolved
}

function requireContainedFile(parent, filename) {
  const resolved = fs.realpathSync(filename)
  if (!within(parent, resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error('Household data file is missing or points outside its storage boundary.')
  }
  return resolved
}

/**
 * Return legacy paths when no household configuration is provided. Otherwise
 * fail closed unless the requested household was explicitly provisioned.
 * This function makes NO directories and does not create any database.
 */
export function resolveHouseholdStorage({
  serverDirectory,
  storageRoot = null,
  householdId = null,
}) {
  if (storageRoot == null && householdId == null) {
    return {
      mode: 'legacy',
      householdId: null,
      dataFolder: path.join(serverDirectory, 'data'),
      uploadFolder: path.join(serverDirectory, 'uploads'),
      databasePath: path.join(serverDirectory, 'data', 'calendar.db'),
    }
  }

  if (storageRoot == null || householdId == null) {
    throw new Error('Both household storage root and household ID are required.')
  }

  const id = validateHouseholdId(householdId)
  const rootReal = validateRoot(serverDirectory, storageRoot)
  const householdsDir = requireContainedDirectory(rootReal, path.join(rootReal, 'households'))
  const home = requireContainedDirectory(householdsDir, path.join(householdsDir, id))

  const markerPath = requireContainedFile(home, path.join(home, METADATA_FILE))
  let marker
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
  } catch {
    throw new Error('Household metadata is unreadable.')
  }
  if (marker?.schemaVersion !== 1 || marker?.householdId !== id) {
    throw new Error('Household storage marker does not match the requested household.')
  }

  const dataFolder = requireContainedDirectory(home, path.join(home, 'data'))
  const uploadFolder = requireContainedDirectory(home, path.join(home, 'uploads'))
  const databasePath = requireContainedFile(dataFolder, path.join(dataFolder, 'calendar.db'))

  return { mode: 'household', householdId: id, dataFolder, uploadFolder, databasePath }
}

/**
 * Explicit provisioning for a NEW, EMPTY household only. Never clone the live
 * calendar or overwrite an existing household's data. This is an offline
 * building block; it does not create accounts or expose a public route.
 */
export function provisionEmptyHousehold({ serverDirectory, storageRoot, householdId }) {
  const id = validateHouseholdId(householdId)
  const rootReal = validateRoot(serverDirectory, storageRoot)
  const households = path.join(rootReal, 'households')
  fs.mkdirSync(households, { recursive: true })
  const householdsReal = requireContainedDirectory(rootReal, households)
  const home = path.join(householdsReal, id)

  // Non-recursive mkdir is intentional: an existing or partially provisioned
  // household must NEVER be overwritten or silently reused.
  fs.mkdirSync(home, { recursive: false, mode: 0o700 })
  const data = path.join(home, 'data')
  const uploads = path.join(home, 'uploads')
  fs.mkdirSync(data, { mode: 0o700 })
  fs.mkdirSync(uploads, { mode: 0o700 })

  const databasePath = path.join(data, 'calendar.db')
  const db = new DatabaseSync(databasePath)
  try {
    db.exec('PRAGMA foreign_keys = ON')
    // Legacy backend bootstrap currently expects this relationship table.
    // Other schema tables are added by its own normal startup migrations.
    db.exec(
      'CREATE TABLE event_people (' +
      'event_id INTEGER NOT NULL, ' +
      'person_id INTEGER NOT NULL, ' +
      'PRIMARY KEY (event_id, person_id)' +
      ') STRICT'
    )
  } finally {
    db.close()
  }

  // Last step: an incomplete provisioning attempt has no valid marker and
  // can never be mistaken for an initialized household.
  fs.writeFileSync(
    path.join(home, METADATA_FILE),
    JSON.stringify({ schemaVersion: 1, householdId: id }) + '\n',
    { flag: 'wx', mode: 0o600 },
  )

  return resolveHouseholdStorage({ serverDirectory, storageRoot, householdId: id })
}
