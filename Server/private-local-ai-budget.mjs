// PRIVATE MULTI-HOUSEHOLD TEST GATEWAY ONLY.
//
// This enforces a separate hard monthly REQUEST-COUNT allowance for local
// read-only Ollama classification for each household. It is not a dollar,
// token or paid/cloud API spending cap. No inference is allowed until a
// trusted administrator explicitly configures a positive per-household limit.
//
// SQLite atomic reservation prevents simultaneous devices from racing past
// the cap. An attempt is charged even when Ollama fails or the client leaves,
// because CPU/GPU work may already have started. No browser may set a budget,
// household ID or reset usage. Periods are calendar months in UTC.
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

function registered(db, slug) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    throw new Error('Untrusted local AI household.')
  }
  const result = db.prepare([
    'SELECT id FROM household_registry WHERE storage_id=? AND disabled=0',
  ].join(' ')).get(slug)
  if (!result) throw new Error('Private AI household not active.')
  return result.id
}

function periodFor(at) {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new Error('Invalid local AI usage period.')
  }
  return at.toISOString().slice(0,7)
}

export function createPrivateLocalAiBudgetTables(db) {
  db.exec([
    'CREATE TABLE IF NOT EXISTS private_local_ai_limits (',
    'household_id INTEGER PRIMARY KEY REFERENCES household_registry(id),',
    'monthly_request_limit INTEGER NOT NULL DEFAULT 0',
    'CHECK(monthly_request_limit BETWEEN 0 AND 1000)',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS private_local_ai_usage (',
    'household_id INTEGER NOT NULL REFERENCES household_registry(id),',
    'period_utc TEXT NOT NULL,',
    'used_requests INTEGER NOT NULL DEFAULT 0 CHECK(used_requests >= 0),',
    'PRIMARY KEY (household_id,period_utc)',
    ') STRICT;',
  ].join('\n'))
}

// Server-only configuration, not an API route. Defaults to disabled.
export function setPrivateLocalAiMonthlyLimit(db, {
  householdId, monthlyLimit,
}) {
  const id = registered(db, householdId)
  if (!Number.isSafeInteger(monthlyLimit) ||
      monthlyLimit < 0 || monthlyLimit > 1000) {
    throw new Error('Invalid local AI monthly request limit.')
  }
  db.prepare([
    'INSERT INTO private_local_ai_limits (household_id,monthly_request_limit)',
    'VALUES (?,?) ON CONFLICT(household_id) DO UPDATE SET',
    'monthly_request_limit=excluded.monthly_request_limit',
  ].join(' ')).run(id, monthlyLimit)
}

export function privateLocalAiBudgetStatus(db, {
  householdId, at = new Date(),
}) {
  const id = registered(db, householdId)
  const period = periodFor(at)
  const limit = db.prepare(
    'SELECT monthly_request_limit AS n FROM private_local_ai_limits WHERE household_id=?'
  ).get(id)?.n ?? 0
  const used = db.prepare([
    'SELECT used_requests AS n FROM private_local_ai_usage',
    'WHERE household_id=? AND period_utc=?',
  ].join(' ')).get(id, period)?.n ?? 0
  return { periodUtc: period, monthlyRequestLimit: limit,
    usedRequests: used, remainingRequests: Math.max(0, limit-used) }
}

export function reservePrivateLocalAiRequest(db, {
  householdId, at = new Date(),
}) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const status = privateLocalAiBudgetStatus(db, { householdId, at })
    if (status.remainingRequests === 0) {
      db.exec('COMMIT')
      return { allowed: false, ...status }
    }
    const id = registered(db, householdId)
    db.prepare([
      'INSERT INTO private_local_ai_usage',
      '(household_id,period_utc,used_requests)',
      'VALUES (?,?,1) ON CONFLICT(household_id,period_utc)',
      'DO UPDATE SET used_requests=used_requests+1',
    ].join(' ')).run(id, status.periodUtc)
    const updated = privateLocalAiBudgetStatus(db, { householdId, at })
    db.exec('COMMIT')
    return { allowed: true, ...updated }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
