const form = document.getElementById('login-form')
const message = document.getElementById('login-message')
const button = document.getElementById('login-button')
const checking = document.getElementById('session-check')
const content = document.getElementById('login-content')

// Only the PRIVATE invitation gateway exposes this read-only Owner status.
// Legacy TEST/LIVE return 404 and preserve the existing sign-in behavior.
async function successfulSignInDestination() {
  try {
    const response = await fetch('/api/households/my-onboarding', {
      credentials: 'same-origin', cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return '/'
    const result = await response.json()
    if (!result || !Array.isArray(result.households)) return '/'
    const homes = result.households.filter(h => h &&
      ['pending-activation', 'approved-awaiting-route', 'configured-route']
        .includes(h.state))
    // Do not send a newly registered Owner to an unactivated tenant or
    // ask them to create a second account.
    if (homes.length && homes.every(h => h.state !== 'configured-route')) {
      return '/my-household'
    }
  } catch { /* Legacy sites or transient gateway failures use normal login. */ }
  return '/'
}

function showLoginForm() {
  checking.hidden = true
  content.hidden = false
}

async function checkRememberedLogin() {
  if (location.protocol !== 'https:') {
    showLoginForm()
    message.textContent = 'A secure HTTPS connection is required to sign in.'
    button.disabled = true
    return
  }

  // Keep the sign-in form hidden while the server checks the existing device.
  // This is presentation-only. Server-side session checks enforce all access.
  checking.hidden = false
  content.hidden = true

  try {
    const response = await fetch('/api/auth/status', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(8000),
    })
    if (response.ok) {
      const status = await response.json()
      if (status.authenticated === true) {
        location.replace(await successfulSignInDestination())
        return
      }
    }
    showLoginForm()
  } catch {
    // If the status lookup fails or times out, still let the user log in.
    showLoginForm()
    message.textContent = 'Could not check your saved login. Try refreshing, or sign in.'
  }
}

// Current installed TEST/LIVE have no approved password recovery service.
// Never show a dead link unless the authenticated-origin gateway explicitly
// advertises administrator-assisted recovery.
void fetch('/api/auth/recovery/availability', {
  credentials: 'same-origin', cache: 'no-store',
}).then(async response => {
  if (!response.ok) return
  const data = await response.json()
  if (data && data.supported === true &&
      data.mode === 'administrator-assisted') {
    document.getElementById('forgot-password-link').hidden = false
  }
}).catch(() => {})

void checkRememberedLogin()

// Browser back/forward cache can restore the old login DOM even when a device
// has an active session. Revalidate instead of briefly showing the old form.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) void checkRememberedLogin()
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (location.protocol !== 'https:') return
  message.textContent = ''
  button.disabled = true
  const values = new FormData(form)
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        username: String(values.get('username') || '').trim(),
        password: String(values.get('password') || ''),
        deviceLabel: String(values.get('deviceLabel') || '').trim(),
      }),
    })
    const result = await response.json()
    if (!response.ok) {
      message.textContent = result.error || 'Sign in unsuccessful. Please try again.'
      return
    }
    location.replace(await successfulSignInDestination())
  } catch {
    message.textContent = 'The calendar could not be reached. Please try again.'
  } finally {
    button.disabled = false
  }
})
