import express from 'express'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import multer from 'multer'
import sharp from 'sharp'
import { fileURLToPath } from 'node:url'
import { assertCalendarReleaseBootSafe } from '../scripts/dependency-release-boot-guard.mjs'
import {
  normalizeListCategory,
  ensureListItemCategories,
  suggestListCategory,
  organizeExistingListItems,
} from './list-features.mjs'
import { ensureShoppingStores, getShoppingStores, looksLikeShoppingList, requireStoreId,
  suggestShoppingStoreId, organizeShoppingStores, saveShoppingStoreCorrection,
  sortUnknownStoresWithOllama } from './smart-stores.mjs'

const app = express()
// The live server defaults to 3001 / all interfaces.
// The isolated test server sets its own loopback-only port through environment variables.
const PORT = Number(process.env.FAMILY_CALENDAR_PORT ?? '3001')
const HOST = process.env.FAMILY_CALENDAR_HOST ?? '0.0.0.0'

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('Invalid FAMILY_CALENDAR_PORT')
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// This runs before any SQLite or uploads are opened. A crash/power loss during
// a future approved npm cutover must not boot against mixed package assets.
assertCalendarReleaseBootSafe(path.resolve(__dirname, '..'))

const dataFolder = path.join(__dirname, 'data')
const uploadFolder = path.join(__dirname, 'uploads')
const OLLAMA_URL =
  'http://127.0.0.1:11434/api/chat'

const LOCAL_AI_MODEL =
  'ministral-3:8b'

const CAPTURE_VISION_MODEL = LOCAL_AI_MODEL

const distFolder = path.join(__dirname, '..', 'dist')

fs.mkdirSync(dataFolder, { recursive: true })
fs.mkdirSync(uploadFolder, { recursive: true })

const databasePath = path.join(dataFolder, 'calendar.db')
const database = new DatabaseSync(databasePath)

database.exec(`PRAGMA foreign_keys = ON`)

function getUploadExtension(file) {
  if (file.mimetype === 'image/png') return '.png'
  if (file.mimetype === 'image/webp') return '.webp'
  return '.jpg'
}

function deleteStoredImageFile(filename) {
  if (!filename) return

  const filePath = path.join(uploadFolder, filename)

  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}

async function optimizePersonAvatar(file) {
  if (!file) {
    return null
  }

  const originalPath = path.join(
    uploadFolder,
    file.filename
  )

  const optimizedFilename =
    'avatar-' +
    Date.now() +
    '-' +
    Math.round(
      Math.random() * 1000000000
    ) +
    '.webp'

  const optimizedPath = path.join(
    uploadFolder,
    optimizedFilename
  )

  try {
    await sharp(originalPath)
      .rotate()
      .resize({
        width: 512,
        height: 512,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({
        quality: 82,
      })
      .toFile(optimizedPath)

    deleteStoredImageFile(
      file.filename
    )

    return optimizedFilename
  } catch (error) {
    deleteStoredImageFile(
      optimizedFilename
    )

    throw error
  }
}

const upload = multer({
  storage: multer.diskStorage({
    destination(request, file, callback) {
      callback(null, uploadFolder)
    },
    filename(request, file, callback) {
      const extension = getUploadExtension(file)
      const uniqueName =
        'person-' +
        Date.now() +
        '-' +
        Math.round(Math.random() * 1000000000) +
        extension

      callback(null, uniqueName)
    },
  }),
  limits: {
    fileSize: 5 * 1024 * 1024,
  },
  fileFilter(request, file, callback) {
    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
    ]

    if (!allowedTypes.includes(file.mimetype)) {
      callback(
        new Error('Only JPG, PNG, or WebP images are allowed.')
      )

      return
    }

    callback(null, true)
  },
})

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination(request, file, callback) {
      callback(null, uploadFolder)
    },
    filename(request, file, callback) {
      const extension = getUploadExtension(file)
      const uniqueName =
        'person-' +
        Date.now() +
        '-' +
        Math.round(Math.random() * 1000000000) +
        extension

      callback(null, uniqueName)
    },
  }),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
  fileFilter(request, file, callback) {
    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
    ]

    if (!allowedTypes.includes(file.mimetype)) {
      callback(
        new Error(
          'Only JPG, PNG, or WebP images are allowed.'
        )
      )

      return
    }

    callback(null, true)
  },
})

const captureUpload = multer({
  storage: multer.diskStorage({
    destination(request, file, callback) {
      callback(null, uploadFolder)
    },
    filename(request, file, callback) {
      const extension = getUploadExtension(file)
      const uniqueName =
        'capture-' +
        Date.now() +
        '-' +
        Math.round(Math.random() * 1000000000) +
        extension

      callback(null, uniqueName)
    },
  }),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
  fileFilter(request, file, callback) {
    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
    ]

    if (!allowedTypes.includes(file.mimetype)) {
      callback(
        new Error(
          'Only JPG, PNG, or WebP images are allowed.'
        )
      )

      return
    }

    callback(null, true)
  },
})

const captureAnalyzeUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,
  },
  fileFilter(request, file, callback) {
    const allowedTypes = [
      'image/jpeg',
      'image/png',
      'image/webp',
    ]

    if (!allowedTypes.includes(file.mimetype)) {
      callback(
        new Error(
          'Only JPG, PNG, or WebP images are allowed.'
        )
      )

      return
    }

    callback(null, true)
  },
})

database.exec(`
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  end_date TEXT,
  title TEXT NOT NULL,
  time TEXT,
  end_time TEXT,
  person TEXT,
notes TEXT,
batch_id TEXT,
location TEXT
) STRICT
`)

const eventColumns = database
  .prepare(`PRAGMA table_info(events)`)
  .all()
  .map((column) => column.name)

if (!eventColumns.includes('end_date')) {
  database.exec(`
    ALTER TABLE events
    ADD COLUMN end_date TEXT
  `)
}

if (!eventColumns.includes('end_time')) {
  database.exec(`
    ALTER TABLE events
    ADD COLUMN end_time TEXT
  `)
}

if (!eventColumns.includes('person')) {
  database.exec(`ALTER TABLE events ADD COLUMN person TEXT`)
}

if (!eventColumns.includes('notes')) {
  database.exec(`ALTER TABLE events ADD COLUMN notes TEXT`)
}

if (!eventColumns.includes('repeat_unit')) {
  database.exec(`ALTER TABLE events ADD COLUMN repeat_unit TEXT`)
}

if (!eventColumns.includes('repeat_interval')) {
  database.exec(`
    ALTER TABLE events
    ADD COLUMN repeat_interval INTEGER
  `)
}

if (!eventColumns.includes('repeat_end_type')) {
  database.exec(`
    ALTER TABLE events
    ADD COLUMN repeat_end_type TEXT
  `)
}

if (!eventColumns.includes('repeat_end_date')) {
  database.exec(`
    ALTER TABLE events
    ADD COLUMN repeat_end_date TEXT
  `)
}

if (!eventColumns.includes('repeat_count')) {
  database.exec(`
    ALTER TABLE events
    ADD COLUMN repeat_count INTEGER
  `)
}

if (!eventColumns.includes('batch_id')) {
  database.exec(`
    ALTER TABLE events
    ADD COLUMN batch_id TEXT
  `)
}

if (!eventColumns.includes('location')) {
  database.exec(`
    ALTER TABLE events
    ADD COLUMN location TEXT
  `)
}

database.exec(`
  CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL,
    image TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
  ) STRICT
`)

const peopleColumns = database
  .prepare(`PRAGMA table_info(people)`)
  .all()
  .map((column) => column.name)

if (!peopleColumns.includes('image')) {
  database.exec(`ALTER TABLE people ADD COLUMN image TEXT`)
}

if (!peopleColumns.includes('sort_order')) {
  database.exec(`
    ALTER TABLE people
    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0
  `)

  const existingPeople = database
    .prepare(`
      SELECT id
      FROM people
      ORDER BY id
    `)
    .all()

  const updatePersonSortOrder = database.prepare(`
    UPDATE people
    SET sort_order = ?
    WHERE id = ?
  `)

  existingPeople.forEach((person, index) => {
    updatePersonSortOrder.run(index, person.id)
  })
}

database.exec(`
  CREATE TABLE IF NOT EXISTS event_exceptions (
    event_id INTEGER NOT NULL,
    occurrence_date TEXT NOT NULL,
    PRIMARY KEY (event_id, occurrence_date),
    FOREIGN KEY (event_id)
      REFERENCES events(id)
      ON DELETE CASCADE
  ) STRICT
`)

database.exec(`
  CREATE TABLE IF NOT EXISTS lists (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT
`)

database.exec(`
  CREATE TABLE IF NOT EXISTS list_items (
    id INTEGER PRIMARY KEY,
    list_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (list_id)
      REFERENCES lists(id)
      ON DELETE CASCADE
  ) STRICT
`)
const listItemColumns = database
  .prepare(`PRAGMA table_info(list_items)`)
  .all()
  .map((column) => column.name)

if (!listItemColumns.includes('sort_order')) {
  database.exec(`
    ALTER TABLE list_items
    ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0
  `)

  database.exec(`
    UPDATE list_items
    SET sort_order = id
  `)
}
ensureListItemCategories(database)
ensureShoppingStores(database)

database.exec(`
  CREATE TABLE IF NOT EXISTS meal_plans (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL UNIQUE,
    dinner TEXT NOT NULL,
    notes TEXT
  ) STRICT
`)

database.exec(`
  CREATE TABLE IF NOT EXISTS daily_notes (
    date TEXT PRIMARY KEY,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT
`)

database.exec(`
  CREATE TABLE IF NOT EXISTS recipes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    image TEXT,
    servings INTEGER,
    prep_time TEXT,
    cook_time TEXT,
    ingredients TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL DEFAULT '',
    notes TEXT,
    tags TEXT,
    favorite INTEGER NOT NULL DEFAULT 0,
    source_url TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT
`)

const recipeColumns = database
  .prepare(`
    PRAGMA table_info(recipes)
  `)
  .all()

const recipesHaveSourceImage =
  recipeColumns.some(
    (column) =>
      column.name === 'source_image'
  )

if (!recipesHaveSourceImage) {
  database.exec(`
    ALTER TABLE recipes
    ADD COLUMN source_image TEXT
  `)
}

database.exec(`
  CREATE TABLE IF NOT EXISTS meal_plan_items (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    meal_type TEXT NOT NULL,
    recipe_id INTEGER,
    title TEXT NOT NULL,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (recipe_id)
      REFERENCES recipes(id)
      ON DELETE SET NULL,
    UNIQUE (date, meal_type)
  ) STRICT
`)

database.exec(`
  CREATE TABLE IF NOT EXISTS capture_inbox (
    id INTEGER PRIMARY KEY,
    image TEXT NOT NULL,
    original_name TEXT,
    mime_type TEXT,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT
`)

const captureInboxColumns = database
  .prepare(`
    PRAGMA table_info(capture_inbox)
  `)
  .all()

const captureInboxHasType =
  captureInboxColumns.some(
    (column) =>
      column.name === 'capture_type'
  )

const captureInboxHasAnalysisStatus =
  captureInboxColumns.some(
    (column) =>
      column.name === 'analysis_status'
  )

const captureInboxHasAnalysisJson =
  captureInboxColumns.some(
    (column) =>
      column.name === 'analysis_json'
  )

if (!captureInboxHasType) {
  database.exec(`
    ALTER TABLE capture_inbox
    ADD COLUMN capture_type TEXT
  `)
}

if (!captureInboxHasAnalysisStatus) {
  database.exec(`
    ALTER TABLE capture_inbox
    ADD COLUMN analysis_status TEXT
    NOT NULL DEFAULT 'pending'
  `)
}

if (!captureInboxHasAnalysisJson) {
  database.exec(`
    ALTER TABLE capture_inbox
    ADD COLUMN analysis_json TEXT
  `)
}

database.exec(`
  INSERT OR IGNORE INTO meal_plan_items (
    date,
    meal_type,
    recipe_id,
    title,
    notes
  )
  SELECT
    date,
    'dinner',
    NULL,
    dinner,
    notes
  FROM meal_plans
`)

database.exec(`
  INSERT OR IGNORE INTO event_people (event_id, person_id)
  SELECT events.id, people.id
  FROM events
  JOIN people ON people.name = events.person
  WHERE events.person IS NOT NULL
`)

app.use(express.json())

function isValidDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date)
}

function isValidTitle(title) {
  return (
    typeof title === 'string' &&
    title.trim().length > 0 &&
    title.trim().length <= 200
  )
}

function isValidPersonName(name) {
  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.trim().length <= 50
  )
}

function isValidColor(color) {
  return /^#[0-9A-Fa-f]{6}$/.test(color)
}
function cleanOptionalText(value, maxLength) {
  if (typeof value !== 'string') {
    return null
  }

  const cleaned = value.trim()

  if (cleaned.length === 0) {
    return null
  }

  return cleaned.slice(0, maxLength)
}

function getRepeatRule(body, eventDate) {
  const repeatUnit = body.repeatUnit

  if (
    repeatUnit === undefined ||
    repeatUnit === null ||
    repeatUnit === '' ||
    repeatUnit === 'none'
  ) {
    return {
      repeatUnit: null,
      repeatInterval: null,
      repeatEndType: null,
      repeatEndDate: null,
      repeatCount: null,
    }
  }

  const allowedUnits = [
    'day',
    'week',
    'month',
    'year',
  ]

  if (!allowedUnits.includes(repeatUnit)) {
    return null
  }

  const repeatInterval = Number(body.repeatInterval)

  if (
    !Number.isInteger(repeatInterval) ||
    repeatInterval < 1 ||
    repeatInterval > 365
  ) {
    return null
  }

  const repeatEndType =
    body.repeatEndType ?? 'never'

  if (
    ![
      'never',
      'date',
      'count',
    ].includes(repeatEndType)
  ) {
    return null
  }

  let repeatEndDate = null
  let repeatCount = null

  if (repeatEndType === 'date') {
    if (
      !isValidDate(body.repeatEndDate) ||
      body.repeatEndDate < eventDate
    ) {
      return null
    }

    repeatEndDate = body.repeatEndDate
  }

  if (repeatEndType === 'count') {
    const count = Number(body.repeatCount)

    if (
      !Number.isInteger(count) ||
      count < 1 ||
      count > 1000
    ) {
      return null
    }

    repeatCount = count
  }

  return {
    repeatUnit,
    repeatInterval,
    repeatEndType,
    repeatEndDate,
    repeatCount,
  }
}

