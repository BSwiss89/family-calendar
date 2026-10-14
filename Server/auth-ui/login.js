const form = document.getElementById('login-form')
const message = document.getElementById('login-message')
const button = document.getElementById('login-button')

if (location.protocol !== 'https:') {
  message.textContent = 'A secure HTTPS connection is required to sign in.'
  button.disabled = true
}

fetch('/api/auth/status', { cache: 'no-store' })
  .then((response) => response.ok ? response.json() : null)
  .then((status) => {
    if (status?.authenticated) location.replace('/')
  })
  .catch(() => {})

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
