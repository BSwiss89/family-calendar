// Client-side display only. Every operation is re-authorized by the private
// gateway using the authenticated central session and operator allowlist.
// All account/household fields are rendered as TEXT, never HTML.
const $ = id => document.getElementById(id)
let busy = false
let activationChecks = new Map()
const linkPrefix = location.origin + '/start-family#token='
const resetPrefix = location.origin + '/reset-password#token='

function setStatus(message, error = false) {
  $('global-status').textContent = message
  $('global-status').classList.toggle('is-error', error)
}
function element(tag, { text, className } = {}) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = String(text)
  if (className) node.className = className
  return node
}
function appendText(parent, tag, content) {
  parent.append(element(tag, { text: content }))
}
function formattedTime(timestamp) {
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleString() : 'Unknown date'
}
function validOneTimeUrl(value, prefix) {
  return typeof value === 'string' && value.startsWith(prefix) &&
    /^[a-f0-9]{64}$/.test(value.slice(prefix.length))
}
async function requestJson(url, body = undefined) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const result = await response.json().catch(() => null)
  if (!response.ok) {
    const message = result && typeof result.error === 'string'
      ? result.error : response.status === 403 ? 'System operator access required.' :
        'Unable to complete administrator action.'
    throw new Error(message)
  }
  return result
}
function setBusy(value) {
  busy = value
  $('create-invite').disabled = value
  $('refresh-button').disabled = value
  document.querySelectorAll('[data-admin-action]').forEach(node => {
    node.disabled = value
  })
}
async function operation(action) {
  if (busy) return
  setBusy(true)
  setStatus('')
  try { await action() }
  catch (error) {
    setStatus(error instanceof Error ? error.message : 'Action failed.', true)
  } finally {
    setBusy(false)
  }
}
async function copyField(id) {
  const input = $(id)
  if (!input || !input.value) return
  try {
    await navigator.clipboard.writeText(input.value)
    setStatus('Private link copied. Share only with its intended recipient.')
  } catch {
    input.focus()
    input.select()
    setStatus('Clipboard blocked. The link has been selected for manual copying.')
  }
}

function householdEntry(household) {
  const row = element('div', { className: 'entry' })
  const info = element('div', { className: 'entry-info' })
  appendText(info, 'strong', household.displayName)
  appendText(info, 'span', 'Owner: ' + (household.ownerDisplayName || 'Unassigned'))
  appendText(info, 'span', household.memberCount + ' enrolled account' +
    (household.memberCount === 1 ? '' : 's'))
  const check = activationChecks.get(household.householdId)
  if (check && check.stage === 'storage-reviewed-awaiting-backend-proof') {
    appendText(info, 'span', 'Storage preflight passed; independent backend, backup and authorization review still required.')
  } else if (check && check.stage === 'blocked-review') {
    appendText(info, 'span', 'Activation on hold: review household storage and Owner records.')
  } else if (check && check.stage === 'approved-awaiting-route') {
    appendText(info, 'span', 'Approved; trusted backend route not configured.')
  } else if (check && check.stage === 'approved-route-configured') {
    appendText(info, 'span', 'Approved and route configured. Online health not confirmed here.')
  }
  const state = element('span', {
    className: 'chip ' + (household.state === 'configured-route'
      ? 'configured' : 'pending'),
    text: household.state === 'configured-route'
      ? 'Route configured (not live-checked)'
      : household.state === 'approved-unrouted'
        ? 'Approved, not routed' : 'Activation pending',
  })
  row.append(info, state)
  return row
}
function inviteEntry(invitation) {
  const row = element('div', { className: 'entry' })
  const info = element('div', { className: 'entry-info' })
  appendText(info, 'strong', 'Invitation #' + invitation.id)
  appendText(info, 'span', 'Expires ' + formattedTime(invitation.expiresAt))
  const controls = element('div', { className: 'entry-actions' })
  const revoke = element('button', { text: 'Revoke link', className: 'danger' })
  revoke.type = 'button'
  revoke.dataset.adminAction = 'revoke'
  revoke.addEventListener('click', () => {
    if (!confirm('Revoke invitation #' + invitation.id + '? The link will stop working.')) return
    void operation(async () => {
      await requestJson('/api/households/independent-invitations/' +
        encodeURIComponent(String(invitation.id)) + '/revoke', {})
      await refresh()
      setStatus('Invitation revoked.')
    })
  })
  controls.append(revoke)
  row.append(info, controls)
  return row
}
function recoveryEntry(item) {
  const row = element('div', { className: 'entry' })
  const info = element('div', { className: 'entry-info' })
  appendText(info, 'strong', item.displayName + ' (@' + item.username + ')')
  appendText(info, 'span', 'Requested ' + formattedTime(item.createdAt))
  appendText(info, 'span', 'Expires ' + formattedTime(item.expiresAt))
  const controls = element('div', { className: 'entry-actions' })
  const issue = element('button', { text: 'Issue secure link' })
  issue.type = 'button'
  issue.dataset.adminAction = 'issue'
  issue.addEventListener('click', () => void reviewRecovery(item.id, 'issue'))
  const deny = element('button', { text: 'Deny', className: 'danger' })
  deny.type = 'button'
  deny.dataset.adminAction = 'deny'
  deny.addEventListener('click', () => void reviewRecovery(item.id, 'deny'))
  controls.append(issue, deny)
  row.append(info, controls)
  return row
}
function renderChildren(targetId, items, renderer, emptyText) {
  const target = $(targetId)
  target.replaceChildren(...(items.length
    ? items.map(renderer) : [element('p', { text: emptyText })]))
}
function validateOverview(value) {
  return value && Array.isArray(value.invitations) &&
    Array.isArray(value.households) && value.households.every(h =>
      h && typeof h.householdId === 'string' &&
      typeof h.displayName === 'string' &&
      typeof h.memberCount === 'number' &&
      (h.ownerDisplayName === null || typeof h.ownerDisplayName === 'string') &&
      ['pending-activation', 'configured-route', 'approved-unrouted'].includes(h.state)) &&
    value.invitations.every(x =>
      x && Number.isSafeInteger(x.id) && typeof x.expiresAt === 'number')
}
function validateRecovery(value) {
  return value && Array.isArray(value.requests) &&
    value.requests.every(r => r && Number.isSafeInteger(r.id) &&
      typeof r.displayName === 'string' && typeof r.username === 'string' &&
      typeof r.createdAt === 'number' && typeof r.expiresAt === 'number')
}