function normalizePersonIds(personIds) {
  if (!Array.isArray(personIds)) {
    return []
  }

  return [
    ...new Set(
      personIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ]
}

function getPeopleForEvent(eventId) {
  return database
    .prepare(`
      SELECT people.id, people.name, people.color, people.image
      FROM people
      JOIN event_people
        ON event_people.person_id = people.id
      WHERE event_people.event_id = ?
      ORDER BY people.sort_order, people.id
    `)
    .all(eventId)
}


function getExceptionsForEvent(eventId) {
  return database
    .prepare(`
      SELECT occurrence_date AS occurrenceDate
      FROM event_exceptions
      WHERE event_id = ?
      ORDER BY occurrence_date
    `)
    .all(eventId)
    .map((exception) => exception.occurrenceDate)
}

function doesEventStartOnDate(
  calendarEvent,
  targetDate
) {
  if (
    calendarEvent.exceptions?.includes(
      targetDate
    )
  ) {
    return false
  }

  if (!calendarEvent.repeatUnit) {
    return calendarEvent.date === targetDate
  }

  if (targetDate < calendarEvent.date) {
    return false
  }

  if (
    calendarEvent.repeatEndType === 'date' &&
    calendarEvent.repeatEndDate &&
    targetDate > calendarEvent.repeatEndDate
  ) {
    return false
  }

  const interval =
    calendarEvent.repeatInterval ?? 1

  const [startYear, startMonth, startDay] =
    calendarEvent.date.split('-').map(Number)

  const [targetYear, targetMonth, targetDay] =
    targetDate.split('-').map(Number)

  const startUtc = Date.UTC(
    startYear,
    startMonth - 1,
    startDay
  )

  const targetUtc = Date.UTC(
    targetYear,
    targetMonth - 1,
    targetDay
  )

  const millisecondsPerDay =
    24 * 60 * 60 * 1000

  const differenceInDays =
    (targetUtc - startUtc) /
    millisecondsPerDay

  let occurrenceNumber = null

  if (calendarEvent.repeatUnit === 'day') {
    if (
      differenceInDays % interval !== 0
    ) {
      return false
    }

    occurrenceNumber =
      differenceInDays / interval + 1
  }

  if (calendarEvent.repeatUnit === 'week') {
    const daysPerOccurrence =
      interval * 7

    if (
      differenceInDays %
        daysPerOccurrence !==
      0
    ) {
      return false
    }

    occurrenceNumber =
      differenceInDays /
        daysPerOccurrence +
      1
  }

  if (calendarEvent.repeatUnit === 'month') {
    if (targetDay !== startDay) {
      return false
    }

    const differenceInMonths =
      (targetYear - startYear) * 12 +
      (targetMonth - startMonth)

    if (
      differenceInMonths < 0 ||
      differenceInMonths % interval !== 0
    ) {
      return false
    }

    occurrenceNumber =
      differenceInMonths / interval + 1
  }

  if (calendarEvent.repeatUnit === 'year') {
    if (
      targetMonth !== startMonth ||
      targetDay !== startDay
    ) {
      return false
    }

    const differenceInYears =
      targetYear - startYear

    if (
      differenceInYears < 0 ||
      differenceInYears % interval !== 0
    ) {
      return false
    }

    occurrenceNumber =
      differenceInYears / interval + 1
  }

  if (occurrenceNumber === null) {
    return false
  }

  if (
    calendarEvent.repeatEndType === 'count' &&
    calendarEvent.repeatCount !== null &&
    occurrenceNumber >
      calendarEvent.repeatCount
  ) {
    return false
  }

  return true
}

function findCancellationMatches({
  title,
  date,
  startTime,
  person,
}) {
  const candidates = database
    .prepare(`
      SELECT
        id,
        date,
        title,
        time,
        end_time AS endTime,
        person,
        repeat_unit AS repeatUnit,
        repeat_interval AS repeatInterval,
        repeat_end_type AS repeatEndType,
        repeat_end_date AS repeatEndDate,
        repeat_count AS repeatCount
      FROM events
                 WHERE date <= ?
        AND (
          REPLACE(
            REPLACE(LOWER(TRIM(title)), ' ', ''),
            '-',
            ''
          ) = REPLACE(
            REPLACE(LOWER(TRIM(?)), ' ', ''),
            '-',
            ''
          )
          OR INSTR(
            LOWER(TRIM(title)),
            LOWER(TRIM(?)) || ' '
          ) = 1
                    OR INSTR(
            LOWER(TRIM(title)),
            LOWER(TRIM(?)) || '-'
          ) = 1
          OR INSTR(
            ' ' || LOWER(TRIM(title)) || ' ',
            ' ' || LOWER(TRIM(?)) || ' '
          ) > 0
        )
        AND (
          ? IS NULL
          OR time = ?
        )
      ORDER BY date, time, id
    `)
            .all(
      date,
      title,
      title,
      title,
      title,
      startTime,
      startTime
    )
    .map((event) => ({
      ...event,
      people:
        getPeopleForEvent(event.id),
      exceptions:
        getExceptionsForEvent(event.id),
    }))

  const matches = candidates
    .filter((event) =>
      doesEventStartOnDate(
        event,
        date
      )
    )
        .filter((event) => {
      if (
        typeof person !== 'string' ||
        person.trim() === ''
      ) {
        return true
      }

      const assignedPeople =
        event.people.map(
          (assignedPerson) =>
            assignedPerson.name
              .trim()
              .toLowerCase()
        )

      const requestedPerson =
        person.toLowerCase()

      if (
        assignedPeople.includes(
          requestedPerson
        )
      ) {
        return true
      }

      return (
        assignedPeople.length === 0 &&
        typeof event.person === 'string' &&
        event.person
          .trim()
          .toLowerCase() ===
          requestedPerson
      )
    })

    const exactMatches = matches.filter(
    (event) =>
      event.title.trim().toLowerCase() ===
      title.trim().toLowerCase()
  )

  const preferredMatches =
    exactMatches.length > 0
      ? exactMatches
      : matches

  return preferredMatches.map((event) => ({
    ...event,
    matchType:
      event.repeatUnit
        ? 'recurring_occurrence'
        : 'event',
    occurrenceDate:
      event.repeatUnit
        ? date
        : null,
  }))
}

async function parseCancellationCriteria({
  text,
  currentDate,
  currentUser,
}) {
  const schema = {
    type: 'object',
    properties: {
      title: {
        type: ['string', 'null'],
      },
      date: {
        type: ['string', 'null'],
      },
      startTime: {
        type: ['string', 'null'],
      },
      person: {
        type: ['string', 'null'],
      },
    },
    required: [
      'title',
      'date',
      'startTime',
      'person',
    ],
    additionalProperties: false,
  }

  const prompt = `
You are a calendar cancellation request parser.

Today is ${currentDate}.
Current user is ${currentUser}.

User request:
${text}

Extract only the identifying details stated by the user or directly resolved from relative dates and times.

Rules:
- Do not search calendar events.
- Do not choose an event ID.
- Do not decide whether the request is ambiguous.
- Resolve a date only when the user explicitly states a date or relative date such as today, tomorrow, or a named weekday.
- If the user does not state any date, date must be null.
- Never assume the current date just because no date was provided.
- Dates that are provided or directly resolved must be YYYY-MM-DD.
- Convert times to HH:MM in 24-hour time.
- title must contain only the event name explicitly stated by the user.
- For example, "Cancel my 5 PM gym tomorrow" means title must be "gym".
- When a person's name is used to identify whose event it is, do not include that person's possessive name in the title.
- Example: "Cancel Haylee's overlap on October 9 at 7 AM" means title is "overlap" and person is "Haylee".
- Example: "Cancel Robert's dentist appointment tomorrow" means title is "dentist appointment" and person is "Robert".
- If the person's name is actually part of the event name, such as "Haylee's Birthday", preserve it in the title.
- Only return null for title when the user did not state any event name or identifying title.
- person must be the explicitly named person when the user names someone.
- Use currentUser for person only when the request explicitly refers to "my", "mine", or "for me".
- If no person is named and the user does not explicitly claim ownership, person MUST be null.
- Never assume an event belongs to currentUser just because currentUser was provided.
- Example: "Cancel my dentist appointment tomorrow" means person is currentUser.
- Example: "Cancel Haylee's dentist appointment tomorrow" means person is "Haylee".
- Example: "Cancel the dentist appointment tomorrow" means person is null.
- Example: "Cancel overlap test on October 9 at 7 AM" means person is null.
- If a detail is not explicitly provided or directly resolvable from something the user said, return null.
- Do not fill missing date or time fields with defaults.
- Do not invent missing information.
`.trim()

  const startedAt = Date.now()

  const ollamaResponse = await fetch(
    OLLAMA_URL,
    {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/json',
      },
      body: JSON.stringify({
        model: LOCAL_AI_MODEL,
        stream: false,
        keep_alive: '24h',
        format: schema,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        options: {
          temperature: 0,
          num_ctx: 4096,
        },
      }),
    }
  )

  if (!ollamaResponse.ok) {
    const errorText =
      await ollamaResponse.text()

    throw new Error(
      `Ollama returned ${ollamaResponse.status}: ${errorText}`
    )
  }

  const ollamaResult =
    await ollamaResponse.json()

  const rawContent =
    ollamaResult.message?.content

  if (typeof rawContent !== 'string') {
    throw new Error(
      'Ollama did not return cancellation criteria.'
    )
  }

    const result =
    JSON.parse(rawContent)

  const rawPerson =
    typeof result.person === 'string'
      ? result.person.trim()
      : ''

  const claimsOwnEvent =
    /\b(my|mine)\b|\bfor me\b/i.test(text)

  const currentUserNamed =
    text.toLowerCase().includes(
      currentUser.toLowerCase()
    )

  let resolvedPerson = null

  if (rawPerson !== '') {
    const isCurrentUserMarker =
      rawPerson.toLowerCase() === 'currentuser'

    if (isCurrentUserMarker) {
      if (claimsOwnEvent || currentUserNamed) {
        resolvedPerson = currentUser
      }
    } else if (
      text.toLowerCase().includes(
        rawPerson.toLowerCase()
      ) ||
      (
        claimsOwnEvent &&
        rawPerson.toLowerCase() ===
          currentUser.toLowerCase()
      )
    ) {
      resolvedPerson = rawPerson
    }
  }

  return {
    title: result.title,
    date: result.date,
    startTime: result.startTime,
       person: resolvedPerson,
    model: LOCAL_AI_MODEL,
    totalMs:
      Date.now() - startedAt,
    ollamaMs: Math.round(
      (ollamaResult.total_duration ?? 0) /
        1000000
    ),
  }
}

async function parseRescheduleCriteria({
  text,
  currentDate,
  currentUser,
}) {
  const schema = {
    type: 'object',
    properties: {
      title: { type: ['string', 'null'] },
      originalDate: { type: ['string', 'null'] },
      originalTime: { type: ['string', 'null'] },
      person: { type: ['string', 'null'] },
      newDate: { type: ['string', 'null'] },
      newTime: { type: ['string', 'null'] },
    },
    required: [
      'title',
      'originalDate',
      'originalTime',
      'person',
      'newDate',
      'newTime',
    ],
    additionalProperties: false,
  }

  const prompt = `
You are a calendar event rescheduling parser.

Today is ${currentDate}.
Current user is ${currentUser}.

User request:
${text}

Extract the identifying details of the EXISTING event and the requested NEW date or time.

Rules:
- Do not search calendar events.
- Do not choose an event ID.
- Do not decide whether an event exists.
- Do not invent missing information.
- Dates must be YYYY-MM-DD.
- Times must be HH:MM in 24-hour format.
- Resolve explicitly stated relative dates using today's date.
- title is the name of the existing event, without a person's possessive name unless it is genuinely part of the event title.
- originalDate is the date identifying the existing event.
- originalTime is the time identifying the existing event.
- newDate is the date the user wants to move the event TO.
- newTime is the time the user wants to move the event TO.
- Do not confuse an original date or time with a new date or time.
- If the user only changes the time, newDate must be null.
- If the user only changes the date, newTime must be null.
- If the original event date is not stated, originalDate must be null.
- If the original event time is not stated, originalTime must be null.
- A missing original time is allowed because an event may be identified without it.
- A missing original date must not be invented.
- person is the explicitly named person when supplied.
- Use currentUser for person only when the user says "my", "mine", or "for me".
- Otherwise person must be null.
- Never assume an event belongs to currentUser.
- A new date or time must be explicitly requested.
- If neither a new date nor a new time is given, both must be null.

Examples:

"Move Haylee's dentist appointment on October 20 to 4 PM"
title: "dentist appointment"
originalDate: "2026-10-20"
originalTime: null
person: "Haylee"
newDate: null
newTime: "16:00"

"Move my dentist appointment from October 20 at 11 AM to October 22 at 3 PM"
title: "dentist appointment"
originalDate: "2026-10-20"
originalTime: "11:00"
person: "currentUser"
newDate: "2026-10-22"
newTime: "15:00"

"Move the dentist appointment to 3 PM"
title: "dentist appointment"
originalDate: null
originalTime: null
person: null
newDate: null
newTime: "15:00"
`.trim()

  const startedAt = Date.now()

  const ollamaResponse = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: LOCAL_AI_MODEL,
      stream: false,
      keep_alive: '24h',
      format: schema,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      options: {
        temperature: 0,
        num_ctx: 4096,
      },
    }),
  })

  if (!ollamaResponse.ok) {
    const errorText = await ollamaResponse.text()

    throw new Error(
      `Ollama returned ${ollamaResponse.status}: ${errorText}`
    )
  }

  const ollamaResult = await ollamaResponse.json()
  const rawContent = ollamaResult.message?.content

  if (typeof rawContent !== 'string') {
    throw new Error(
      'Ollama did not return rescheduling criteria.'
    )
  }

  const result = JSON.parse(rawContent)

  const normalizedDate = (value) => {
    if (typeof value !== 'string') return null

    const cleaned = value.trim()

    return isValidDate(cleaned) ? cleaned : null
  }

  const normalizedTime = (value) => {
    if (typeof value !== 'string') return null

    const cleaned = value.trim()

    return /^([01]\d|2[0-3]):[0-5]\d$/.test(cleaned)
      ? cleaned
      : null
  }

  const rawPerson =
    typeof result.person === 'string'
      ? result.person.trim()
      : ''

  const claimsOwnEvent =
    /\b(my|mine)\b|\bfor me\b/i.test(text)

  const currentUserNamed =
    text.toLowerCase().includes(
      currentUser.toLowerCase()
    )

  let resolvedPerson = null

  if (rawPerson !== '') {
    if (rawPerson.toLowerCase() === 'currentuser') {
      if (claimsOwnEvent || currentUserNamed) {
        resolvedPerson = currentUser
      }
    } else if (
      text.toLowerCase().includes(
        rawPerson.toLowerCase()
      ) ||
      (
        claimsOwnEvent &&
        rawPerson.toLowerCase() ===
          currentUser.toLowerCase()
      )
    ) {
      resolvedPerson = rawPerson
    }
  }

  return {
    title:
      typeof result.title === 'string' &&
      result.title.trim() !== ''
        ? result.title.trim()
        : null,
    originalDate: normalizedDate(result.originalDate),
    originalTime: normalizedTime(result.originalTime),
    person: resolvedPerson,
    newDate: normalizedDate(result.newDate),
    newTime: normalizedTime(result.newTime),
    model: LOCAL_AI_MODEL,
    totalMs: Date.now() - startedAt,
    ollamaMs: Math.round(
      (ollamaResult.total_duration ?? 0) / 1000000
    ),
  }
}

function getRequestedPeople(personIds, legacyPerson) {
  const normalizedIds = normalizePersonIds(personIds)

  if (
    Array.isArray(personIds) &&
    normalizedIds.length !== personIds.length
  ) {
    return null
  }

  if (normalizedIds.length > 0) {
    const selectedPeople = []

    for (const id of normalizedIds) {
      const person = database
        .prepare(`
          SELECT id, name, color, image
          FROM people
          WHERE id = ?
        `)
        .get(id)

      if (!person) {
        return null
      }

      selectedPeople.push(person)
    }

    return selectedPeople
  }

  if (
    typeof legacyPerson === 'string' &&
    legacyPerson.trim() !== ''
  ) {
    const person = database
      .prepare(`
        SELECT id, name, color, image
        FROM people
        WHERE name = ?
      `)
      .get(legacyPerson.trim())

    return person ? [person] : []
  }

  return []
}

// Health route stays functionally identical. This backend-only comment tests the
// automatic release gates for isolated npm staging and dependency rollback.
app.get('/api/health', (request, response) => {
  response.json({
    status: 'ok',
    message: 'Family Calendar server is running',
    uptimeSeconds: Math.floor(process.uptime()),
    serverTime: new Date().toISOString(),
  })
})

app.post('/api/ai/reschedule-preview', async (request, response) => {
  const text =
    typeof request.body?.text === 'string'
      ? request.body.text.trim()
      : ''

  const currentDate =
    typeof request.body?.currentDate === 'string'
      ? request.body.currentDate.trim()
      : ''

  const currentUser =
    typeof request.body?.currentUser === 'string'
      ? request.body.currentUser.trim()
      : ''

  if (
    text.length === 0 ||
    text.length > 1000 ||
    !isValidDate(currentDate) ||
    currentUser.length === 0 ||
    currentUser.length > 100
  ) {
    return response.status(400).json({
      error: 'Valid text, currentDate, and currentUser are required.',
    })
  }

  try {
    const criteria = await parseRescheduleCriteria({
      text,
      currentDate,
      currentUser,
    })

    const baseResult = {
      criteria,
      model: criteria.model,
      totalMs: criteria.totalMs,
      ollamaMs: criteria.ollamaMs,
    }

    if (
      !criteria.title ||
      !isValidDate(criteria.originalDate)
    ) {
      return response.json({
        ...baseResult,
        status: 'needs_clarification',
        reason: 'missing_original_event_details',
        count: 0,
        matches: [],
      })
    }

    if (
      !criteria.newDate &&
      !criteria.newTime
    ) {
      return response.json({
        ...baseResult,
        status: 'needs_clarification',
        reason: 'missing_requested_change',
        count: 0,
        matches: [],
      })
    }

    const matches = findCancellationMatches({
      title: criteria.title,
      date: criteria.originalDate,
      startTime: criteria.originalTime,
      person: criteria.person,
    })

    if (matches.length === 0) {
      return response.json({
        ...baseResult,
        status: 'no_match',
        count: 0,
        matches: [],
      })
    }

    if (matches.length > 1) {
      return response.json({
        ...baseResult,
        status: 'needs_clarification',
        reason: 'multiple_matching_events',
        count: matches.length,
        matches,
      })
    }

    const event = matches[0]

    const storedEvent = database
      .prepare(`
        SELECT
          end_date AS endDate,
          end_time AS endTime,
          repeat_unit AS repeatUnit
        FROM events
        WHERE id = ?
      `)
      .get(event.id)

    if (!storedEvent) {
      return response.json({
        ...baseResult,
        status: 'no_match',
        count: 0,
        matches: [],
      })
    }

    if (
      storedEvent.repeatUnit !== null ||
      storedEvent.endDate !== null ||
      event.matchType !== 'event'
    ) {
      return response.json({
        ...baseResult,
        status: 'unsupported_event',
        reason: 'recurring_or_multiday_event',
        count: 1,
        matches,
      })
    }

    const proposed = {
      date: criteria.newDate ?? event.date,
      time: criteria.newTime ?? event.time,
    }

    if (
      criteria.newTime !== null &&
      criteria.newTime !== event.time &&
      storedEvent.endTime !== null
    ) {
      return response.json({
        ...baseResult,
        status: 'unsupported_event',
        reason: 'event_has_end_time',
        count: 1,
        matches,
      })
    }

    if (
      proposed.date === event.date &&
      proposed.time === event.time
    ) {
      return response.json({
        ...baseResult,
        status: 'no_change',
        count: 1,
        matches,
        proposed,
      })
    }

    return response.json({
      ...baseResult,
      status: 'ready_for_confirmation',
      count: 1,
      matches,
      eventId: event.id,
      original: {
        date: event.date,
        time: event.time,
      },
      proposed,
    })
  } catch (error) {
    console.error('AI RESCHEDULE PREVIEW ERROR:', error)

    response.status(503).json({
      error: 'Local AI rescheduling preview is unavailable.',
    })
  }
})

