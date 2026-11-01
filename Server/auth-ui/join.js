// The one-use invitation secret is carried in the URL fragment, never in
// the HTTP request path/query, referrer, local storage, or browser cookies.
const form = document.getElementById('join-form')
const message = document.getElementById('join-message')
const submit = document.getElementById('join-submit')
const success = document.getElementById('join-success')
const invitation = document.getElementById('invite-token')

const fragment = new URLSearchParams(location.hash.slice(1))
const bearer = fragment.get('token')
if (bearer && /^[a-f0-9]{64}$/.test(bearer)) {
  invitation.value = bearer
}
// Remove the secret from address/history immediately, even when malformed.
if (location.hash) history.replaceState(null, '', location.pathname + location.search)
if (location.protocol !== 'https:') {
  message.textContent = 'A secure HTTPS connection is required to register.'
  submit.disabled = true
}

form.addEventListener('submit', async event => {
  event.preventDefault()
  if (location.protocol !== 'https:') return
  message.textContent = ''
  submit.disabled = true
  const payload = {
    token: invitation.value.trim(),
    username: document.getElementById('join-username').value.trim(),
    displayName: document.getElementById('join-display-name').value.trim(),
    password: document.getElementById('join-password').value,
  }
  try {
    const response = await fetch('/api/households/join', {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (response.status !== 201) {
      message.textContent = response.status === 429
        ? 'Too many attempts. Try again later.'
        : 'Invitation signup could not be completed. Check your invitation and account details.'
      return
    }
    invitation.value = ''
    document.getElementById('join-password').value = ''
    form.hidden = true
    success.hidden = false
  } catch {
    message.textContent = 'Could not reach the calendar. Check your connection and try again.'
  } finally {
    submit.disabled = false
  }
})
