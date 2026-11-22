// Phase 1 Owner pilot uses only the reviewed household events/lists/People
// endpoints. The server validates the actual account and household for every
// request; this UI does not send a user/tenant selector or any role claims.
const $ = id => document.getElementById(id)
const message = $('notice')
const make = (tag, value) => {
  const node = document.createElement(tag)
  node.textContent = String(value ?? '')
  return node
}
const safeArray = value => Array.isArray(value) ? value.slice(0, 150) : []
const cleanError = status => {
  if (status === 401) return 'Your login expired. Sign in again.'
  if (status === 403 || status === 404) return 'This action is not available in the Phase 1 pilot.'
  return 'The household service is unavailable. Try again.'
}

async function api(route, { method = 'GET', payload } = {}) {
  // Never fetch a remote URL or send unreviewed fields to the backend.
  const response = await fetch(route, {
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'manual',
    method,
    headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  })
  if (!response.ok) throw new Error(cleanError(response.status))
  if (response.status === 204) return null
  return response.json()
}

function renderEvents(events) {
  const nodes = safeArray(events).map(event => {
    const card = make('section', '')
    card.className = 'entry'
    card.append(make('h3', event?.title ?? 'Untitled event'))
    const times = [event?.date, event?.time].filter(Boolean)
    card.append(make('p', times.join(' · ') || 'Date not set'))
    return card
  })
  $('events').replaceChildren(...(nodes.length ? nodes : [make('p', 'No events yet.')]))
}

function renderPeople(people) {
  const nodes = safeArray(people).map(person => {
    const line = make('p', person?.name ?? 'Unnamed Person')
    line.className = 'entry'
    return line
  })
  $('people').replaceChildren(...(nodes.length ? nodes : [make('p', 'No People profiles yet.')]))
}

function renderLists(lists) {
  const nodes = safeArray(lists).map(list => {
    const card = make('section', '')
    card.className = 'entry'
    card.append(make('h3', list?.name ?? 'Unnamed list'))
    const items = document.createElement('ul')
    for (const item of safeArray(list?.items)) {
      const line = make('li', (item?.completed ? '✓ ' : '') + String(item?.text ?? ''))
      items.append(line)
    }
    if (items.childElementCount) card.append(items)
    const id = Number(list?.id)
    if (Number.isSafeInteger(id) && id > 0) {
      const form = document.createElement('form')
      const label = make('label', 'Add item')
      const field = document.createElement('input')
      field.type = 'text'
      field.maxLength = 200
      field.required = true
      field.placeholder = 'New item'
      label.append(field)
      const button = make('button', 'Add item')
      button.type = 'submit'
      form.append(label, button)
      form.addEventListener('submit', event => {
        event.preventDefault()
        const text = field.value.trim()
        if (!text || text.length > 200) return
        void runWrite(button, () => api('/api/lists/' + id + '/items', {
          method: 'POST', payload: { text },
        }))
      })
      card.append(form)
    }
    return card
  })
  $('lists').replaceChildren(...(nodes.length ? nodes : [make('p', 'No shopping lists yet.')]))
}

let loading = false
async function refresh() {
  if (loading) return
  loading = true
  $('refresh').disabled = true
  message.className = ''
  message.textContent = 'Loading your private household…'
  try {
    const status = await api('/api/households')
    if (!status || !Array.isArray(status.households) ||
        status.households.length !== 1 ||
        status.selectedHouseholdId !== status.households[0]?.householdId) {
      throw new Error('Your household is not fully activated for Phase 1.')
    }
    $('family-name').textContent = String(status.households[0].displayName ?? 'My household')
    const [events, people, lists] = await Promise.all([
      api('/api/events'), api('/api/people'), api('/api/lists'),
    ])
    if (!Array.isArray(events) || !Array.isArray(people) || !Array.isArray(lists)) {
      throw new Error('Household data was unavailable.')
    }
    renderEvents(events)
    renderPeople(people)
    renderLists(lists)
    message.textContent = 'Connected to your household. Only Phase 1 actions are available.'
  } catch (error) {
    message.className = 'error'
    message.textContent = error?.message ?? 'The household could not be loaded.'
  } finally {
    loading = false
    $('refresh').disabled = false
  }
}

async function runWrite(button, action) {
  button.disabled = true
  message.className = ''
  message.textContent = 'Saving in your household…'
  try {
    await action()
    // Every action is followed by a fresh server read; never assume an
    // optimistic client change belongs to the selected Person or family.
    await refresh()
  } catch (error) {
    message.className = 'error'
    message.textContent = error?.message ?? 'Could not save.'
  } finally {
    button.disabled = false
  }
}

$('event-form').addEventListener('submit', event => {
  event.preventDefault()
  const title = $('event-title').value.trim()
  const date = $('event-date').value
  const time = $('event-time').value
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return
  const button = $('event-form').querySelector('button[type="submit"]')
  void runWrite(button, async () => {
    await api('/api/events', { method: 'POST', payload: { title, date, time } })
    $('event-title').value = ''
  })
})

$('list-form').addEventListener('submit', event => {
  event.preventDefault()
  const name = $('list-name').value.trim()
  if (!name || name.length > 100) return
  const button = $('list-form').querySelector('button[type="submit"]')
  void runWrite(button, async () => {
    await api('/api/lists', { method: 'POST', payload: { name } })
    $('list-name').value = ''
  })
})

$('refresh').addEventListener('click', () => void refresh())
$('logout').addEventListener('click', async () => {
  $('logout').disabled = true
  try {
    await api('/api/auth/logout', { method: 'POST' })
    window.location.assign('/login')
  } catch (error) {
    $('logout').disabled = false
    message.className = 'error'
    message.textContent = error?.message ?? 'Sign out was unsuccessful.'
  }
})
void refresh()