app.post('/api/ai/reschedule-criteria', async (request, response) => {
  const text =
    typeof request.body?.text === 'string'
      ? request.body.text.trim()
      : ''

  const currentDate =
    typeof request.body?.currentDate === 'string'
      ? request.body.currentDate.trim()
      : ''

  const currentUser =
    typeof request.body?.currentUser === 'string'
      ? request.body.currentUser.trim()
      : ''

  if (
    text.length === 0 ||
    text.length > 1000 ||
    !isValidDate(currentDate) ||
    currentUser.length === 0 ||
    currentUser.length > 100
  ) {
    return response.status(400).json({
      error:
        'Valid text, currentDate, and currentUser are required.',
    })
  }

  try {
    const criteria = await parseRescheduleCriteria({
      text,
      currentDate,
      currentUser,
    })

    response.json(criteria)
  } catch (error) {
    console.error('AI RESCHEDULE CRITERIA ERROR:', error)

    response.status(503).json({
      error:
        'Local AI rescheduling parsing is unavailable.',
    })
  }
})

app.post('/api/ai/intent', async (request, response) => {
  const text =
    typeof request.body?.text === 'string'
      ? request.body.text.trim()
      : ''

  if (text.length === 0 || text.length > 1000) {
    return response.status(400).json({
      error: 'A valid text request is required.',
    })
  }

  const schema = {
    type: 'object',
    properties: {
      intent: {
        type: 'string',
        enum: [
          'create_event',
          'move_event',
          'cancel_event',
          'calendar_query',
          'other',
        ],
      },
    },
    required: ['intent'],
    additionalProperties: false,
  }

  const prompt = `
Classify the user's request into exactly one calendar intent.

Intent definitions:
- create_event: add or schedule a new calendar event
- move_event: change an existing event's date or time
- cancel_event: delete or cancel an existing event
- calendar_query: ask about calendar information without changing it
- other: none of the above

User request:
${text}
`.trim()

  try {
    const startedAt = Date.now()

    const ollamaResponse = await fetch(
      OLLAMA_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: LOCAL_AI_MODEL,
          stream: false,
          keep_alive: '24h',
          format: schema,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          options: {
            temperature: 0,
            num_ctx: 4096,
          },
        }),
      }
    )

    if (!ollamaResponse.ok) {
      const errorText =
        await ollamaResponse.text()

      throw new Error(
        `Ollama returned ${ollamaResponse.status}: ${errorText}`
      )
    }

    const ollamaResult =
      await ollamaResponse.json()

    const rawContent =
      ollamaResult.message?.content

    if (typeof rawContent !== 'string') {
      throw new Error(
        'Ollama did not return intent content.'
      )
    }

    const result = JSON.parse(rawContent)

    return response.json({
      intent: result.intent,
      model: LOCAL_AI_MODEL,
      totalMs: Date.now() - startedAt,
      ollamaMs: Math.round(
        (ollamaResult.total_duration ?? 0) /
          1000000
      ),
    })
  } catch (error) {
    console.error(
      'LOCAL AI INTENT ERROR:',
      error
    )

        return response.status(503).json({
      error:
        'Local AI intent parsing is unavailable.',
    })
  }
})

app.post(
  '/api/ai/cancel-criteria',
  async (request, response) => {
    const text =
      typeof request.body?.text === 'string'
        ? request.body.text.trim()
        : ''

    const currentDate =
      typeof request.body?.currentDate === 'string'
        ? request.body.currentDate.trim()
        : ''

    const currentUser =
      typeof request.body?.currentUser === 'string'
        ? request.body.currentUser.trim()
        : ''

    if (
      text.length === 0 ||
      text.length > 1000 ||
      !isValidDate(currentDate) ||
      currentUser.length === 0 ||
      currentUser.length > 100
    ) {
      return response.status(400).json({
        error:
          'Valid text, currentDate, and currentUser are required.',
      })
    }

        try {
      const result =
        await parseCancellationCriteria({
          text,
          currentDate,
          currentUser,
        })

      return response.json(result)
    } catch (error) {
      console.error(
        'LOCAL AI CANCEL CRITERIA ERROR:',
        error
      )

      return response.status(503).json({
        error:
          'Local AI cancellation parsing is unavailable.',
      })
    }
  }
)

app.post(
  '/api/ai/cancel-preview',
  async (request, response) => {
    const text =
      typeof request.body?.text === 'string'
        ? request.body.text.trim()
        : ''

    const currentDate =
      typeof request.body?.currentDate === 'string'
        ? request.body.currentDate.trim()
        : ''

    const currentUser =
      typeof request.body?.currentUser === 'string'
        ? request.body.currentUser.trim()
        : ''

    if (
      text.length === 0 ||
      text.length > 1000 ||
      !isValidDate(currentDate) ||
      currentUser.length === 0 ||
      currentUser.length > 100
    ) {
      return response.status(400).json({
        error:
          'Valid text, currentDate, and currentUser are required.',
      })
    }

    try {
      const criteria =
        await parseCancellationCriteria({
          text,
          currentDate,
          currentUser,
        })

            if (
        typeof criteria.title !== 'string' ||
        criteria.title.trim().length === 0 ||
        !isValidDate(criteria.date)
      ) {
        return response.json({
          status: 'needs_clarification',
          criteria: {
            title: criteria.title,
            date: criteria.date,
            startTime: criteria.startTime,
            person: criteria.person,
          },
          count: 0,
          matches: [],
          model: criteria.model,
          totalMs: criteria.totalMs,
          ollamaMs: criteria.ollamaMs,
        })
      }

      const startTime =
        typeof criteria.startTime === 'string' &&
        criteria.startTime.trim().length > 0
          ? criteria.startTime.trim()
          : null

            const matches =
        findCancellationMatches({
          title: criteria.title.trim(),
          date: criteria.date,
          startTime,
          person:
            typeof criteria.person === 'string'
              ? criteria.person.trim()
              : null,
        })

      let status = 'no_match'

      if (matches.length === 1) {
        status = 'ready_for_confirmation'
      }

      if (matches.length > 1) {
        status = 'needs_clarification'
      }

      return response.json({
        status,
        criteria: {
          title: criteria.title,
          date: criteria.date,
          startTime,
          person: criteria.person,
        },
        count: matches.length,
        matches,
        model: criteria.model,
        totalMs: criteria.totalMs,
        ollamaMs: criteria.ollamaMs,
      })
    } catch (error) {
      console.error(
        'LOCAL AI CANCEL PREVIEW ERROR:',
        error
      )

      return response.status(503).json({
        error:
          'Local AI cancellation preview is unavailable.',
      })
    }
  }
)

app.post('/api/ai/cancel-matches', (request, response) => {
  const title =
    typeof request.body?.title === 'string'
      ? request.body.title.trim()
      : ''

  const date =
    typeof request.body?.date === 'string'
      ? request.body.date.trim()
      : ''

  const startTime =
    typeof request.body?.startTime === 'string'
      ? request.body.startTime.trim()
      : null

  const person =
    typeof request.body?.person === 'string'
      ? request.body.person.trim()
      : ''

  if (
    title.length === 0 ||
    title.length > 200 ||
    !isValidDate(date) ||
    person.length === 0 ||
    person.length > 50 ||
    (
      startTime !== null &&
      startTime.length > 20
    )
  ) {
    return response.status(400).json({
      error:
        'Valid title, date, and person are required.',
    })
  }

      const resolvedMatches =
    findCancellationMatches({
      title,
      date,
      startTime,
      person,
    })

  response.json({
    count: resolvedMatches.length,
    matches: resolvedMatches,
  })
})

app.post('/api/ai/cancel-confirmed', (request, response) => {
  const eventId =
    Number(request.body?.eventId)

  const matchType =
    request.body?.matchType

  const occurrenceDate =
    typeof request.body?.occurrenceDate === 'string'
      ? request.body.occurrenceDate.trim()
      : null

  const confirmed =
    request.body?.confirm === true

  if (!confirmed) {
    return response.status(400).json({
      error:
        'Cancellation confirmation is required.',
    })
  }

  if (
    !Number.isInteger(eventId) ||
    eventId <= 0 ||
    ![
      'event',
      'recurring_occurrence',
    ].includes(matchType)
  ) {
    return response.status(400).json({
      error:
        'Invalid cancellation request.',
    })
  }

  const calendarEvent = database
    .prepare(`
      SELECT
        id,
        date,
        title,
        time,
        repeat_unit AS repeatUnit,
        repeat_interval AS repeatInterval,
        repeat_end_type AS repeatEndType,
        repeat_end_date AS repeatEndDate,
        repeat_count AS repeatCount
      FROM events
      WHERE id = ?
    `)
    .get(eventId)

  if (!calendarEvent) {
    return response.status(404).json({
      error: 'Event not found.',
    })
  }

  if (matchType === 'recurring_occurrence') {
    if (
      !occurrenceDate ||
      !isValidDate(occurrenceDate) ||
      !calendarEvent.repeatUnit
    ) {
      return response.status(400).json({
        error:
          'A valid recurring occurrence is required.',
      })
    }

    const eventWithExceptions = {
      ...calendarEvent,
      exceptions:
        getExceptionsForEvent(eventId),
    }

    if (
      !doesEventStartOnDate(
        eventWithExceptions,
        occurrenceDate
      )
    ) {
      return response.status(400).json({
        error:
          'That recurring occurrence does not exist.',
      })
    }

    database
      .prepare(`
        INSERT OR IGNORE INTO event_exceptions (
          event_id,
          occurrence_date
        )
        VALUES (?, ?)
      `)
      .run(
        eventId,
        occurrenceDate
      )

    return response.json({
      success: true,
      action: 'cancel_occurrence',
      eventId,
      occurrenceDate,
    })
  }

  if (calendarEvent.repeatUnit) {
    return response.status(400).json({
      error:
        'A recurring series cannot be deleted through a single-event cancellation.',
    })
  }

  const result = database
    .prepare(`
      DELETE FROM events
      WHERE id = ?
    `)
    .run(eventId)

  return response.json({
    success: result.changes === 1,
    action: 'delete_event',
    eventId,
  })
})

app.get('/api/daily-notes/:date', (request, response) => {
  const date = request.params.date

  if (!isValidDate(date)) {
    return response.status(400).json({
      error: 'Invalid date.',
    })
  }

  const dailyNote = database
    .prepare(`
      SELECT
        date,
        note,
        updated_at AS updatedAt
      FROM daily_notes
      WHERE date = ?
    `)
    .get(date)

  if (!dailyNote) {
    return response.json({
      date,
      note: '',
      updatedAt: null,
    })
  }

  response.json(dailyNote)
})

