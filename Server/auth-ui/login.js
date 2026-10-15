const form = document.getElementById('login-form')
const message = document.getElementById('login-message')
const button = document.getElementById('login-button')
const checking = document.getElementById('session-check')
const content = document.getElementById('login-content')

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
        location.replace('/')
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
    location.replace('/')
  } catch {
    message.textContent = 'The calendar could not be reached. Please try again.'
  } finally {
    button.disabled = false
  }
})