async function refresh() {
  const [overview, pending, readiness] = await Promise.all([
    requestJson('/api/admin/household-overview'),
    requestJson('/api/admin/recovery/requests'),
    // The optional preflight does not control registration/activation. If it
    // is unavailable, the existing household overview remains usable.
    requestJson('/api/admin/activation-readiness').catch(() => null),
  ])
  if (!validateOverview(overview) || !validateRecovery(pending)) {
    throw new Error('Unexpected response from administrator service.')
  }
  activationChecks = readiness?.kind === 'read-only-private-activation-preflight-v1' &&
    readiness.canActivateFromBrowser === false && Array.isArray(readiness.checks)
      ? new Map(readiness.checks.filter(check => check &&
          typeof check.householdId === 'string' &&
          ['blocked-review', 'storage-reviewed-awaiting-backend-proof',
            'approved-awaiting-route', 'approved-route-configured'].includes(check.stage))
        .map(check => [check.householdId, check]))
      : new Map()
  $('household-count').textContent = overview.households.length
  $('configured-count').textContent = overview.households
    .filter(x => x.state === 'configured-route').length
  $('pending-invites-count').textContent = overview.invitations.length
  $('pending-recovery-count').textContent = pending.requests.length
  renderChildren('household-list', overview.households, householdEntry,
    'No independent households have been registered through your invitations.')
  renderChildren('invitation-list', overview.invitations, inviteEntry,
    'No pending household invitations.')
  renderChildren('recovery-list', pending.requests, recoveryEntry,
    'No pending password recovery requests.')
}

async function reviewRecovery(id, action) {
  if (busy) return
  const password = $('operator-password').value
  if (!password) {
    setStatus('Enter your own system-administrator password.', true)
    return
  }
  if (action === 'issue' && !$('verified-identity').checked) {
    setStatus('Verify this account holder through a trusted contact method first.', true)
    return
  }
  if (action === 'deny' && !confirm('Deny this recovery request?')) return
  await operation(async () => {
    $('recovery-link-box').hidden = true
    $('recovery-link').value = ''
    const body = action === 'issue'
      ? { ownerPassword: password, verifiedOutOfBand: true }
      : { ownerPassword: password }
    const response = await requestJson(
      '/api/admin/recovery/requests/' + encodeURIComponent(String(id)) +
      '/' + action, body)
    $('operator-password').value = ''
    $('verified-identity').checked = false
    if (action === 'issue') {
      if (!validOneTimeUrl(response?.resetUrl, resetPrefix)) {
        throw new Error('The recovery service returned an invalid reset link.')
      }
      $('recovery-link').value = response.resetUrl
      $('recovery-link-box').hidden = false
      setStatus('One-time reset link issued. Copy it before leaving the page.')
    } else {
      setStatus('Recovery request denied.')
    }
    await refresh()
  })
}
$('refresh-button').addEventListener('click', () =>
  void operation(async () => {
    await refresh()
    setStatus('Operator data refreshed.')
  }))
$('create-invite').addEventListener('click', () => void operation(async () => {
  $('new-household-link').hidden = true
  $('household-invite-link').value = ''
  const response = await requestJson('/api/households/independent-invitations', {})
  if (!validOneTimeUrl(response?.startUrl, linkPrefix)) {
    throw new Error('The invitation service returned an invalid link.')
  }
  $('household-invite-link').value = response.startUrl
  $('new-household-link').hidden = false
  await refresh()
  setStatus('One-time household invitation created. Share the link privately.')
}))
$('copy-household-link').addEventListener('click', () =>
  void copyField('household-invite-link'))
$('copy-recovery-link').addEventListener('click', () =>
  void copyField('recovery-link'))
void refresh().then(() => {
  setStatus('System operator access verified. Household metadata only.')
}).catch(error => {
  setStatus(error instanceof Error ? error.message : 'System dashboard unavailable.', true)
})
