// PURE, SOURCE-ONLY Windows TEST scheduler collision review.
// This module only compares SANITIZED caller-supplied Task Scheduler snapshots.
// It neither reads a host nor disables, stops, runs or installs any task.
// Hashes of Actions, Principal and Triggers detect definition drift, but do
// NOT independently attest that watchdog code excludes the old TEST backend.
// A matching review NEVER grants permission to switch a site or restore data.
const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const SITE = 'existing-secure-test'
const REQUIRED = Object.freeze([
  'Family Calendar Server',
  'Family Calendar Ollama Server',
  'Family Calendar Watchdog',
  'Family Calendar Secure TEST',
  'Family Calendar Secure TEST Auto Deploy',
  'Family Calendar Auto Deploy',
])
const TEST_TASKS = new Set([
  'Family Calendar Secure TEST', 'Family Calendar Secure TEST Auto Deploy',
])
const NEVER_DISABLE = new Set([
  'Family Calendar Server', 'Family Calendar Ollama Server',
  'Family Calendar Watchdog',
])
const VALID_STATES = new Set(['Running','Ready','Disabled'])
const INSTANCES = new Set(['IgnoreNew','Parallel','Queue','StopExisting'])
const PROTECTED_NAMES = /(\btest\b|\blive\b|watchdog|auto\s+deploy|supervisor|ollama\s+server|calendar\s+server)/i
function refuse(message) {
  throw new Error('Phase 1 Windows task-fencing review refused: ' + message)
}
function asMap(snapshot, stage, testSha) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) ||
      snapshot.schemaVersion !== 1 || snapshot.site !== SITE ||
      snapshot.stage !== stage || snapshot.enumerationSucceeded !== true ||
      snapshot.installedTestSha !== testSha || !SHA.test(testSha) ||
      !Array.isArray(snapshot.tasks) || snapshot.tasks.length < REQUIRED.length ||
      snapshot.tasks.length > 128) {
    refuse('complete pinned sanitized task inventory required.')
  }
  const map = new Map()
  for (const task of snapshot.tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task) ||
        !/^Family Calendar(?:[ -][a-zA-Z0-9 -]+)?$/.test(task.name ?? '') ||
        task.path !== '\\' ||
        !VALID_STATES.has(task.state) ||
        typeof task.enabled !== 'boolean' ||
        task.enabled !== (task.state !== 'Disabled') ||
        !HASH.test(task.actionDigest) ||
        !HASH.test(task.principalDigest) ||
        !HASH.test(task.triggerDigest) ||
        !Number.isSafeInteger(task.triggerCount) || task.triggerCount < 0 ||
        !Number.isSafeInteger(task.restartCount) || task.restartCount < 0 ||
        !INSTANCES.has(task.multipleInstances)) {
      refuse('one Task Scheduler definition is incomplete or ambiguous.')
    }
    const key = task.name.toLowerCase()
    if (map.has(key)) refuse('duplicate case-insensitive task names.')
    map.set(key, Object.freeze({...task}))
  }
  for (const name of REQUIRED) {
    if (!map.has(name.toLowerCase())) refuse('a protected LIVE/TEST task is missing.')
  }
  for (const task of map.values()) {
    if (PROTECTED_NAMES.test(task.name) && !REQUIRED.includes(task.name)) {
      refuse('unreviewed additional task may collide with TEST or LIVE.')
    }
  }
  return map
}
function normalized(tasks) {
  return [...tasks.entries()].sort(([a],[b]) => a.localeCompare(b))
}
function shape(task) {
  return JSON.stringify([
    task.name, task.path, task.actionDigest, task.principalDigest,
    task.triggerDigest, task.triggerCount, task.restartCount,
    task.multipleInstances,
  ])
}
function checkedBaseline(map) {
  for (const name of REQUIRED) {
    const task=map.get(name.toLowerCase())
    if (name === 'Family Calendar Auto Deploy') {
      if (task.state !== 'Disabled') refuse('LIVE auto-deploy must remain disabled.')
    } else if (!task.enabled || !['Ready','Running'].includes(task.state)) {
      refuse('unexpected baseline protected task state.')
    }
  }
  for (const name of TEST_TASKS) {
    const task = map.get(name.toLowerCase())
    if (task.multipleInstances !== 'IgnoreNew' || task.triggerCount < 1) {
      refuse('TEST scheduler replay prevention and triggers require review.')
    }
  }
}
function reviewedTransition(baseline, fenced) {
  const blockers = []
  const b = normalized(baseline)
  const f = normalized(fenced)
  if (b.length !== f.length ||
      b.some(([key], i) => key !== f[i]?.[0])) {
    blockers.push('Task set changed while preparing the TEST handoff.')
  }
  for (const [name, initial] of b) {
    const current = fenced.get(name)
    if (!current) continue
    if (shape(initial) !== shape(current)) {
      blockers.push('A task definition, principal or trigger changed.')
    }
    if (TEST_TASKS.has(initial.name)) {
      if (current.enabled || current.state !== 'Disabled') {
        blockers.push('Legacy TEST starter or auto-deployer remains enabled.')
      }
    } else if (current.enabled !== initial.enabled ||
        current.state !== initial.state) {
      blockers.push('LIVE, watchdog or unrelated scheduler task state changed.')
    }
  }
  for (const name of NEVER_DISABLE) {
    const t=fenced.get(name.toLowerCase())
    if (!t?.enabled) blockers.push('A protected LIVE or shared watchdog task is disabled.')
  }
  return [...new Set(blockers)]
}
/**
 * 'fenced' means scheduled tasks appear disabled, NOT that the legacy TEST
 * process exited, watchdog code cannot relaunch it, SQLite is quiescent,
 * direct 13002 is closed, or a private route is ready. Those need independent
 * OS/process/task-action reviews and the separate network/backup gate.
 */
export function assessPrivatePhase1WindowsTaskFencing({
  baseline, maintenance, expectedInstalledTestSha,
}) {
  if (!SHA.test(expectedInstalledTestSha)) {
    refuse('an exact installed TEST commit is required.')
  }
  const before = asMap(baseline, 'baseline', expectedInstalledTestSha)
  checkedBaseline(before)
  const after = asMap(maintenance, 'maintenance-fenced',
    expectedInstalledTestSha)
  const blockers = reviewedTransition(before, after)
  return Object.freeze({
    kind:'phase1-windows-test-task-fencing-evidence-v1',
    installedTestSha:expectedInstalledTestSha,
    protectedTaskCount:REQUIRED.length,
    observedTaskStatesMatch:blockers.length===0,
    blockers:Object.freeze(blockers),
    legacyTestTaskDisabledOnReportedSnapshot:
      after.get('family calendar secure test')?.state==='Disabled',
    legacyTestAutoDeployDisabledOnReportedSnapshot:
      after.get('family calendar secure test auto deploy')?.state==='Disabled',
    taskActionDefinitionAttestedByOperator:false,
    watchdogTestRestartExcludedByCodeReview:false,
    installedLegacyProcessStopped:false,
    installedLegacyBackendPortClosed:false,
    sqliteWritersQuiesced:false,
    liveIsolationVerified:false,
    backupAndRollbackVerified:false,
    safeToCutover:false,
    testDeploymentAuthorized:false,
    liveDeploymentAuthorized:false,
    windowsTasksModified:false,
  })
}