app.put('/api/daily-notes/:date', (request, response) => {
  const date = request.params.date
  const { note } = request.body

  if (
    !isValidDate(date) ||
    typeof note !== 'string' ||
    note.length > 5000
  ) {
    return response.status(400).json({
      error: 'A valid date and note are required.',
    })
  }

  if (note.trim() === '') {
    database
      .prepare(`
        DELETE FROM daily_notes
        WHERE date = ?
      `)
      .run(date)

    return response.json({
      date,
      note: '',
      updatedAt: null,
    })
  }

  database
    .prepare(`
      INSERT INTO daily_notes (
        date,
        note,
        updated_at
      )
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(date)
      DO UPDATE SET
        note = excluded.note,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run(
      date,
      note
    )

  const savedNote = database
    .prepare(`
      SELECT
        date,
        note,
        updated_at AS updatedAt
      FROM daily_notes
      WHERE date = ?
    `)
    .get(date)

  response.json(savedNote)
})

app.get('/api/capture-inbox', (request, response) => {
  const captures = database
    .prepare(`
      SELECT
        id,
        image,
        original_name AS originalName,
        mime_type AS mimeType,
        note,
status,
capture_type AS captureType,
analysis_status AS analysisStatus,
analysis_json AS analysisJson,
created_at AS createdAt,
        updated_at AS updatedAt
      FROM capture_inbox
      ORDER BY created_at DESC, id DESC
    `)
    .all()

  response.json(captures)
})

app.post(
  '/api/capture-inbox',
  captureUpload.single('image'),
async (request, response) => {
    if (!request.file) {
      return response.status(400).json({
        error: 'An image is required.',
      })
    }

const thumbnailName =
  `thumb-${path.parse(request.file.filename).name}.webp`

const thumbnailPath =
  path.join(
    uploadFolder,
    thumbnailName
  )

try {
  await sharp(
    request.file.path
  )
    .resize({
      width: 420,
      height: 420,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({
      quality: 70,
    })
    .toFile(
      thumbnailPath
    )
} catch (error) {
  console.error(
    'Could not create capture thumbnail:',
    error
  )
}

    const rawNote =
      typeof request.body.note === 'string'
        ? request.body.note.trim()
        : ''

    if (rawNote.length > 2000) {
      deleteStoredImageFile(
        request.file.filename
      )

      return response.status(400).json({
        error: 'Note is too long.',
      })
    }

    try {
      const result = database
        .prepare(`
          INSERT INTO capture_inbox (
            image,
            original_name,
            mime_type,
            note
          )
          VALUES (?, ?, ?, ?)
        `)
        .run(
          request.file.filename,
          request.file.originalname,
          request.file.mimetype,
          rawNote === '' ? null : rawNote
        )

      const capture = database
        .prepare(`
          SELECT
            id,
            image,
            original_name AS originalName,
            mime_type AS mimeType,
            note,
status,
capture_type AS captureType,
analysis_status AS analysisStatus,
analysis_json AS analysisJson,
created_at AS createdAt,
            updated_at AS updatedAt
          FROM capture_inbox
          WHERE id = ?
        `)
        .get(
          Number(result.lastInsertRowid)
        )

      response.status(201).json(capture)
    } catch (error) {
      deleteStoredImageFile(
        request.file.filename
      )

      console.error(
        'Could not save capture:',
        error
      )

      response.status(500).json({
        error: 'Could not save capture.',
      })
    }
  }
)

app.patch(
  '/api/capture-inbox/:id/type',
  (request, response) => {
    const id = Number(request.params.id)
    const { captureType } = request.body

    const allowedTypes = [
      'event',
      'recipe',
      'list',
      'other',
    ]

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      return response.status(400).json({
        error: 'Invalid Capture Inbox ID.',
      })
    }

    if (
      typeof captureType !== 'string' ||
      !allowedTypes.includes(captureType)
    ) {
      return response.status(400).json({
        error: 'Invalid capture type.',
      })
    }

    const result = database
      .prepare(`
        UPDATE capture_inbox
        SET
          capture_type = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(
        captureType,
        id
      )

    if (result.changes === 0) {
      return response.status(404).json({
        error: 'Capture not found.',
      })
    }

    const capture = database
      .prepare(`
        SELECT
          id,
          image,
          original_name AS originalName,
          mime_type AS mimeType,
          note,
          status,
capture_type AS captureType,
analysis_status AS analysisStatus,
analysis_json AS analysisJson,
created_at AS createdAt,
          updated_at AS updatedAt
        FROM capture_inbox
        WHERE id = ?
      `)
      .get(id)

    response.json(capture)
  }
)

app.post(
  '/api/capture/analyze-photo',
  captureAnalyzeUpload.single('image'),
  async (request, response) => {
    if (!request.file) {
      response.status(400).json({
        error: 'An image is required.',
      })
      return
    }

  try {
  const analyzeStartedAt =
    Date.now()

  const sourceExtension =
    getUploadExtension(
      request.file
    )

  const sourceImage =
    'source-' +
    Date.now() +
    '-' +
    Math.round(
      Math.random() * 1000000000
    ) +
    sourceExtension

  const sourceImagePath =
    path.join(
      uploadFolder,
      sourceImage
    )

  const sourceThumbnail =
    `thumb-${path.parse(
      sourceImage
    ).name}.webp`

  const sourceThumbnailPath =
    path.join(
      uploadFolder,
      sourceThumbnail
    )

  const sourceArchivePromise =
    fs.promises
      .writeFile(
        sourceImagePath,
        request.file.buffer
      )
      .then(() => {
        void sharp(
          request.file.buffer
        )
          .rotate()
          .resize({
            width: 420,
            height: 420,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .webp({
            quality: 70,
          })
          .toFile(
            sourceThumbnailPath
          )
          .catch((error) => {
            console.error(
              'Could not create direct photo thumbnail:',
              error
            )
          })

        return sourceImage
      })
      .catch((error) => {
        console.error(
          'Could not archive direct photo:',
          error
        )

        return null
      })

             const imageMetadata =
        await sharp(
          request.file.buffer
        ).metadata()

      const aiImageBuffer =
        await sharp(
          request.file.buffer
        )
          .rotate()
          .resize({
            width: 768,
            height: 768,
            fit: 'inside',
            withoutEnlargement: true,
          })
          .jpeg({
            quality: 82,
          })
          .toBuffer()

      const aiImageMetadata =
        await sharp(
          aiImageBuffer
        ).metadata()

      console.log(
        'PHOTO IMAGE SIZE:',
        {
          originalWidth:
            imageMetadata.width,
          originalHeight:
            imageMetadata.height,
          originalFormat:
            imageMetadata.format,
          originalKB:
            Math.round(
              request.file.buffer.length /
                1024
            ),
          aiWidth:
            aiImageMetadata.width,
          aiHeight:
            aiImageMetadata.height,
          aiFormat:
            aiImageMetadata.format,
          aiKB:
            Math.round(
              aiImageBuffer.length /
                1024
            ),
        }
      )

      const imageBase64 =
        aiImageBuffer.toString(
          'base64'
        )

                 const prompt = `
Analyze this household calendar intake image.

Classify it as exactly one:
- event
- recipe
- list
- other

Use the compact output schema provided.

Type codes:
- e = event
- r = recipe
- l = list
- o = other

Compact field meanings:

For event date object d:
- x = complete visible date text
- v = true only when a 4-digit year is visibly printed
- y = visible 4-digit year, or null when no year is visible
- m = month number from 1 through 12
- d = day of month from 1 through 31

For each event object in e:
- n = event title
- s = start time only
- e = end time only
- a = all-day boolean
- l = venue, place, location, and address
- q = notes or descriptive event information

For recipe object r:
- n = recipe name
- s = servings
- p = prep time
- c = cook time
- i = ingredients
- x = instructions
- g = tags

For list object l:
- n = list name
- i = list items

For other:
- s = summary

Never place information into a compact field that does not match that field's meaning.

Rules:
- Return only information visibly supported by the image.
- Do not invent missing information.
- For event titles, combine adjacent heading lines when they clearly form one event name. Do not drop a visible holiday, occasion, or event qualifier that is part of the heading.
- For event dates, read the entire visible date line carefully, including any visible 4-digit year.
- If a 4-digit year is visibly shown with the event date, yearVisible must be true and year must contain that exact year.
- If no year is visibly shown, yearVisible must be false and year must be null.
- dateText should preserve the complete visible date wording, including the year when shown.
- For visible time ranges such as 12pm-4pm, return the first time as startTime and the second time as endTime.
- If only one time is visibly shown, return it as startTime and leave endTime empty.
- If an event has a visible start or end time, it is not all-day.
- If multiple events are visible, return all clearly readable events.
- For events, location should contain the visible venue, business, building, room, or place name and any visible street or mailing address associated with the event.
- If both a venue name and address are visible, include both in location.
- Do not put venue names, street addresses, city/state/ZIP information, dates, or times in event notes when they belong in their dedicated fields.
- Event notes should contain only separate descriptive information visible in the image.
- Do not repeat an event title, date, time, location, or address inside notes.
- For recipes, extract only information visibly shown in the image. Never infer missing recipe fields.
- For recipe servings, only return a value if the image explicitly shows a serving, serves, yield, or makes value. Do not use subtitles, difficulty labels, nutrition values, or other text as servings.
- For recipe prep time, only return a preparation time that is explicitly shown as prep time or preparation time.
- For recipe cook time, only return a cooking, baking, or cook time that is explicitly shown. Never use calories, nutrition values, temperatures, serving counts, or unrelated numbers as a time.
- For recipe ingredients, return only actual ingredient entries. Do not include section headings such as Ingredients or Directions, and do not put procedural cooking steps in ingredients.
- For recipe instructions, return only actual preparation or cooking steps. Do not include section headings such as Ingredients, Instructions, Method, or Directions as instruction steps.
- If an ingredient or instruction section cannot be read confidently, return an empty array rather than guessing or swapping sections.
- For recipe tags, return only tags or categories visibly supported by the image. Do not invent tags from the recipe title.
- For lists, extract all clearly visible list items.
- If the image cannot confidently be classified as event, recipe, or list, use other.
`

                const schema = {
        oneOf: [
          {
            type: 'object',
            properties: {
              k: {
                const: 'e',
              },
              d: {
                type: 'object',
                properties: {
                  x: {
                    type: 'string',
                  },
                  v: {
                    type: 'boolean',
                  },
                  y: {
                    type: [
                      'integer',
                      'null',
                    ],
                  },
                  m: {
                    type: [
                      'integer',
                      'null',
                    ],
                  },
                  d: {
                    type: [
                      'integer',
                      'null',
                    ],
                  },
                },
                required: [
                  'x',
                  'v',
                  'y',
                  'm',
                  'd',
                ],
                additionalProperties: false,
              },
              e: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    n: {
                      type: 'string',
                    },
                    s: {
                      type: 'string',
                    },
                    e: {
                      type: 'string',
                    },
                    a: {
                      type: 'boolean',
                    },
                    l: {
                      type: 'string',
                    },
                    q: {
                      type: 'string',
                    },
                  },
                  required: [
                    'n',
                    's',
                    'e',
                    'a',
                    'l',
                    'q',
                  ],
                  additionalProperties: false,
                },
              },
            },
            required: [
              'k',
              'd',
              'e',
            ],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              k: {
                const: 'r',
              },
              r: {
                type: 'object',
                properties: {
                  n: {
                    type: 'string',
                  },
                  s: {
                    type: 'string',
                  },
                  p: {
                    type: 'string',
                  },
                  c: {
                    type: 'string',
                  },
                  i: {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  x: {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                  g: {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                },
                required: [
                  'n',
                  's',
                  'p',
                  'c',
                  'i',
                  'x',
                  'g',
                ],
                additionalProperties: false,
              },
            },
            required: [
              'k',
              'r',
            ],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              k: {
                const: 'l',
              },
              l: {
                type: 'object',
                properties: {
                  n: {
                    type: 'string',
                  },
                  i: {
                    type: 'array',
                    items: {
                      type: 'string',
                    },
                  },
                },
                required: [
                  'n',
                  'i',
                ],
                additionalProperties: false,
              },
            },
            required: [
              'k',
              'l',
            ],
            additionalProperties: false,
          },
          {
            type: 'object',
            properties: {
              k: {
                const: 'o',
              },
              s: {
                type: 'string',
              },
            },
            required: [
              'k',
              's',
            ],
            additionalProperties: false,
          },
        ],
      }  

      const ollamaStartedAt =
        Date.now()
      const ollamaResponse =
        await fetch(
          OLLAMA_URL,
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json',
            },
            body: JSON.stringify({
              model:
                CAPTURE_VISION_MODEL,
              stream: false,
              think: false,
              keep_alive: '24h',
              format: schema,
              messages: [
                {
                  role: 'user',
                  content: prompt,
                  images: [
                    imageBase64,
                  ],
                },
              ],
              options: {
                temperature: 0,
              },
            }),
          }
        )

      const ollamaFinishedAt =
        Date.now()

      if (!ollamaResponse.ok) {
        throw new Error(
          `Ollama returned ${ollamaResponse.status}`
        )
      }

           const ollamaResult =
        await ollamaResponse.json()

      const ollamaJsonFinishedAt =
        Date.now()

      console.log(
        'OLLAMA INTERNAL TIMING:',
        {
          totalMs:
            Math.round(
              (ollamaResult.total_duration ?? 0) /
                1000000
            ),
          loadMs:
            Math.round(
              (ollamaResult.load_duration ?? 0) /
                1000000
            ),
          promptEvalMs:
            Math.round(
              (ollamaResult.prompt_eval_duration ?? 0) /
                1000000
            ),
          promptTokens:
            ollamaResult.prompt_eval_count ?? 0,
          responseEvalMs:
            Math.round(
              (ollamaResult.eval_duration ?? 0) /
                1000000
            ),
          responseTokens:
            ollamaResult.eval_count ?? 0,
        }
      )

      const rawContent =
        ollamaResult.message?.content

      if (
        typeof rawContent !==
        'string'
      ) {
        throw new Error(
          'Ollama did not return analysis content.'
        )
      }

                  let compactAnalysis =
        JSON.parse(rawContent)
              if (
        compactAnalysis?.k === 'e'
      ) {
        const firstPassDate =
          compactAnalysis.d ?? {}

        const firstPassEvents =
          Array.isArray(
            compactAnalysis.e
          )
            ? compactAnalysis.e
            : []

        const firstPassEvent =
          firstPassEvents[0] ?? {}

               const firstPassDateText =
          typeof firstPassDate.x ===
          'string'
            ? firstPassDate.x.trim()
            : ''

        const firstPassYear =
          typeof firstPassDate.y ===
          'number'
            ? firstPassDate.y
            : null

        const firstPassYearIsUsable =
          firstPassDate.v === true &&
          firstPassYear !== null &&
          new RegExp(
            `\\b${firstPassYear}\\b`
          ).test(
            firstPassDateText
          )

        const missingVisibleYear =
          !firstPassYearIsUsable

        const missingEventDetails =
          firstPassEvents.length === 0 ||
          (
            firstPassEvents.length === 1 &&
            (
              typeof firstPassEvent.n !==
                'string' ||
              firstPassEvent.n.trim() ===
                '' ||
              (
                (
                  typeof firstPassEvent.s !==
                    'string' ||
                  firstPassEvent.s.trim() ===
                    ''
                ) &&
                typeof firstPassEvent.e ===
                  'string' &&
                firstPassEvent.e.trim() !==
                  ''
              )
            )
          )

        const needsEventVerification =
          missingVisibleYear ||
          missingEventDetails

                  console.log(
          'EVENT VERIFY CHECK:',
          {
            firstPassDateText,
            firstPassYear,
            firstPassYearIsUsable,
            missingVisibleYear,
            missingEventDetails,
            needsEventVerification,
          }
        )
        if (needsEventVerification) {
          try {
            const verifyImageBuffer =
              await sharp(
                request.file.buffer
              )
                .rotate()
                .resize({
                  width: 960,
                  height: 1280,
                  fit: 'inside',
                  withoutEnlargement:
                    true,
                })
                .jpeg({
                  quality: 90,
                })
                .toBuffer()

            const verifyImageBase64 =
              verifyImageBuffer.toString(
                'base64'
              )

            const verifyPrompt = `
This image has already been classified as a calendar event.

Re-read the image carefully at high resolution and extract only the event information that is visibly printed.

The output uses compact field names.

Date object d:
- x = complete visible date text
- v = whether a 4-digit year is visibly printed
- y = visible 4-digit year or null
- m = month number
- d = day of month

Each event object in e:
- n = complete event title
- s = start time only
- e = end time only
- a = all-day boolean
- l = venue, place name, and address
- q = descriptive notes

Do not put titles, venue names, addresses, promotional text, or descriptions into s or e.
Fields s and e may contain only clock times.

Pay special attention to:
- the complete event title
- the complete date, including any visible 4-digit year
- both times when a start-to-end time range is printed
- the actual venue or place name
- the full street address, city, state, and ZIP when visible
- descriptive event text

Rules:
- Never invent a year.
- If a 4-digit year is visibly printed, yearVisible must be true and dateText must include that exact year.
- If no year is visible, yearVisible must be false and year must be null.
- Combine adjacent large heading lines when they clearly form one event title.
- A visible range such as 12PM - 5PM means startTime is 12PM and endTime is 5PM.
- Do not put promotional phrases such as Free Entry or Scan for More Info in location.
- location should contain only an actual venue, building, business, room, place name, or address.
- Include the venue and address together when both are visibly associated with the event.
- notes should contain descriptive event information that does not belong in the title, date, time, or location.
- Return only information visibly supported by the image.
`

            const verifySchema = {
              type: 'object',
              properties: {
                d: {
                  type: 'object',
                  properties: {
                    x: {
                      type: 'string',
                    },
                    v: {
                      type: 'boolean',
                    },
                    y: {
                      type: [
                        'integer',
                        'null',
                      ],
                    },
                    m: {
                      type: [
                        'integer',
                        'null',
                      ],
                    },
                    d: {
                      type: [
                        'integer',
                        'null',
                      ],
                    },
                  },
                  required: [
                    'x',
                    'v',
                    'y',
                    'm',
                    'd',
                  ],
                  additionalProperties:
                    false,
                },
                e: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      n: {
                        type: 'string',
                      },
                      s: {
                        type: 'string',
                      },
                      e: {
                        type: 'string',
                      },
                      a: {
                        type: 'boolean',
                      },
                      l: {
                        type: 'string',
                      },
                      q: {
                        type: 'string',
                      },
                    },
                    required: [
                      'n',
                      's',
                      'e',
                      'a',
                      'l',
                      'q',
                    ],
                    additionalProperties:
                      false,
                  },
                },
              },
              required: [
                'd',
                'e',
              ],
              additionalProperties:
                false,
            }

            const verifyStartedAt =
              Date.now()

            const verifyResponse =
              await fetch(
                OLLAMA_URL,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type':
                      'application/json',
                  },
                  body: JSON.stringify({
                    model:
                      CAPTURE_VISION_MODEL,
                    stream: false,
                    think: false,
                    keep_alive: '24h',
                    format:
                      verifySchema,
                    messages: [
                      {
                        role: 'user',
                        content:
                          verifyPrompt,
                        images: [
                          verifyImageBase64,
                        ],
                      },
                    ],
                    options: {
                      temperature: 0,
                    },
                  }),
                }
              )

            if (verifyResponse.ok) {
              const verifyResult =
                await verifyResponse.json()

              const verifyRawContent =
                verifyResult.message
                  ?.content

              if (
                typeof verifyRawContent ===
                'string'
              ) {
                const verifiedAnalysis =
                  JSON.parse(
                    verifyRawContent
                  )

                console.log(
                  'EVENT VERIFY RESULT:',
                  JSON.stringify(
                    verifiedAnalysis,
                    null,
                    2
                  )
                )

                console.log(
                  'EVENT VERIFY TIMING:',
                  {
                    totalMs:
                      Date.now() -
                      verifyStartedAt,
                    ollamaMs:
                      Math.round(
                        (
                          verifyResult.total_duration ??
                          0
                        ) /
                          1000000
                      ),
                    promptTokens:
                      verifyResult.prompt_eval_count ??
                      0,
                    responseTokens:
                      verifyResult.eval_count ??
                      0,
                    imageKB:
                      Math.round(
                        verifyImageBuffer.length /
                          1024
                      ),
                  }
                )

                const verifiedDate =
                  verifiedAnalysis.d ??
                  {}

                const verifiedEvents =
                  Array.isArray(
                    verifiedAnalysis.e
                  )
                    ? verifiedAnalysis.e
                    : []

                const verifiedDateText =
                  typeof verifiedDate.x ===
                  'string'
                    ? verifiedDate.x.trim()
                    : ''

                const verifiedYear =
                  typeof verifiedDate.y ===
                  'number'
                    ? verifiedDate.y
                    : null

                const verifiedYearIsUsable =
                  verifiedDate.v === true &&
                  verifiedYear !== null &&
                  new RegExp(
                    `\\b${verifiedYear}\\b`
                  ).test(
                    verifiedDateText
                  )

                compactAnalysis.d = {
                  ...firstPassDate,
                  x:
                    verifiedDateText !== ''
                      ? verifiedDateText
                      : firstPassDate.x,
                  v:
                    verifiedYearIsUsable
                      ? true
                      : firstPassDate.v,
                  y:
                    verifiedYearIsUsable
                      ? verifiedYear
                      : firstPassDate.y,
                                   m:
                    typeof verifiedDate.m ===
                      'number' &&
                    verifiedDate.m >= 1 &&
                    verifiedDate.m <= 12
                      ? verifiedDate.m
                      : firstPassDate.m,
                  d:
                    typeof verifiedDate.d ===
                      'number' &&
                    verifiedDate.d >= 1 &&
                    verifiedDate.d <= 31
                      ? verifiedDate.d
                      : firstPassDate.d,
                }

                const preferVerifiedText = (
                  verifiedValue,
                  originalValue
                ) => {
                  if (
                    typeof verifiedValue ===
                      'string' &&
                    verifiedValue.trim() !==
                      ''
                  ) {
                    return verifiedValue.trim()
                  }

                  return typeof originalValue ===
                    'string'
                    ? originalValue
                    : ''
                }

                if (
                  verifiedEvents.length ===
                    firstPassEvents.length &&
                  verifiedEvents.length > 0
                ) {
                  compactAnalysis.e =
                    firstPassEvents.map(
                      (
                        originalEvent,
                        index
                      ) => {
                        const verifiedEvent =
                          verifiedEvents[
                            index
                          ] ?? {}

                        return {
                          ...originalEvent,
                          n:
                            preferVerifiedText(
                              verifiedEvent.n,
                              originalEvent.n
                            ),
                          s:
                            preferVerifiedText(
                              verifiedEvent.s,
                              originalEvent.s
                            ),
                          e:
                            preferVerifiedText(
                              verifiedEvent.e,
                              originalEvent.e
                            ),
                          a:
                            typeof verifiedEvent.a ===
                            'boolean'
                              ? verifiedEvent.a
                              : originalEvent.a,
                          l:
                            preferVerifiedText(
                              verifiedEvent.l,
                              originalEvent.l
                            ),
                          q:
                            preferVerifiedText(
                              verifiedEvent.q,
                              originalEvent.q
                            ),
                        }
                      }
                    )
                } else if (
                  firstPassEvents.length ===
                    0 &&
                  verifiedEvents.length > 0
                ) {
                  compactAnalysis.e =
                    verifiedEvents
                }
              }
            } else {
              console.warn(
                'Event verification returned:',
                verifyResponse.status
              )
            }
          } catch (error) {
            console.error(
              'Event verification failed:',
              error
            )
          }
        }
      }
      const captureTypeMap = {
        e: 'event',
        r: 'recipe',
        l: 'list',
        o: 'other',
      }

      const analysis = {
        captureType:
          captureTypeMap[
            compactAnalysis.k
          ] ?? 'other',
      }

           if (
        analysis.captureType ===
        'event'
      ) {
        const compactDate =
          compactAnalysis.d ?? {}

        const normalizeEventTime = (
          value
        ) => {
          if (
            typeof value !==
            'string'
          ) {
            return ''
          }

          const cleanedValue =
            value.trim()

          if (
            cleanedValue === ''
          ) {
            return ''
          }

          const twelveHourMatch =
            cleanedValue.match(
              /\b(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)\b/i
            )

          if (twelveHourMatch) {
            return twelveHourMatch[0]
              .replace(/\./g, '')
              .trim()
          }

          const twentyFourHourMatch =
            cleanedValue.match(
              /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/
            )

          return twentyFourHourMatch
            ? twentyFourHourMatch[0]
            : ''
        }

        const rawDateText =
          typeof compactDate.x ===
          'string'
            ? compactDate.x.trim()
            : ''

        const claimedYear =
          typeof compactDate.y ===
            'number'
            ? compactDate.y
            : null

        const yearAppearsInDateText =
          claimedYear !== null &&
          new RegExp(
            `\\b${claimedYear}\\b`
          ).test(
            rawDateText
          )

        const yearVisible =
          compactDate.v === true &&
          yearAppearsInDateText

        const month =
          typeof compactDate.m ===
            'number' &&
          compactDate.m >= 1 &&
          compactDate.m <= 12
            ? compactDate.m
            : null

        const day =
          typeof compactDate.d ===
            'number' &&
          compactDate.d >= 1 &&
          compactDate.d <= 31
            ? compactDate.d
            : null

        const monthNames = [
          'January',
          'February',
          'March',
          'April',
          'May',
          'June',
          'July',
          'August',
          'September',
          'October',
          'November',
          'December',
        ]

        const rawDateLooksValid =
          /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(
            rawDateText
          ) ||
          /\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b/.test(
            rawDateText
          )

        let normalizedDateText =
          rawDateLooksValid
            ? rawDateText
            : ''

        if (
          normalizedDateText === '' &&
          month !== null &&
          day !== null
        ) {
          normalizedDateText =
            `${monthNames[month - 1]} ${day}`

          if (
            yearVisible &&
            claimedYear !== null
          ) {
            normalizedDateText +=
              `, ${claimedYear}`
          }
        }

        analysis.dateContext = {
          dateText:
            normalizedDateText,
          yearVisible,
          year:
            yearVisible
              ? claimedYear
              : null,
          month,
          day,
          weekday: '',
        }

        if (
          analysis.dateContext
            .yearVisible &&
          typeof analysis
            .dateContext.year ===
            'number' &&
          typeof analysis
            .dateContext.month ===
            'number' &&
          typeof analysis
            .dateContext.day ===
            'number'
        ) {
          const dateCandidate =
            new Date(
              analysis.dateContext.year,
              analysis.dateContext
                .month - 1,
              analysis.dateContext.day
            )

          if (
            dateCandidate.getFullYear() ===
              analysis.dateContext.year &&
            dateCandidate.getMonth() ===
              analysis.dateContext
                .month -
                1 &&
            dateCandidate.getDate() ===
              analysis.dateContext.day
          ) {
            analysis.dateContext.weekday =
              dateCandidate.toLocaleDateString(
                'en-US',
                {
                  weekday:
                    'long',
                }
              )
          }
        }

        analysis.events =
          Array.isArray(
            compactAnalysis.e
          )
            ? compactAnalysis.e.map(
                (event) => {
                  const rawStartTime =
                    typeof event.s ===
                    'string'
                      ? event.s
                      : ''

                  const rawEndTime =
                    typeof event.e ===
                    'string'
                      ? event.e
                      : ''

                  const startTime =
                    normalizeEventTime(
                      rawStartTime
                    )

                  const endTime =
                    normalizeEventTime(
                      rawEndTime
                    )

                                    let location =
                    typeof event.l ===
                    'string'
                      ? event.l.trim()
                      : ''

                  let notes =
                    typeof event.q ===
                    'string'
                      ? event.q.trim()
                      : ''

                  if (
                    rawEndTime.trim() !==
                      '' &&
                    endTime === ''
                  ) {
                    const extraText =
                      rawEndTime.trim()

                    if (
                      extraText !== notes
                    ) {
                      notes =
                        notes === ''
                          ? extraText
                          : `${extraText}\n${notes}`
                    }
                  }

                  const noteLines =
                    notes
                      .split(/\r?\n/)
                      .map((line) =>
                        line.trim()
                      )
                      .filter(
                        (line) =>
                          line !== ''
                      )

                  const streetAddressIndex =
                    noteLines.findIndex(
                      (line) =>
                        /^\d{1,6}\s+.+\b(?:street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|court|ct|parkway|pkwy|highway|hwy|way|circle|cir|trail|trl|terrace|ter)\.?$/i.test(
                          line
                        )
                    )

                  if (
                    streetAddressIndex >= 0
                  ) {
                    const addressLines = [
                      noteLines[
                        streetAddressIndex
                      ],
                    ]

                    let addressEndIndex =
                      streetAddressIndex + 1

                    while (
                      addressEndIndex <
                        noteLines.length &&
                      addressLines.length < 3
                    ) {
                      const nextLine =
                        noteLines[
                          addressEndIndex
                        ]

                      const looksLikeAddressContinuation =
                        nextLine.includes(
                          ','
                        ) ||
                        /\b\d{5}(?:-\d{4})?\b/.test(
                          nextLine
                        )

                      if (
                        !looksLikeAddressContinuation
                      ) {
                        break
                      }

                      addressLines.push(
                        nextLine
                      )

                      addressEndIndex += 1
                    }

                    const addressText =
                      addressLines.join(
                        ', '
                      )

                    if (
                      !location
                        .toLowerCase()
                        .includes(
                          addressText.toLowerCase()
                        )
                    ) {
                      location =
                        location === ''
                          ? addressText
                          : `${location}, ${addressText}`
                    }

                    notes =
                      noteLines
                        .filter(
                          (
                            _line,
                            index
                          ) =>
                            index <
                              streetAddressIndex ||
                            index >=
                              addressEndIndex
                        )
                        .join('\n')
                  }

                  return {
                    title:
                      typeof event.n ===
                      'string'
                        ? event.n
                        : '',
                    startTime,
                    endTime,
                    allDay:
                      Boolean(
                        event.a
                      ),
                                       location,
                    notes,
                  }
                }
              )
            : []

        analysis.summary =
          analysis.events[0]
            ?.title ?? 'Event'
      }

            if (
        analysis.captureType ===
        'recipe'
      ) {
        const compactRecipe =
          compactAnalysis.r ?? {}
        const normalizeRecipeServings = (
          value
        ) => {
          if (
            typeof value !==
            'string'
          ) {
            return ''
          }

          const cleanedValue =
            value.trim()

          if (
            cleanedValue === ''
          ) {
            return ''
          }

          const hasServingWord =
            /\b(serves?|servings?|yield|makes?)\b/i.test(
              cleanedValue
            )

          const hasCount =
            /\d/.test(
              cleanedValue
            ) ||
            /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/i.test(
              cleanedValue
            )

          const looksLikeBareCount =
            /^(?:\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)$/i.test(
              cleanedValue
            )

          if (
            looksLikeBareCount ||
            (
              hasServingWord &&
              hasCount
            )
          ) {
            return cleanedValue
          }

          return ''
        }
        const normalizeRecipeTime = (
          value
        ) => {
          if (
            typeof value !==
            'string'
          ) {
            return ''
          }

          const cleanedValue =
            value.trim()

          if (
            cleanedValue === ''
          ) {
            return ''
          }

          if (
            /^(n\/a|na|none|unknown|not shown|not listed)$/i.test(
              cleanedValue
            )
          ) {
            return ''
          }

          const looksLikeTime =
            /\b\d+(?:\.\d+)?\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i.test(
              cleanedValue
            ) ||
            /\b\d+(?:\.\d+)?\s*[hms]\b/i.test(
              cleanedValue
            ) ||
            /\bovernight\b/i.test(
              cleanedValue
            )

          return looksLikeTime
            ? cleanedValue
            : ''
        }

        analysis.recipe = {
          title:
            typeof compactRecipe.n ===
            'string'
              ? compactRecipe.n
              : '',
                    servings:
            normalizeRecipeServings(
              compactRecipe.s
            ),
          prepTime:
            normalizeRecipeTime(
              compactRecipe.p
            ),
          cookTime:
            normalizeRecipeTime(
              compactRecipe.c
            ),
          ingredients:
            Array.isArray(
              compactRecipe.i
            )
              ? compactRecipe.i
              : [],
          instructions:
            Array.isArray(
              compactRecipe.x
            )
              ? compactRecipe.x
              : [],
          tags:
            Array.isArray(
              compactRecipe.g
            )
              ? compactRecipe.g
              : [],
        }

        analysis.summary =
          analysis.recipe.title ||
          'Recipe'
      }

      if (
        analysis.captureType ===
        'list'
      ) {
        const compactList =
          compactAnalysis.l ?? {}

        analysis.list = {
          name:
            typeof compactList.n ===
            'string'
              ? compactList.n
              : '',
          items:
            Array.isArray(
              compactList.i
            )
              ? compactList.i
              : [],
        }

        analysis.summary =
          analysis.list.name ||
          'List'
      }

      if (
        analysis.captureType ===
        'other'
      ) {
        analysis.summary =
          typeof compactAnalysis.s ===
          'string'
            ? compactAnalysis.s
            : ''
      }

      console.log(
        'PHOTO ANALYSIS RESULT:',
        JSON.stringify(
          analysis,
          null,
          2
        )
      )

      if (
        Array.isArray(
          analysis.events
        )
      ) {
        analysis.events =
          analysis.events.map(
            (event) => {
              const hasTime =
                Boolean(
                  event.startTime
                ) ||
                Boolean(
                  event.endTime
                )

              return {
                ...event,
                allDay: hasTime
                  ? false
                  : Boolean(
                      event.allDay
                    ),
              }
            }
          )
      } else {
        analysis.events = []
      }

      if (
        analysis.dateContext &&
        analysis.dateContext
          .yearVisible !== true
      ) {
        analysis.dateContext.year =
          null
      }

            const archiveWaitStartedAt =
        Date.now()

      analysis.sourceImage =
        await sourceArchivePromise

      const responseReadyAt =
        Date.now()

      console.log(
        'PHOTO ANALYZE TIMING:',
        {
          totalMs:
            responseReadyAt -
            analyzeStartedAt,

          ollamaMs:
            ollamaFinishedAt -
            ollamaStartedAt,

          ollamaJsonMs:
            ollamaJsonFinishedAt -
            ollamaFinishedAt,

          processingAfterOllamaMs:
            archiveWaitStartedAt -
            ollamaJsonFinishedAt,

          archiveWaitMs:
            responseReadyAt -
            archiveWaitStartedAt,

          imageKB:
            Math.round(
              request.file.buffer.length /
                1024
            ),
        }
      )

      response.json(
        analysis
      )
    } catch (error) {
      console.error(
        'Could not analyze direct photo:',
        error
      )

      response.status(502).json({
        error:
          'Could not analyze photo with local AI.',
      })
    }
  }
)

