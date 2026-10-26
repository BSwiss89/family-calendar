const form = document.getElementById('start-form')
const message = document.getElementById('start-message')
const submit = document.getElementById('start-submit')
const tokenField = document.getElementById('start-token')
const token = new URLSearchParams(location.hash.slice(1)).get('token')
if (token && /^[a-f0-9]{64}$/.test(token)) tokenField.value = token
if (location.hash) history.replaceState(null, '', location.pathname + location.search)
if (location.protocol !== 'https:') {
  message.textContent = 'A secure HTTPS connection is required to register.'
  submit.disabled = true
}
form.addEventListener('submit', async event => {
  event.preventDefault()
  if (location.protocol !== 'https:') return
  submit.disabled = true
  message.textContent = ''
  const payload = {
    token: tokenField.value.trim(),
    householdName: document.getElementById('start-household').value.trim(),
    username: document.getElementById('start-username').value.trim(),
    displayName: document.getElementById('start-name').value.trim(),
    password: document.getElementById('start-password').value,
  }
  try {
    const res = await fetch('/api/households/create-from-invitation', {
      method: 'POST', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    if (res.status !== 201) {
      message.textContent = res.status === 429 ? 'Too many attempts. Try later.'
        : 'Registration could not be completed. Check your invitation and account details.'
      return
    }
    tokenField.value = ''
    document.getElementById('start-password').value = ''
    form.hidden = true
    document.getElementById('start-success').hidden = false
  } catch {
    message.textContent = 'Unable to reach the calendar. Check your connection and try again.'
  } finally { submit.disabled = false }
})
