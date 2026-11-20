const form = document.getElementById('recovery-request')
const message = document.getElementById('recovery-message')
const button = document.getElementById('recovery-submit')
if (location.protocol !== 'https:') {
  button.disabled = true
  message.textContent = 'HTTPS is required for account recovery.'
}
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (location.protocol !== 'https:' || button.disabled) return
  button.disabled = true
  message.textContent = ''
  try {
    const response = await fetch('/api/auth/recovery/request', {
      method: 'POST', cache: 'no-store', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: String(new FormData(form).get('username') ?? '').trim(),
      }),
    })
    const result = await response.json().catch(() => ({}))
    message.textContent = response.status === 202
      ? 'If this username has an eligible account, an administrator can review the recovery request. Contact your administrator using a previously trusted method.'
      : response.status === 429
        ? 'Too many attempts. Try again later.'
        : result.error || 'Recovery is temporarily unavailable.'
  } catch {
    message.textContent = 'Unable to reach the recovery service.'
  } finally {
    button.disabled = false
  }
})