app.post(
  '/api/capture-inbox/:id/analyze',
  async (request, response) => {
    const id = Number(request.params.id)

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      return response.status(400).json({
        error: 'Invalid Capture Inbox ID.',
      })
    }

    const capture = database
      .prepare(`
        SELECT
          id,
          image,
          note
        FROM capture_inbox
        WHERE id = ?
      `)
      .get(id)

    if (!capture) {
      return response.status(404).json({
        error: 'Capture not found.',
      })
    }

    const imagePath = path.join(
      uploadFolder,
      capture.image
    )

    if (!fs.existsSync(imagePath)) {
      return response.status(404).json({
        error: 'Capture image not found.',
      })
    }

    database
      .prepare(`
        UPDATE capture_inbox
        SET
          analysis_status = 'analyzing',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
            .run(id)

    response.status(202).json({
      id,
      analysisStatus: 'analyzing',
    })

    void (async () => {
      try {
      const imageBase64 =
        fs.readFileSync(
          imagePath
        ).toString('base64')

      const prompt = `
Analyze this image for a family calendar.

Determine whether the image contains:
- event
- recipe
- list
- other

Only report information visibly supported by the image.

EVENT RULES:
- Extract every distinct visible event.
- Do not infer or calculate a year.
- Read the entire visible event date line carefully.
- If a 4-digit year is visibly shown, yearVisible must be true and year must contain that exact year.
- If a year is not visibly shown, yearVisible must be false and year must be null.
- dateText should contain the complete visible date, including a visible year.
- weekday should contain the visible weekday if present.
- month and day may be normalized numerically when visibly determinable.
- For a visible time range, extract both endpoints. Example: 12pm-4pm means startTime is 12pm and endTime is 4pm.
- startTime and endTime may be normalized to 24-hour HH:MM.
- If startTime or endTime exists, allDay must be false.
- Only set allDay true for an explicitly all-day event without a timed range.
- Do not invent locations.
- location should contain any visible venue, business, building, room, or place name and any visible street or mailing address associated with the event.
- If both a venue name and address are visible, include both in location.
- Do not place venue names, addresses, city/state/ZIP information, dates, or times in notes when they belong in dedicated fields.
- Do not paraphrase title, date, time, location, or address into notes.
- notes must only contain separate descriptive information visibly associated with the event.

RECIPE RULES:
- Extract the visible recipe title.
- Extract servings, prep time, cook time, ingredients, instructions, and tags when visible.
- Do not invent missing ingredients or instructions.

LIST RULES:
- Extract the visible list name if present.
- Extract every clearly visible list item.
- Do not invent missing items.

GENERAL RULES:
- Do not guess missing information.
- Use empty strings or empty arrays for missing information.
- Preserve visible wording as accurately as possible.
`

      const schema = {
        type: 'object',

        properties: {
          captureType: {
            type: 'string',
            enum: [
              'event',
              'recipe',
              'list',
              'other',
            ],
          },

          summary: {
            type: 'string',
          },

          dateContext: {
            type: 'object',

            properties: {
              dateText: {
                type: 'string',
              },

              yearVisible: {
                type: 'boolean',
              },

              year: {
                type: [
                  'integer',
                  'null',
                ],
              },

              month: {
                type: [
                  'integer',
                  'null',
                ],
              },

              day: {
                type: [
                  'integer',
                  'null',
                ],
              },

              weekday: {
                type: 'string',
              },
            },

            required: [
              'dateText',
              'yearVisible',
              'year',
              'month',
              'day',
              'weekday',
            ],
          },

          events: {
            type: 'array',

            items: {
              type: 'object',

              properties: {
                title: {
                  type: 'string',
                },

                startTime: {
                  type: 'string',
                },

                endTime: {
                  type: 'string',
                },

                allDay: {
                  type: 'boolean',
                },

                location: {
                  type: 'string',
                },

                notes: {
                  type: 'string',
                },
              },

              required: [
                'title',
                'startTime',
                'endTime',
                'allDay',
                'location',
                'notes',
              ],
            },
          },

          recipe: {
            type: 'object',

            properties: {
              title: {
                type: 'string',
              },

              servings: {
                type: 'string',
              },

              prepTime: {
                type: 'string',
              },

              cookTime: {
                type: 'string',
              },

              ingredients: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },

              instructions: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },

              tags: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
            },

            required: [
              'title',
              'servings',
              'prepTime',
              'cookTime',
              'ingredients',
              'instructions',
              'tags',
            ],
          },

          list: {
            type: 'object',

            properties: {
              name: {
                type: 'string',
              },

              items: {
                type: 'array',
                items: {
                  type: 'string',
                },
              },
            },

            required: [
              'name',
              'items',
            ],
          },
        },

        required: [
          'captureType',
          'summary',
          'dateContext',
          'events',
          'recipe',
          'list',
        ],
      }

                 const ollamaStartedAt =
        Date.now()

      const ollamaResponse =
        await fetch(
          OLLAMA_URL,
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json',
            },
            body: JSON.stringify({
              model:
                CAPTURE_VISION_MODEL,
              stream: false,
              think: false,
              keep_alive: '24h',
              format: schema,
              messages: [
                {
                  role: 'user',
                  content: prompt,
                  images: [
                    imageBase64,
                  ],
                },
              ],
              options: {
                temperature: 0,
              },
            }),
          }
        )

      const ollamaFinishedAt =
        Date.now()

      if (!ollamaResponse.ok) {
        throw new Error(
          `Ollama returned ${ollamaResponse.status}`
        )
      }

      const ollamaResult =
        await ollamaResponse.json()

      const ollamaJsonFinishedAt =
        Date.now()

      const rawContent =
        ollamaResult.message?.content

  

      if (
        typeof rawContent !== 'string' ||
        rawContent.trim() === ''
      ) {
        throw new Error(
          'Ollama returned no analysis.'
        )
      }

      const analysis =
        JSON.parse(rawContent)

      if (
        ![
          'event',
          'recipe',
          'list',
          'other',
        ].includes(
          analysis.captureType
        )
      ) {
        throw new Error(
          'Ollama returned an invalid capture type.'
        )
      }

      if (
        Array.isArray(
          analysis.events
        )
      ) {
        analysis.events =
          analysis.events.map(
            (event) => {
              const hasTime =
                Boolean(
                  event.startTime
                ) ||
                Boolean(
                  event.endTime
                )

              return {
                ...event,

                allDay:
                  hasTime
                    ? false
                    : Boolean(
                        event.allDay
                      ),
              }
            }
          )
      }

      if (
        analysis.dateContext &&
        analysis.dateContext
          .yearVisible !== true
      ) {
        analysis.dateContext.year =
          null
      }

      const analysisJson =
        JSON.stringify(
          analysis
        )

      database
        .prepare(`
          UPDATE capture_inbox
          SET
            capture_type = ?,
            analysis_status = 'complete',
            analysis_json = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(
          analysis.captureType,
          analysisJson,
          id
        )

      const updatedCapture =
        database
          .prepare(`
            SELECT
              id,
              image,
              original_name AS originalName,
              mime_type AS mimeType,
              note,
              status,
              capture_type AS captureType,
              analysis_status AS analysisStatus,
              analysis_json AS analysisJson,
              created_at AS createdAt,
              updated_at AS updatedAt
            FROM capture_inbox
            WHERE id = ?
          `)
          .get(id)

            console.log(
        `Capture ${id} analysis complete.`
      )
    } catch (error) {
      console.error(
        'Could not analyze capture:',
        error
      )

      database
        .prepare(`
          UPDATE capture_inbox
          SET
            analysis_status = 'error',
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(id)

            console.error(
        `Capture ${id} analysis failed.`
      )
      }
    })()
  }
)

app.patch(
  '/api/capture-inbox/:id/analysis',
  (request, response) => {
    const id = Number(request.params.id)
    const analysis = request.body

    const allowedTypes = [
      'event',
      'recipe',
      'list',
      'other',
    ]

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      return response.status(400).json({
        error: 'Invalid Capture Inbox ID.',
      })
    }

    if (
      !analysis ||
      typeof analysis !== 'object' ||
      Array.isArray(analysis)
    ) {
      return response.status(400).json({
        error: 'Invalid analysis result.',
      })
    }

    if (
      typeof analysis.captureType !==
        'string' ||
      !allowedTypes.includes(
        analysis.captureType
      )
    ) {
      return response.status(400).json({
        error: 'Invalid capture type.',
      })
    }

    const existingCapture = database
      .prepare(`
        SELECT id
        FROM capture_inbox
        WHERE id = ?
      `)
      .get(id)

    if (!existingCapture) {
      return response.status(404).json({
        error: 'Capture not found.',
      })
    }

    const analysisJson =
      JSON.stringify(analysis)

    database
      .prepare(`
        UPDATE capture_inbox
        SET
          capture_type = ?,
          analysis_status = 'complete',
          analysis_json = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)
      .run(
        analysis.captureType,
        analysisJson,
        id
      )

    const capture = database
      .prepare(`
        SELECT
          id,
          image,
          original_name AS originalName,
          mime_type AS mimeType,
          note,
          status,
          capture_type AS captureType,
          analysis_status AS analysisStatus,
          analysis_json AS analysisJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM capture_inbox
        WHERE id = ?
      `)
      .get(id)

    response.json(capture)
  }
)

