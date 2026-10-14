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
  details.append(name, last)
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
