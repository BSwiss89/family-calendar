// Presentation only; the server rechecks the signed-in Owner and current
// independent household membership on every status request.
const list = document.getElementById('my-household-status-list')
const button = document.getElementById('refresh-household-status')

function make(tag, value) {
  const node = document.createElement(tag)
  node.textContent = value
  return node
}
async function refresh() {
  button.disabled = true
  list.replaceChildren(make('p', 'Checking current registration status…'))
  try {
    const response = await fetch('/api/households/my-onboarding', {
      credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) {
      list.replaceChildren(make('p',
        response.status === 403
          ? 'This account is not the original invited Owner of a new household.'
          : 'Could not check your household right now.'))
      return
    }
    const data = await response.json()
    if (!data || !Array.isArray(data.households) ||
        data.households.length === 0) {
      list.replaceChildren(make('p',
        'No new household registration belongs to this account.'))
      return
    }
    const nodes = []
    for (const home of data.households) {
      if (!home || typeof home.displayName !== 'string') continue
      const row = document.createElement('section')
      const heading = make('h2', home.displayName)
      heading.style.fontSize = '1.1rem'
      heading.style.margin = '12px 0 5px'
      row.append(heading)
      let state = 'Your registration is awaiting administrator approval.'
      if (home.state === 'approved-awaiting-route') {
        state = 'Your household is approved. The secure calendar connection is still being prepared.'
      } else if (home.state === 'configured-route') {
        state = 'Your private calendar route is configured.'
      }
      row.append(make('p', state))
      if (home.state === 'configured-route') {
        const open = make('a', 'Open my family calendar')
        open.href = '/'
        row.append(open)
      } else {
        row.append(make('p',
          'You can sign in with your new username and password. No further registration or Home PIN is required while activation is pending.'))
      }
      nodes.push(row)
    }
    list.replaceChildren(...(nodes.length ? nodes :
      [make('p', 'Household status is unavailable.')]))
  } catch {
    list.replaceChildren(make('p', 'Could not reach the registration service.'))
  } finally {
    button.disabled = false
  }
}
button.addEventListener('click', () => void refresh())
void refresh()