app.delete('/api/capture-inbox/:id', (request, response) => {
  const id = Number(request.params.id)

  if (!Number.isInteger(id) || id <= 0) {
    return response.status(400).json({
      error: 'Invalid Capture Inbox ID.',
    })
  }

  const capture = database
    .prepare(`
      SELECT id, image
      FROM capture_inbox
      WHERE id = ?
    `)
    .get(id)

  if (!capture) {
    return response.status(404).json({
      error: 'Capture not found.',
    })
  }

  try {
    database
      .prepare(`
        DELETE FROM capture_inbox
        WHERE id = ?
      `)
      .run(id)

    deleteStoredImageFile(
      capture.image
    )

    response.json({
      success: true,
    })
  } catch (error) {
    console.error(
      'Could not delete capture:',
      error
    )

    response.status(500).json({
      error: 'Could not delete capture.',
    })
  }
})
app.get('/api/meal-plans', (request, response) => {
  const meals = database
    .prepare(`
      SELECT id, date, dinner, notes
      FROM meal_plans
      ORDER BY date
    `)
    .all()

  response.json(meals)
})

app.get('/api/recipes', (request, response) => {
  const recipes = database
    .prepare(`
      SELECT
        id,
        name,
        image,
source_image AS sourceImage,
servings,
        prep_time AS prepTime,
        cook_time AS cookTime,
        ingredients,
        instructions,
        notes,
        tags,
        favorite,
        source_url AS sourceUrl,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM recipes
      ORDER BY favorite DESC, name COLLATE NOCASE, id
    `)
    .all()
    .map((recipe) => ({
      ...recipe,
      favorite: Boolean(recipe.favorite),
    }))

  response.json(recipes)
})

