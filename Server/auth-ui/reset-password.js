const form = document.getElementById('reset-password-form')
const message = document.getElementById('reset-message')
const button = document.getElementById('reset-submit')
const success = document.getElementById('reset-success')
// Token is only in the fragment, so server routes, referrers and access
// logs never receive it in GET paths or query strings.
const token = new URLSearchParams(location.hash.slice(1)).get('token')
history.replaceState(null, '', location.pathname)
if (location.protocol !== 'https:' || !/^[a-f0-9]{64}$/.test(token || '')) {
  button.disabled = true
  message.textContent = 'This reset link is missing, expired or invalid. Request a new one.'
}
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (button.disabled || !token) return
  message.textContent = ''
  const formData = new FormData(form)
  const newPassword = String(formData.get('password') ?? '')
  const confirm = String(formData.get('confirm') ?? '')
  if (newPassword !== confirm) {
    message.textContent = 'Passwords do not match.'
    return
  }
  if (newPassword.length < 8 || newPassword.length > 200) {
    message.textContent = 'Use a password between 8 and 200 characters.'
    return
  }
  button.disabled = true
  button.textContent = 'Resetting password…'
  message.textContent = 'Submitting your new password.'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch('/api/auth/recovery/complete', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, newPassword }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || result.ok !== true) {
      message.textContent = result.error || 'This link could not be used.'
      button.disabled = false
      return
    }
    form.reset()
    form.hidden = true
    success.hidden = false
    success.prepend(document.createTextNode('Password updated. All previous trusted-device sessions were signed out. '))
  } catch (error) {
    message.textContent = error?.name === 'AbortError' ? 'The reset service did not respond. Try signing in once with your new password before retrying; the request may have completed.' : 'The reset service could not be reached. Keep this page open and try again.'
    button.disabled = false
  } finally {
    clearTimeout(timeout)
    button.textContent = 'Reset password'
  }
})
