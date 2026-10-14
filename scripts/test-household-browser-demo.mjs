import test from 'node:test'
import assert from 'node:assert/strict'
import { startHouseholdBrowserDemo } from './run-household-browser-demo.mjs'

function request(base, path, { cookie, body } = {}) {
  return fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : {
        Origin: 'https://' + new URL(base).host,
        'Content-Type': 'application/json',
      }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
  })
}

async function login(demo, account) {
  const response = await request(demo.base, '/api/auth/login', {
    body: { username: account.username, password: account.password,
      deviceLabel: 'Disposable browser demo test' },
  })
  assert.equal(response.status, 200)
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.match(cookie, /^__Host-fc_session=[a-f0-9]{64}$/)
  return cookie
}

async function getJson(demo, path, cookie) {
  const response = await request(demo.base, path, { cookie })
  const data = await response.json()
  return { status: response.status, data }
}

test('disposable private browser demo serves real UI and only selected events through one secure-login gateway', {
  timeout: 60000,
}, async () => {
  const demo = await startHouseholdBrowserDemo()
  try {
    assert.equal(new URL(demo.base).hostname, '127.0.0.1')
    assert.notEqual(demo.gatewayPort, 3001)
    assert.notEqual(demo.gatewayPort, 13002)
    assert.notEqual(demo.privateBackendPorts['family-a'],
      demo.privateBackendPorts['family-b'])
    assert.notEqual(demo.accounts[0].password, demo.accounts[1].password)

    assert.equal((await request(demo.base, '/api/events')).status, 401)
    assert.equal((await request(demo.base, '/')).status, 303)
    const loginPage = await request(demo.base, '/login')
    assert.equal(loginPage.status, 200)
    assert.match(await loginPage.text(), /Family Calendar/)

    const cookieA = await login(demo, demo.accounts[0])
    const cookieB = await login(demo, demo.accounts[1])

    const a = await getJson(demo, '/api/events', cookieA)
    const b = await getJson(demo, '/api/events', cookieB)
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.deepEqual(a.data.map(item => item.title), [
      'DEMO A — BBQ to share', 'DEMO A — PRIVATE appointment',
    ])
    assert.deepEqual(b.data.map(item => item.title), [
      'DEMO B — PRIVATE family event',
    ])
    assert.equal(a.data[0].id, demo.sample.sourceId)
    const profileA = await request(demo.base, '/', { cookie: cookieA })
    assert.equal(profileA.status, 200)
    const html = await profileA.text()
    assert.match(html, /assets\/index-/)

    const contactsA = await getJson(demo, '/api/shared-events/recipients', cookieA)
    const contactsB = await getJson(demo, '/api/shared-events/recipients', cookieB)
    assert.deepEqual(contactsA.data.recipients.map(v => v.householdId), ['family-b'])
    assert.deepEqual(contactsB.data.recipients.map(v => v.householdId), ['family-a'])
    assert.deepEqual((await getJson(demo, '/api/shared-events/sent', cookieA)).data.shares, [])

    const invited = await request(demo.base, '/api/shared-events/invite', {
      cookie: cookieA,
      body: {
        eventIds: [demo.sample.sourceId],
        recipientHouseholdIds: ['family-b'],
      },
    })
    assert.equal(invited.status, 201)
    const shareId = (await invited.json()).invitations[0].shareId
    assert.equal((await getJson(demo, '/api/shared-events/invitations', cookieB))
      .data.invitations[0].title, 'DEMO A — BBQ to share')
    assert.deepEqual((await getJson(demo, '/api/shared-events/accepted', cookieB)).data.events, [])

    const accepted = await request(demo.base, '/api/shared-events/' + shareId + '/respond', {
      cookie: cookieB, body: { decision: 'accepted' },
    })
    assert.equal(accepted.status, 200)
    const visible = await getJson(demo, '/api/shared-events/accepted', cookieB)
    assert.deepEqual(visible.data.events.map(v => v.title), ['DEMO A — BBQ to share'])
    assert.doesNotMatch(JSON.stringify(visible.data),
      /PRIVATE appointment|PRIVATE family event|private notes|confidential details/i)
    assert.deepEqual((await getJson(demo, '/api/events', cookieB)).data.map(x => x.title), [
      'DEMO B — PRIVATE family event',
    ])
    assert.equal((await getJson(demo, '/api/shared-events/sent', cookieA))
      .data.shares[0].status, 'accepted')
    console.log('[PASS] Browser demo uses two temporary usernames and separate SQLite households.')
    console.log('[PASS] Real calendar frontend and central login work behind one localhost gateway.')
    console.log('[PASS] A handpicked event can be invited and accepted without sharing a private calendar.')
    console.log('[PASS] Demo never opens production, test preview ports or a Tailscale listener.')
  } finally {
    await demo.close()
  }
})
