const message = document.getElementById('account-message')
const whoami = document.getElementById('whoami')
const devices = document.getElementById('devices')
const logout = document.getElementById('logout')

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
  })
  if (response.status === 401) {
    location.replace('/login')
    throw new Error('Sign in required.')
  }
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || 'Request failed.')
  return data
}

function deviceRow(device) {
  const row = document.createElement('div')
  row.className = 'device-row'
  const details = document.createElement('div')
  const name = document.createElement('strong')
  name.textContent = device.label + (device.current ? ' (this device)' : '')
  const last = document.createElement('span')
  last.className = 'muted small'
  last.textContent = 'Last used: ' + new Date(device.lastSeenAt).toLocaleDateString()
  const profile = document.createElement('span')
  profile.className = 'muted small'
  profile.textContent = 'Profile: ' + (device.selectedProfile || 'Not selected')
  details.append(name, profile, last)
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'revoke-button'
  button.textContent = device.current ? 'Sign out' : 'Revoke'
  button.addEventListener('click', async () => {
    if (!confirm('Remove access for ' + device.label + '?')) return
    button.disabled = true
    message.textContent = ''
    try {
      await requestJson('/api/auth/devices/' + encodeURIComponent(String(device.id)) + '/revoke', { method: 'POST' })
      if (device.current) location.replace('/login')
      else await refresh()
    } catch (error) {
      message.textContent = error.message || 'Could not revoke device.'
      button.disabled = false
    }
  })
  row.append(details, button)
  return row
}

async function refresh() {
  const [status, result] = await Promise.all([
    requestJson('/api/auth/status'),
    requestJson('/api/auth/devices'),
  ])
  whoami.textContent = 'Signed in as ' + (status.displayName || status.username || 'family member')
  devices.replaceChildren(...result.devices.map(deviceRow))
  if (!result.devices.length) message.textContent = 'No active devices.'
}

logout.addEventListener('click', async () => {
  logout.disabled = true
  message.textContent = ''
  try {
    await requestJson('/api/auth/logout', { method: 'POST' })
    location.replace('/login')
  } catch (error) {
    message.textContent = error.message || 'Could not sign out.'
    logout.disabled = false
  }
})

refresh().catch((error) => {
  message.textContent = error.message || 'Could not load trusted devices.'
})

const contactSection = document.getElementById('recovery-contact-section')
const contactForm = document.getElementById('recovery-contact-form')
const contactEmail = document.getElementById('recovery-contact-email')
const contactPassword = document.getElementById('recovery-contact-password')
const contactMessage = document.getElementById('recovery-contact-message')
const contactSave = document.getElementById('recovery-contact-save')

async function loadOptionalRecoveryContact() {
  try {
    const response = await fetch('/api/auth/recovery-contact', {
      credentials: 'same-origin', cache: 'no-store',
    })
    if (!response.ok) return // Legacy LIVE/TEST does not have this feature.
    const result = await response.json()
    if (!result || result.verified !== false &&
        result.verified !== true) return
    contactEmail.value = typeof result.email === 'string' ? result.email : ''
    contactSection.hidden = false
  } catch { /* Keep optional settings hidden when the gateway is unavailable. */ }
}
void loadOptionalRecoveryContact()

contactForm.addEventListener('submit', async event => {
  event.preventDefault()
  if (location.protocol !== 'https:' || contactSave.disabled) return
  contactSave.disabled = true
  contactMessage.textContent = ''
  try {
    const response = await fetch('/api/auth/recovery-contact', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: contactEmail.value.trim() || null,
        currentPassword: contactPassword.value,
      }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) {
      contactMessage.textContent = result.error || 'Unable to save contact.'
      return
    }
    contactPassword.value = ''
    contactMessage.textContent = result.email
      ? 'Address saved as unverified. Automatic email recovery is not enabled.'
      : 'Optional recovery email cleared.'
  } catch {
    contactMessage.textContent = 'Could not save recovery contact.'
  } finally {
    contactSave.disabled = false
  }
})