app.post(
  '/api/recipes',
  upload.single('image'),
  (request, response) => {
    const {
      name,
      servings,
      prepTime,
      cookTime,
      ingredients,
      instructions,
      notes,
      tags,
      favorite,
sourceUrl,
sourceImage,
} = request.body

    if (!isValidTitle(name)) {
      if (request.file) {
        deleteStoredImageFile(
          request.file.filename
        )
      }

      return response.status(400).json({
        error: 'A recipe name is required.',
      })
    }

    let cleanServings = null

    if (
      typeof servings === 'string' &&
      servings.trim() !== ''
    ) {
      const parsedServings =
        Number(servings)

      if (
        !Number.isInteger(parsedServings) ||
        parsedServings <= 0 ||
        parsedServings > 1000
      ) {
        if (request.file) {
          deleteStoredImageFile(
            request.file.filename
          )
        }

        return response.status(400).json({
          error: 'Servings must be a positive whole number.',
        })
      }

      cleanServings = parsedServings
    }

    function cleanRecipeText(
      value,
      maxLength
    ) {
      if (typeof value !== 'string') {
        return null
      }

      const trimmedValue = value.trim()

      if (trimmedValue === '') {
        return null
      }

      if (trimmedValue.length > maxLength) {
        return null
      }

      return trimmedValue
    }

    const cleanPrepTime =
      cleanRecipeText(prepTime, 100)

    const cleanCookTime =
      cleanRecipeText(cookTime, 100)

    const cleanIngredients =
      typeof ingredients === 'string'
        ? ingredients.trim()
        : ''

    const cleanInstructions =
      typeof instructions === 'string'
        ? instructions.trim()
        : ''

    const cleanNotes =
      cleanRecipeText(notes, 5000)

    const cleanTags =
      cleanRecipeText(tags, 1000)

    const cleanSourceUrl =
      cleanRecipeText(sourceUrl, 2000)
const cleanSourceImage =
  cleanRecipeText(
    sourceImage,
    500
  )
    const cleanFavorite =
      favorite === 'true' ||
      favorite === '1'
        ? 1
        : 0

    const image =
      request.file
        ? request.file.filename
        : null

    try {
      const result = database
        .prepare(`
          INSERT INTO recipes (
            name,
image,
source_image,
servings,
            prep_time,
            cook_time,
            ingredients,
            instructions,
            notes,
            tags,
            favorite,
            source_url
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
         name.trim(),
image,
cleanSourceImage,
cleanServings,
          cleanPrepTime,
          cleanCookTime,
          cleanIngredients,
          cleanInstructions,
          cleanNotes,
          cleanTags,
          cleanFavorite,
          cleanSourceUrl
        )

      const recipeId =
        Number(result.lastInsertRowid)

      const recipe = database
        .prepare(`
          SELECT
            id,
            name,
            image,
source_image AS sourceImage,
servings,
            prep_time AS prepTime,
            cook_time AS cookTime,
            ingredients,
            instructions,
            notes,
            tags,
            favorite,
            source_url AS sourceUrl,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM recipes
          WHERE id = ?
        `)
        .get(recipeId)

      response.status(201).json({
        ...recipe,
        favorite:
          Boolean(recipe.favorite),
      })
    } catch (error) {
      if (request.file) {
        deleteStoredImageFile(
          request.file.filename
        )
      }

      console.error(
        'POST /api/recipes failed:',
        error
      )

      response.status(500).json({
        error: 'Could not save the recipe.',
      })
    }
  }
)

app.put(
  '/api/recipes/:id',
  upload.single('image'),
  (request, response) => {
    const id = Number(request.params.id)

    const {
      name,
      servings,
      prepTime,
      cookTime,
      ingredients,
      instructions,
      notes,
      tags,
     favorite,
sourceUrl,
sourceImage,
} = request.body

    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      !isValidTitle(name)
    ) {
      if (request.file) {
        deleteStoredImageFile(
          request.file.filename
        )
      }

      return response.status(400).json({
        error: 'Invalid recipe information.',
      })
    }

    const existingRecipe = database
      .prepare(`
        SELECT
  id,
  image,
  source_image
FROM recipes
        WHERE id = ?
      `)
      .get(id)

    if (!existingRecipe) {
      if (request.file) {
        deleteStoredImageFile(
          request.file.filename
        )
      }

      return response.status(404).json({
        error: 'Recipe not found.',
      })
    }

    let cleanServings = null

    if (
      typeof servings === 'string' &&
      servings.trim() !== ''
    ) {
      const parsedServings =
        Number(servings)

      if (
        !Number.isInteger(parsedServings) ||
        parsedServings <= 0 ||
        parsedServings > 1000
      ) {
        if (request.file) {
          deleteStoredImageFile(
            request.file.filename
          )
        }

        return response.status(400).json({
          error: 'Servings must be a positive whole number.',
        })
      }

      cleanServings = parsedServings
    }

    function cleanRecipeText(
      value,
      maxLength
    ) {
      if (typeof value !== 'string') {
        return null
      }

      const trimmedValue = value.trim()

      if (trimmedValue === '') {
        return null
      }

      if (trimmedValue.length > maxLength) {
        return null
      }

      return trimmedValue
    }

    const cleanPrepTime =
      cleanRecipeText(prepTime, 100)

    const cleanCookTime =
      cleanRecipeText(cookTime, 100)

    const cleanIngredients =
      typeof ingredients === 'string'
        ? ingredients.trim()
        : ''

    const cleanInstructions =
      typeof instructions === 'string'
        ? instructions.trim()
        : ''

    const cleanNotes =
      cleanRecipeText(notes, 5000)

    const cleanTags =
      cleanRecipeText(tags, 1000)

    const cleanSourceUrl =
      cleanRecipeText(sourceUrl, 2000)
const cleanSourceImage =
  cleanRecipeText(
    sourceImage,
    500
  )

const nextSourceImage =
  cleanSourceImage ??
  existingRecipe.source_image
    const cleanFavorite =
      favorite === 'true' ||
      favorite === '1'
        ? 1
        : 0

    const nextImage =
      request.file
        ? request.file.filename
        : existingRecipe.image

    try {
      database
        .prepare(`
          UPDATE recipes
          SET
           name = ?,
image = ?,
source_image = ?,
servings = ?,
            prep_time = ?,
            cook_time = ?,
            ingredients = ?,
            instructions = ?,
            notes = ?,
            tags = ?,
            favorite = ?,
            source_url = ?,
            updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .run(
          name.trim(),
nextImage,
nextSourceImage,
cleanServings,
          cleanPrepTime,
          cleanCookTime,
          cleanIngredients,
          cleanInstructions,
          cleanNotes,
          cleanTags,
          cleanFavorite,
          cleanSourceUrl,
          id
        )

      if (
        request.file &&
        existingRecipe.image
      ) {
        deleteStoredImageFile(
          existingRecipe.image
        )
      }

      const recipe = database
        .prepare(`
          SELECT
            id,
            name,
           image,
source_image AS sourceImage,
servings,
            prep_time AS prepTime,
            cook_time AS cookTime,
            ingredients,
            instructions,
            notes,
            tags,
            favorite,
            source_url AS sourceUrl,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM recipes
          WHERE id = ?
        `)
        .get(id)

      response.json({
        ...recipe,
        favorite:
          Boolean(recipe.favorite),
      })
    } catch (error) {
      if (request.file) {
        deleteStoredImageFile(
          request.file.filename
        )
      }

      console.error(
        'PUT /api/recipes/:id failed:',
        error
      )

      response.status(500).json({
        error: 'Could not update the recipe.',
      })
    }
  }
)

app.delete('/api/recipes/:id', (request, response) => {
  const id = Number(request.params.id)

  if (
    !Number.isInteger(id) ||
    id <= 0
  ) {
    return response.status(400).json({
      error: 'Invalid recipe ID.',
    })
  }

  const recipe = database
    .prepare(`
      SELECT id, image
      FROM recipes
      WHERE id = ?
    `)
    .get(id)

  if (!recipe) {
    return response.status(404).json({
      error: 'Recipe not found.',
    })
  }

  const result = database
    .prepare(`
      DELETE FROM recipes
      WHERE id = ?
    `)
    .run(id)

  if (result.changes === 0) {
    return response.status(404).json({
      error: 'Recipe not found.',
    })
  }

  if (recipe.image) {
    deleteStoredImageFile(
      recipe.image
    )
  }

  response.json({
    success: true,
  })
})

app.put('/api/meal-plans/:date', (request, response) => {
  const date = request.params.date
  const { dinner, notes } = request.body

  if (
    !isValidDate(date) ||
    typeof dinner !== 'string' ||
    dinner.trim().length === 0 ||
    dinner.trim().length > 200
  ) {
    return response.status(400).json({
      error: 'A valid date and dinner are required.',
    })
  }

  const cleanDinner = dinner.trim()
  const cleanNotes = cleanOptionalText(notes, 1000)

  database
    .prepare(`
      INSERT INTO meal_plans (date, dinner, notes)
      VALUES (?, ?, ?)
      ON CONFLICT(date)
      DO UPDATE SET
        dinner = excluded.dinner,
        notes = excluded.notes
    `)
    .run(date, cleanDinner, cleanNotes)

  const savedMeal = database
    .prepare(`
      SELECT id, date, dinner, notes
      FROM meal_plans
      WHERE date = ?
    `)
    .get(date)

  response.json(savedMeal)
})

app.delete('/api/meal-plans/:date', (request, response) => {
  const date = request.params.date

  if (!isValidDate(date)) {
    return response.status(400).json({
      error: 'Invalid date.',
    })
  }

  const result = database
    .prepare(`
      DELETE FROM meal_plans
      WHERE date = ?
    `)
    .run(date)

  response.json({
    success: true,
    deleted: result.changes,
  })
})

app.get('/api/meal-plan-items', (request, response) => {
  const items = database
    .prepare(`
      SELECT
        meal_plan_items.id,
        meal_plan_items.date,
        meal_plan_items.meal_type AS mealType,
        meal_plan_items.recipe_id AS recipeId,
        meal_plan_items.title,
        meal_plan_items.notes,
        meal_plan_items.created_at AS createdAt,
        recipes.image AS recipeImage
      FROM meal_plan_items
      LEFT JOIN recipes
        ON recipes.id = meal_plan_items.recipe_id
      ORDER BY
        meal_plan_items.date,
        CASE meal_plan_items.meal_type
          WHEN 'breakfast' THEN 1
          WHEN 'lunch' THEN 2
          WHEN 'dinner' THEN 3
          WHEN 'snack' THEN 4
          ELSE 5
        END,
        meal_plan_items.id
    `)
    .all()

  response.json(items)
})

app.put(
  '/api/meal-plan-items/:date/:mealType',
  (request, response) => {
    const date = request.params.date
    const mealType =
      request.params.mealType

    const {
  itemId,
  recipeId,
  title,
  notes,
} = request.body

    const allowedMealTypes = [
      'breakfast',
      'lunch',
      'dinner',
      'snack',
    ]

    if (
      !isValidDate(date) ||
      !allowedMealTypes.includes(mealType)
    ) {
      return response.status(400).json({
        error: 'Invalid meal plan date or meal type.',
      })
    }

    let cleanRecipeId = null
    let cleanTitle = ''

    if (
      recipeId !== null &&
      recipeId !== undefined &&
      recipeId !== ''
    ) {
      const parsedRecipeId =
        Number(recipeId)

      if (
        !Number.isInteger(parsedRecipeId) ||
        parsedRecipeId <= 0
      ) {
        return response.status(400).json({
          error: 'Invalid recipe.',
        })
      }

      const recipe = database
        .prepare(`
          SELECT id, name
          FROM recipes
          WHERE id = ?
        `)
        .get(parsedRecipeId)

      if (!recipe) {
        return response.status(404).json({
          error: 'Recipe not found.',
        })
      }

      cleanRecipeId = parsedRecipeId
      cleanTitle = recipe.name
    } else {
      if (
        typeof title !== 'string' ||
        title.trim().length === 0 ||
        title.trim().length > 200
      ) {
        return response.status(400).json({
          error: 'Enter a meal name.',
        })
      }

      cleanTitle = title.trim()
    }

    const cleanNotes =
      cleanOptionalText(notes, 1000)

    let cleanItemId = null

if (
  itemId !== null &&
  itemId !== undefined &&
  itemId !== ''
) {
  const parsedItemId =
    Number(itemId)

  if (
    !Number.isInteger(parsedItemId) ||
    parsedItemId <= 0
  ) {
    return response.status(400).json({
      error: 'Invalid meal plan item.',
    })
  }

  const editingItem = database
    .prepare(`
      SELECT id
      FROM meal_plan_items
      WHERE id = ?
    `)
    .get(parsedItemId)

  if (!editingItem) {
    return response.status(404).json({
      error: 'Meal plan item not found.',
    })
  }

  cleanItemId = parsedItemId
}

const existingSlot = database
  .prepare(`
    SELECT id
    FROM meal_plan_items
    WHERE
      date = ?
      AND meal_type = ?
  `)
  .get(date, mealType)

if (
  existingSlot &&
  existingSlot.id !== cleanItemId
) {
  return response.status(409).json({
    error: 'That meal slot is already filled.',
  })
}

if (cleanItemId !== null) {
  database
    .prepare(`
      UPDATE meal_plan_items
      SET
        date = ?,
        meal_type = ?,
        recipe_id = ?,
        title = ?,
        notes = ?
      WHERE id = ?
    `)
    .run(
      date,
      mealType,
      cleanRecipeId,
      cleanTitle,
      cleanNotes,
      cleanItemId
    )
} else {
  database
    .prepare(`
      INSERT INTO meal_plan_items (
        date,
        meal_type,
        recipe_id,
        title,
        notes
      )
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      date,
      mealType,
      cleanRecipeId,
      cleanTitle,
      cleanNotes
    )
}

    const savedItem = database
      .prepare(`
        SELECT
          meal_plan_items.id,
          meal_plan_items.date,
          meal_plan_items.meal_type AS mealType,
          meal_plan_items.recipe_id AS recipeId,
          meal_plan_items.title,
          meal_plan_items.notes,
          meal_plan_items.created_at AS createdAt,
          recipes.image AS recipeImage
        FROM meal_plan_items
        LEFT JOIN recipes
          ON recipes.id = meal_plan_items.recipe_id
        WHERE
          meal_plan_items.date = ?
          AND meal_plan_items.meal_type = ?
      `)
      .get(date, mealType)

    response.json(savedItem)
  }
)

app.delete(
  '/api/meal-plan-items/:date/:mealType',
  (request, response) => {
    const date = request.params.date
    const mealType =
      request.params.mealType

    const allowedMealTypes = [
      'breakfast',
      'lunch',
      'dinner',
      'snack',
    ]

    if (
      !isValidDate(date) ||
      !allowedMealTypes.includes(mealType)
    ) {
      return response.status(400).json({
        error: 'Invalid meal plan date or meal type.',
      })
    }

    const result = database
      .prepare(`
        DELETE FROM meal_plan_items
        WHERE
          date = ?
          AND meal_type = ?
      `)
      .run(date, mealType)

    response.json({
      success: true,
      deleted: result.changes,
    })
  }
)

app.get('/api/events', (request, response) => {
  const statement = database.prepare(`
    SELECT
  id,
  date,
end_date AS endDate,
title,
time,
end_time AS endTime,
person,
     notes,
     location,
batch_id AS batchId,
repeat_unit AS repeatUnit, 
      repeat_interval AS repeatInterval,
      repeat_end_type AS repeatEndType,
      repeat_end_date AS repeatEndDate,
      repeat_count AS repeatCount
    FROM events
    ORDER BY date, time, id
  `)

 const events = statement.all().map((event) => ({
  ...event,
  people: getPeopleForEvent(event.id),
  exceptions: getExceptionsForEvent(event.id),
}))

  response.json(events)
})

app.post(
  '/api/events/:id/exceptions',
  (request, response) => {
    const id = Number(request.params.id)
    const { occurrenceDate } = request.body

    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      !isValidDate(occurrenceDate)
    ) {
      return response.status(400).json({
        error: 'Invalid event exception.',
      })
    }

    const calendarEvent = database
      .prepare(`
        SELECT
          id,
          date,
          repeat_unit AS repeatUnit
        FROM events
        WHERE id = ?
      `)
      .get(id)

    if (!calendarEvent) {
      return response.status(404).json({
        error: 'Event not found.',
      })
    }

    if (!calendarEvent.repeatUnit) {
      return response.status(400).json({
        error:
          'Exceptions can only be added to recurring events.',
      })
    }

    if (occurrenceDate < calendarEvent.date) {
      return response.status(400).json({
        error:
          'The exception date cannot be before the series starts.',
      })
    }

    database
      .prepare(`
        INSERT OR IGNORE INTO event_exceptions (
          event_id,
          occurrence_date
        )
        VALUES (?, ?)
      `)
      .run(id, occurrenceDate)

    response.status(201).json({
      success: true,
      eventId: id,
      occurrenceDate,
    })
  }
)
app.post('/api/events', (request, response) => {
 const {
  date,
  endDate,
  title,
  time,
  endTime,
  person,
  notes,
  location,
  personIds,
  batchId,
} = request.body

  if (!isValidDate(date) || !isValidTitle(title)) {
    return response.status(400).json({
      error: 'A valid date and event title are required.',
    })
  }

  const requestedPeople = getRequestedPeople(
    personIds,
    person
  )

  if (requestedPeople === null) {
    return response.status(400).json({
      error: 'One or more selected people are invalid.',
    })
  }

  const repeatRule = getRepeatRule(
    request.body,
    date
  )

  if (repeatRule === null) {
    return response.status(400).json({
      error: 'The recurring event settings are invalid.',
    })
  }

 const cleanTitle = title.trim()
const cleanTime = cleanOptionalText(time, 20)
const cleanEndTime =
  cleanOptionalText(endTime, 20)
const cleanNotes = cleanOptionalText(notes, 1000)
const cleanLocation =
  cleanOptionalText(location, 300)
const cleanBatchId = cleanOptionalText(batchId, 100)
const cleanEndDate = cleanOptionalText(endDate, 10)

if (
  cleanEndDate !== null &&
  (
    !isValidDate(cleanEndDate) ||
    cleanEndDate < date
  )
) {
  return response.status(400).json({
    error: 'The event end date is invalid.',
  })
}

  const legacyPerson =
    requestedPeople.length > 0
      ? requestedPeople[0].name
      : null

  database.exec('BEGIN')

  try {
    const statement = database.prepare(`
    INSERT INTO events (
  date,
  end_date,
  title,
  time,
  end_time,
  person,
  notes,
  location,
  batch_id,
  repeat_unit,
  repeat_interval,
  repeat_end_type,
  repeat_end_date,
  repeat_count
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)

   const result = statement.run(
  date,
  cleanEndDate,
  cleanTitle,
  cleanTime,
  cleanEndTime,
  legacyPerson,
cleanNotes,
cleanLocation,
cleanBatchId,
      repeatRule.repeatUnit,
      repeatRule.repeatInterval,
      repeatRule.repeatEndType,
      repeatRule.repeatEndDate,
      repeatRule.repeatCount
    )

    const eventId = Number(result.lastInsertRowid)

    const linkStatement = database.prepare(`
      INSERT INTO event_people (
        event_id,
        person_id
      )
      VALUES (?, ?)
    `)

    for (const selectedPerson of requestedPeople) {
      linkStatement.run(
        eventId,
        selectedPerson.id
      )
    }

    database.exec('COMMIT')

   response.status(201).json({
  id: eventId,
  date,
  endDate: cleanEndDate,
  title: cleanTitle,
      time: cleanTime,
      endTime: cleanEndTime,
      person: legacyPerson,
      notes: cleanNotes,
      location: cleanLocation,
      batchId: cleanBatchId,
      people: requestedPeople,
      ...repeatRule,
    })
 } catch (error) {
  database.exec('ROLLBACK')

  console.error('POST /api/events failed:', error)

  response.status(500).json({
    error: 'Could not save the event.',
  })
}
})

app.delete(
  '/api/events/:id/exceptions/:occurrenceDate',
  (request, response) => {
    const id = Number(request.params.id)
    const occurrenceDate =
      request.params.occurrenceDate

    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      !isValidDate(occurrenceDate)
    ) {
      return response.status(400).json({
        error: 'Invalid event exception.',
      })
    }

    const result = database
      .prepare(`
        DELETE FROM event_exceptions
        WHERE event_id = ?
          AND occurrence_date = ?
      `)
      .run(id, occurrenceDate)

    response.json({
      success: true,
      deleted: result.changes,
    })
  }
)
app.put('/api/events/:id', (request, response) => {
  const id = Number(request.params.id)

 const {
  date,
  endDate,
  title,
  time,
  endTime,
  person,
  notes,
  location,
  personIds,
} = request.body

  if (
    !Number.isInteger(id) ||
    id <= 0 ||
    !isValidDate(date) ||
    !isValidTitle(title)
  ) {
    return response.status(400).json({
      error: 'Invalid event information.',
    })
  }

  const existingEvent = database
    .prepare(`
      SELECT id
      FROM events
      WHERE id = ?
    `)
    .get(id)

  if (!existingEvent) {
    return response.status(404).json({
      error: 'Event not found.',
    })
  }

  const requestedPeople = getRequestedPeople(
    personIds,
    person
  )

  if (requestedPeople === null) {
    return response.status(400).json({
      error: 'One or more selected people are invalid.',
    })
  }

  const repeatRule = getRepeatRule(
    request.body,
    date
  )

  if (repeatRule === null) {
    return response.status(400).json({
      error: 'The recurring event settings are invalid.',
    })
  }

 const cleanTitle = title.trim()
const cleanTime = cleanOptionalText(time, 20)
const cleanEndTime =
  cleanOptionalText(endTime, 20)
const cleanNotes = cleanOptionalText(notes, 1000)
const cleanLocation =
  cleanOptionalText(location, 300)
const cleanEndDate = cleanOptionalText(endDate, 10)

if (
  cleanEndDate !== null &&
  (
    !isValidDate(cleanEndDate) ||
    cleanEndDate < date
  )
) {
  return response.status(400).json({
    error: 'The event end date is invalid.',
  })
}

  const legacyPerson =
    requestedPeople.length > 0
      ? requestedPeople[0].name
      : null

  database.exec('BEGIN')

  try {
    database
      .prepare(`
        UPDATE events
       SET
  date = ?,
  end_date = ?,
  title = ?,
  time = ?,
  end_time = ?,
  person = ?,
          notes = ?,
          location = ?,
          repeat_unit = ?,
          repeat_interval = ?,
          repeat_end_type = ?,
          repeat_end_date = ?,
          repeat_count = ?
        WHERE id = ?
      `)
      .run(
  date,
  cleanEndDate,
  cleanTitle,
  cleanTime,
  cleanEndTime,
  legacyPerson,
        cleanNotes,
        cleanLocation,
        repeatRule.repeatUnit,
        repeatRule.repeatInterval,
        repeatRule.repeatEndType,
        repeatRule.repeatEndDate,
        repeatRule.repeatCount,
        id
      )

    database
      .prepare(`
        DELETE FROM event_people
        WHERE event_id = ?
      `)
      .run(id)

    const linkStatement = database.prepare(`
      INSERT INTO event_people (
        event_id,
        person_id
      )
      VALUES (?, ?)
    `)

    for (const selectedPerson of requestedPeople) {
      linkStatement.run(
        id,
        selectedPerson.id
      )
    }

    database.exec('COMMIT')

   response.json({
  id,
  date,
  endDate: cleanEndDate,
  title: cleanTitle,
      time: cleanTime,
endTime: cleanEndTime,
person: legacyPerson,
      notes: cleanNotes,
      location: cleanLocation,
      people: requestedPeople,
      ...repeatRule,
    })
 } catch (error) {
  database.exec('ROLLBACK')

  console.error('PUT /api/events failed:', error)

  response.status(500).json({
    error: 'Could not update the event.',
  })
}
})

app.post('/api/ai/reschedule-confirmed', (request, response) => {
  const eventId = Number(request.body?.eventId)
  const confirmed = request.body?.confirm === true

  const hasNewDate = Object.prototype.hasOwnProperty.call(
    request.body ?? {},
    'newDate'
  )

  const hasNewTime = Object.prototype.hasOwnProperty.call(
    request.body ?? {},
    'newTime'
  )

  if (!confirmed) {
    return response.status(400).json({
      error: 'Rescheduling confirmation is required.',
    })
  }

  if (
    !Number.isInteger(eventId) ||
    eventId <= 0 ||
    (!hasNewDate && !hasNewTime)
  ) {
    return response.status(400).json({
      error: 'Invalid rescheduling request.',
    })
  }

  const event = database
    .prepare(`
      SELECT
        id,
        date,
        time,
        end_date AS endDate,
        end_time AS endTime,
        repeat_unit AS repeatUnit
      FROM events
      WHERE id = ?
    `)
    .get(eventId)

  if (!event) {
    return response.status(404).json({
      error: 'Event not found.',
    })
  }

  if (
    event.repeatUnit !== null ||
    event.endDate !== null
  ) {
    return response.status(409).json({
      error:
        'Recurring and multi-day event rescheduling is not supported yet.',
    })
  }

  const newDate = hasNewDate
    ? request.body.newDate
    : event.date

  const newTime = hasNewTime
    ? request.body.newTime
    : event.time

  if (
    !isValidDate(newDate) ||
    (
      hasNewTime &&
      (
        typeof newTime !== 'string' ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(newTime)
      )
    )
  ) {
    return response.status(400).json({
      error: 'Invalid new date or time.',
    })
  }

  if (
    hasNewTime &&
    newTime !== event.time &&
    event.endTime !== null
  ) {
    return response.status(409).json({
      error:
        'Changing the start time of an event with an end time is not supported yet.',
    })
  }

  if (
    newDate === event.date &&
    newTime === event.time
  ) {
    return response.status(400).json({
      error: 'The event already has that date and time.',
    })
  }

  database
    .prepare(`
      UPDATE events
      SET date = ?, time = ?
      WHERE id = ?
    `)
    .run(newDate, newTime, eventId)

  response.json({
    success: true,
    eventId,
    previous: {
      date: event.date,
      time: event.time,
    },
    updated: {
      date: newDate,
      time: newTime,
    },
  })
})

app.delete('/api/event-batches/:batchId', (request, response) => {
  const batchId = request.params.batchId

  if (
    typeof batchId !== 'string' ||
    batchId.trim().length === 0 ||
    batchId.trim().length > 100
  ) {
    return response.status(400).json({
      error: 'Invalid event batch ID.',
    })
  }

  const result = database
    .prepare(`
      DELETE FROM events
      WHERE batch_id = ?
    `)
    .run(batchId.trim())

  if (result.changes === 0) {
    return response.status(404).json({
      error: 'Event batch not found.',
    })
  }

  response.json({
    success: true,
    deleted: result.changes,
  })
})
app.delete('/api/events/:id', (request, response) => {
  const id = Number(request.params.id)

  if (!Number.isInteger(id) || id <= 0) {
    return response.status(400).json({
      error: 'Invalid event ID.',
    })
  }

  const statement = database.prepare(`
    DELETE FROM events
    WHERE id = ?
  `)

  const result = statement.run(id)

  if (result.changes === 0) {
    return response.status(404).json({
      error: 'Event not found.',
    })
  }

  response.json({
    success: true,
  })
})

app.get('/api/people', (request, response) => {
  const people = database
    .prepare(`
      SELECT id, name, color, image
      FROM people
      ORDER BY sort_order, id
    `)
    .all()

  response.json(people)
})

app.post(
  '/api/people',
  avatarUpload.single('image'),
  async (request, response) => {
    const { name, color } = request.body

    if (!isValidPersonName(name) || !isValidColor(color)) {
      if (request.file) {
        deleteStoredImageFile(request.file.filename)
      }

      return response.status(400).json({
        error: 'A valid name and color are required.',
      })
    }

    const cleanName = name.trim()

    let image = null

    if (request.file) {
      try {
        image = await optimizePersonAvatar(
          request.file
        )
      } catch {
        deleteStoredImageFile(
          request.file.filename
        )

        return response.status(500).json({
          error:
            'Could not optimize the person photo.',
        })
      }
    }

    try {
      const nextSortOrder = database
        .prepare(`
          SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextSortOrder
          FROM people
        `)
        .get().nextSortOrder

      const result = database
        .prepare(`
          INSERT INTO people (
            name,
            color,
            image,
            sort_order
          )
          VALUES (?, ?, ?, ?)
        `)
        .run(
          cleanName,
          color,
          image,
          nextSortOrder
        )

      response.status(201).json({
        id: Number(result.lastInsertRowid),
        name: cleanName,
        color,
        image,
      })
    } catch {
      if (image) {
        deleteStoredImageFile(image)
      }

      response.status(409).json({
        error: 'That person already exists.',
      })
    }
  }
)

app.put('/api/people/reorder', (request, response) => {
  const { personIds } = request.body

  if (
    !Array.isArray(personIds) ||
    personIds.length === 0 ||
    personIds.some(
      (personId) =>
        !Number.isInteger(personId) ||
        personId <= 0
    )
  ) {
    return response.status(400).json({
      error: 'A valid person order is required.',
    })
  }

  const uniquePersonIds =
    new Set(personIds)

  if (uniquePersonIds.size !== personIds.length) {
    return response.status(400).json({
      error: 'Person IDs must be unique.',
    })
  }

  const existingPeople = database
    .prepare(`
      SELECT id
      FROM people
    `)
    .all()

  if (
    existingPeople.length !== personIds.length
  ) {
    return response.status(400).json({
      error:
        'The reordered people do not match the saved people.',
    })
  }

  const existingPersonIds =
    new Set(
      existingPeople.map(
        (person) => person.id
      )
    )

  const orderMatchesPeople =
    personIds.every(
      (personId) =>
        existingPersonIds.has(personId)
    )

  if (!orderMatchesPeople) {
    return response.status(400).json({
      error:
        'The reordered people do not match the saved people.',
    })
  }

  const updatePersonOrder =
    database.prepare(`
      UPDATE people
      SET sort_order = ?
      WHERE id = ?
    `)

  database.exec('BEGIN')

  try {
    personIds.forEach(
      (personId, index) => {
        updatePersonOrder.run(
          index,
          personId
        )
      }
    )

    database.exec('COMMIT')

    response.json({
      success: true,
    })
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
})

app.put(
  '/api/people/:id',
  avatarUpload.single('image'),
  async (request, response) => {
    const id = Number(request.params.id)
    const { name, color } = request.body

    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      !isValidPersonName(name) ||
      !isValidColor(color)
    ) {
      if (request.file) {
        deleteStoredImageFile(
          request.file.filename
        )
      }

      return response.status(400).json({
        error: 'Invalid person information.',
      })
    }

    const existingPerson = database
      .prepare(`
        SELECT id, name, color, image
        FROM people
        WHERE id = ?
      `)
      .get(id)

    if (!existingPerson) {
      if (request.file) {
        deleteStoredImageFile(
          request.file.filename
        )
      }

      return response.status(404).json({
        error: 'Person not found.',
      })
    }

    const cleanName = name.trim()
    let nextImage = existingPerson.image
    let optimizedImage = null

    if (request.file) {
      try {
        optimizedImage =
          await optimizePersonAvatar(
            request.file
          )

        nextImage = optimizedImage
      } catch {
        deleteStoredImageFile(
          request.file.filename
        )

        return response.status(500).json({
          error:
            'Could not optimize the person photo.',
        })
      }
    }

    database.exec('BEGIN')

    try {
      database
        .prepare(`
          UPDATE people
          SET name = ?, color = ?, image = ?
          WHERE id = ?
        `)
        .run(
          cleanName,
          color,
          nextImage,
          id
        )

      if (
        existingPerson.name !== cleanName
      ) {
        database
          .prepare(`
            UPDATE events
            SET person = ?
            WHERE person = ?
          `)
          .run(
            cleanName,
            existingPerson.name
          )
      }

      database.exec('COMMIT')

      if (
        optimizedImage &&
        existingPerson.image &&
        existingPerson.image !==
          optimizedImage
      ) {
        deleteStoredImageFile(
          existingPerson.image
        )
      }

      response.json({
        id,
        name: cleanName,
        color,
        image: nextImage,
      })
    } catch {
      database.exec('ROLLBACK')

      if (optimizedImage) {
        deleteStoredImageFile(
          optimizedImage
        )
      }

      response.status(409).json({
        error:
          'That person name is already being used.',
      })
    }
  }
)

app.delete('/api/people/:id', (request, response) => {
  const id = Number(request.params.id)

  if (!Number.isInteger(id) || id <= 0) {
    return response.status(400).json({
      error: 'Invalid person ID.',
    })
  }

  const person = database
    .prepare(`
      SELECT name, image
      FROM people
      WHERE id = ?
    `)
    .get(id)

  if (!person) {
    return response.status(404).json({
      error: 'Person not found.',
    })
  }

  database
    .prepare(`
      UPDATE events
      SET person = NULL
      WHERE person = ?
    `)
    .run(person.name)

  database
    .prepare(`
      DELETE FROM people
      WHERE id = ?
    `)
    .run(id)

  if (person.image) {
    deleteStoredImageFile(person.image)
  }

  response.json({
    success: true,
  })
})
app.use((error, request, response, next) => {
  console.error('Express error handler:', error)

  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return response.status(400).json({
        error: 'Image must be 5 MB or smaller.',
      })
    }

    return response.status(400).json({
      error: 'Could not upload the image.',
    })
  }

  if (
    error instanceof Error &&
    error.message === 'Only JPG, PNG, or WebP images are allowed.'
  ) {
    return response.status(400).json({
      error: error.message,
    })
  }
return response.status(500).json({
  error: 'Something went wrong.',
})
})

app.get('/api/lists', (request, response) => {
  const lists = database
    .prepare(`
      SELECT id, name, created_at, store_enabled
      FROM lists
      ORDER BY id
    `)
    .all()

  const itemStatement = database.prepare(`
   SELECT id, list_id, text, completed, created_at, sort_order, category, store_id, store_manual
FROM list_items
WHERE list_id = ?
ORDER BY sort_order, id
  `)

  const result = lists.map((list) => ({
    ...list,
    items: itemStatement.all(list.id).map((item) => ({
      ...item,
      completed: Boolean(item.completed),
      store_manual: Boolean(item.store_manual),
    })),
  }))

  response.json(result)
})

app.post('/api/lists', (request, response) => {
  const { name } = request.body

  if (
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    name.trim().length > 100
  ) {
    return response.status(400).json({
      error: 'A valid list name is required.',
    })
  }

  const cleanName = name.trim()

  const result = database
    .prepare(`
      INSERT INTO lists (name, store_enabled)
      VALUES (?, ?)
    `)
    .run(cleanName, looksLikeShoppingList(cleanName) ? 1 : 0)

  response.status(201).json({
    id: Number(result.lastInsertRowid),
    name: cleanName,
    store_enabled: looksLikeShoppingList(cleanName),
    items: [],
  })
})

// Store settings persist for the whole household. Disabling a store does not
// remove items or their saved manual preferences.
app.get('/api/shopping-stores', (request, response) => {
  response.json(getShoppingStores(database))
})
app.post('/api/shopping-stores', (request, response) => {
  const name = request.body?.name
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 50) {
    return response.status(400).json({ error: 'Store name must be 1–50 characters.' })
  }
  try {
    const max = database.prepare('SELECT COALESCE(MAX(sort_order), 0) AS value FROM shopping_stores').get().value
    const saved = database.prepare('INSERT INTO shopping_stores (name, sort_order) VALUES (?, ?)').run(name.trim(), max + 1)
    return response.status(201).json({ id: Number(saved.lastInsertRowid), name: name.trim(), enabled: true, sort_order: max + 1 })
  } catch {
    return response.status(409).json({ error: 'This store already exists.' })
  }
})
app.put('/api/shopping-stores/:id', (request, response) => {
  const id = Number(request.params.id)
  if (!Number.isSafeInteger(id) || id <= 0) return response.status(400).json({ error: 'Invalid store ID.' })
  const existing = database.prepare('SELECT id FROM shopping_stores WHERE id = ?').get(id)
  if (!existing) return response.status(404).json({ error: 'Store not found.' })
  const { enabled, sort_order } = request.body ?? {}
  if ((enabled !== undefined && typeof enabled !== 'boolean') ||
      (sort_order !== undefined && (!Number.isSafeInteger(sort_order) || sort_order < 0 || sort_order > 100000))) {
    return response.status(400).json({ error: 'Invalid store settings.' })
  }
  database.prepare('UPDATE shopping_stores SET enabled = COALESCE(?, enabled), sort_order = COALESCE(?, sort_order) WHERE id = ?')
    .run(enabled === undefined ? null : Number(enabled), sort_order ?? null, id)
  return response.json(getShoppingStores(database).find(store => store.id === id))
})
app.put('/api/lists/:id/store-sorting', (request, response) => {
  const listId = Number(request.params.id)
  if (!Number.isSafeInteger(listId) || listId <= 0 || typeof request.body?.enabled !== 'boolean') {
    return response.status(400).json({ error: 'Invalid store sorting settings.' })
  }
  const result = database.prepare('UPDATE lists SET store_enabled = ? WHERE id = ?').run(Number(request.body.enabled), listId)
  if (!result.changes) return response.status(404).json({ error: 'List not found.' })
  if (request.body.enabled) { organizeExistingListItems(database, listId); organizeShoppingStores(database, listId) }
  return response.json({ store_enabled: request.body.enabled })
})
app.post('/api/lists/:id/sort-stores', async (request, response) => {
  const listId = Number(request.params.id)
  if (!Number.isSafeInteger(listId) || listId <= 0) return response.status(400).json({ error: 'Invalid list ID.' })
  // First use learned preferences and deterministic offline rules; AI is only
  // requested explicitly for the remaining ambiguous items.
  organizeExistingListItems(database, listId)
  const baseline = organizeShoppingStores(database, listId)
  if (!baseline) return response.status(404).json({ error: 'List not found.' })
  if (baseline.disabled) return response.status(400).json({ error: 'Enable store sorting for this list first.' })
  const ai = request.body?.askArney === true
    ? await sortUnknownStoresWithOllama(database, listId, OLLAMA_URL, LOCAL_AI_MODEL)
    : { aiSorted: 0, aiAvailable: null }
  return response.json({ ...baseline, ...ai })
})

// On-demand, conservative organizer for existing items in one selected list.
app.post('/api/lists/:id/organize', (request, response) => {
  const listId = Number(request.params.id)
  if (!Number.isSafeInteger(listId) || listId <= 0) {
    return response.status(400).json({ error: 'Invalid list ID.' })
  }
  const result = organizeExistingListItems(database, listId)
  if (result === null) {
    return response.status(404).json({ error: 'List not found.' })
  }
  return response.json(result)
})

app.delete('/api/lists/:id', (request, response) => {
  const id = Number(request.params.id)

  if (!Number.isInteger(id) || id <= 0) {
    return response.status(400).json({
      error: 'Invalid list ID.',
    })
  }

  const result = database
    .prepare(`
      DELETE FROM lists
      WHERE id = ?
    `)
    .run(id)

  if (result.changes === 0) {
    return response.status(404).json({
      error: 'List not found.',
    })
  }

  response.json({
    success: true,
  })
})

app.post('/api/lists/:id/items', (request, response) => {
  const listId = Number(request.params.id)
  const { text, category: rawCategory } = request.body
  let category
  try {
    category = rawCategory === undefined
      ? (suggestListCategory(text) ?? 'General')
      : normalizeListCategory(rawCategory)
  } catch {
    return response.status(400).json({ error: 'Invalid list item category.' })
  }

  if (
    !Number.isInteger(listId) ||
    listId <= 0 ||
    typeof text !== 'string' ||
    text.trim().length === 0 ||
    text.trim().length > 200
  ) {
    return response.status(400).json({
      error: 'A valid list and item are required.',
    })
  }

  const list = database
    .prepare(`
      SELECT id, store_enabled
      FROM lists
      WHERE id = ?
    `)
    .get(listId)

  if (!list) {
    return response.status(404).json({
      error: 'List not found.',
    })
  }

  const cleanText = text.trim()

 const orderResult = database
  .prepare(`
    SELECT COALESCE(MAX(sort_order), 0) AS max_order
    FROM list_items
    WHERE list_id = ?
  `)
  .get(listId)

const nextSortOrder = Number(orderResult.max_order) + 1

const result = database
  .prepare(`
    INSERT INTO list_items (list_id, text, sort_order, category, store_id)
    VALUES (?, ?, ?, ?, ?)
  `)
  .run(listId, cleanText, nextSortOrder, category, list.store_enabled ? suggestShoppingStoreId(database, cleanText, category) : null)

  response.status(201).json({
    id: Number(result.lastInsertRowid),
    list_id: listId,
    text: cleanText,
    completed: false,
    sort_order: nextSortOrder,
    category,
    store_id: list.store_enabled ? suggestShoppingStoreId(database, cleanText, category) : null,
    store_manual: false,
  })
})

app.put('/api/list-items/:id', (request, response) => {
  const id = Number(request.params.id)
  const { text, completed, category: rawCategory, store_id: rawStoreId } = request.body

  if (!Number.isInteger(id) || id <= 0) {
    return response.status(400).json({
      error: 'Invalid list item ID.',
    })
  }

  const existingItem = database
    .prepare(`
      SELECT id, list_id, text, completed, category, store_id, store_manual
      FROM list_items
      WHERE id = ?
    `)
    .get(id)

  if (!existingItem) {
    return response.status(404).json({
      error: 'List item not found.',
    })
  }

  const nextText =
    typeof text === 'string' && text.trim().length > 0
      ? text.trim().slice(0, 200)
      : existingItem.text

  const nextCompleted =
    typeof completed === 'boolean'
      ? completed
        ? 1
        : 0
      : existingItem.completed

  let nextCategory = existingItem.category
  if (rawCategory !== undefined) {
    try {
      nextCategory = normalizeListCategory(rawCategory)
    } catch {
      return response.status(400).json({ error: 'Invalid list item category.' })
    }
  }

  let nextStoreId = existingItem.store_id
  if (Object.hasOwn(request.body, 'store_id')) {
    try { nextStoreId = requireStoreId(database, rawStoreId) } catch {
      return response.status(400).json({ error: 'Invalid shopping store.' })
    }
    saveShoppingStoreCorrection(database, id, nextStoreId)
  } else if (!existingItem.store_manual && (nextText !== existingItem.text || nextCategory !== existingItem.category)) {
    const list = database.prepare('SELECT store_enabled FROM lists WHERE id = ?').get(existingItem.list_id)
    nextStoreId = list?.store_enabled ? suggestShoppingStoreId(database, nextText, nextCategory) : null
    database.prepare('UPDATE list_items SET store_id = ? WHERE id = ?').run(nextStoreId, id)
  }
  database
    .prepare(`
      UPDATE list_items
      SET text = ?, completed = ?, category = ?
      WHERE id = ?
    `)
    .run(nextText, nextCompleted, nextCategory, id)

  // A manual selection should be learned under the final edited item name.
  if (Object.hasOwn(request.body, 'store_id') && nextText !== existingItem.text) {
    const key = nextText.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 200)
    if (key) database.prepare('INSERT INTO shopping_store_preferences (item_key, store_id) VALUES (?, ?) ON CONFLICT(item_key) DO UPDATE SET store_id = excluded.store_id').run(key, nextStoreId)
  }

  response.json({
    id,
    list_id: existingItem.list_id,
    text: nextText,
    completed: Boolean(nextCompleted),
    category: nextCategory,
    store_id: nextStoreId,
    store_manual: Object.hasOwn(request.body, 'store_id') ? true : Boolean(existingItem.store_manual),
  })
})
app.put('/api/lists/:id/reorder', (request, response) => {
  const listId = Number(request.params.id)
  const { itemIds } = request.body

  if (
    !Number.isInteger(listId) ||
    listId <= 0 ||
    !Array.isArray(itemIds) ||
    itemIds.some(
      (id) => !Number.isInteger(id) || id <= 0
    )
  ) {
    return response.status(400).json({
      error: 'Invalid reorder request.',
    })
  }

  const existingItems = database
    .prepare(`
      SELECT id
      FROM list_items
      WHERE list_id = ?
      ORDER BY sort_order, id
    `)
    .all(listId)

  const existingIds = existingItems.map((item) => item.id)

  const submittedIds = [...new Set(itemIds)]

  if (
    submittedIds.length !== existingIds.length ||
    submittedIds.some((id) => !existingIds.includes(id))
  ) {
    return response.status(400).json({
      error: 'The reordered items do not match this list.',
    })
  }

  const updateStatement = database.prepare(`
    UPDATE list_items
    SET sort_order = ?
    WHERE id = ? AND list_id = ?
  `)

  database.exec('BEGIN')

  try {
    submittedIds.forEach((itemId, index) => {
      updateStatement.run(index + 1, itemId, listId)
    })

    database.exec('COMMIT')

    response.json({
      success: true,
    })
  } catch {
    database.exec('ROLLBACK')

    response.status(500).json({
      error: 'Could not save the new item order.',
    })
  }
})
app.delete('/api/lists/:id/completed', (request, response) => {
  const listId = Number(request.params.id)

  if (!Number.isInteger(listId) || listId <= 0) {
    return response.status(400).json({
      error: 'Invalid list ID.',
    })
  }

  const result = database
    .prepare(`
      DELETE FROM list_items
      WHERE list_id = ?
        AND completed = 1
    `)
    .run(listId)

  response.json({
    success: true,
    deleted: result.changes,
  })
})
app.delete('/api/list-items/:id', (request, response) => {
  const id = Number(request.params.id)

  if (!Number.isInteger(id) || id <= 0) {
    return response.status(400).json({
      error: 'Invalid list item ID.',
    })
  }

  const result = database
    .prepare(`
      DELETE FROM list_items
      WHERE id = ?
    `)
    .run(id)

  if (result.changes === 0) {
    return response.status(404).json({
      error: 'List item not found.',
    })
  }

  response.json({
    success: true,
  })
})
app.use('/uploads', express.static(uploadFolder))
app.use(express.static(distFolder))

app.get(/.*/, (request, response) => {
  response.sendFile(path.join(distFolder, 'index.html'))
})

app.listen(PORT, HOST, () => {
  console.log(`Family Calendar server running at http://127.0.0.1:${PORT}`)
})
