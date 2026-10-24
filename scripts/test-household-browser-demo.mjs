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
  assert.match(cookie, /^__Host-fc_gateway_session=[a-f0-9]{64}$/)
  return cookie
}

async function getJson(demo, path, cookie) {
  const response = await request(demo.base, path, { cookie })
  const data = await response.json()
  return { status: response.status, data }
}

test('disposable private browser demo serves real UI and only selected events through one secure-login gateway', {
  timeout: 90000,
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
    const cookieAMember = await login(demo, demo.accounts[2])
    const cookieAHub = await login(demo, demo.accounts[3])
    assert.equal((await getJson(demo, '/api/auth/status', cookieAMember))
      .data.accountKind, 'person')
    assert.equal((await getJson(demo, '/api/auth/status', cookieAHub))
      .data.accountKind, 'hub')
    assert.equal((await getJson(demo, '/api/auth/status', cookieAHub))
      .data.displayName, 'Family A Hub')

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
    assert.equal((await getJson(demo, '/api/event-creators', cookieB))
      .status, 200)
    assert.deepEqual((await getJson(demo, '/api/event-creators', cookieB))
      .data.creators, [])
    assert.equal((await request(demo.base, '/api/event-creators')).status, 401)
    const memberCreate = await request(demo.base, '/api/events', {
      cookie: cookieAMember,
      body: {
        date: demo.sample.sharedCandidateDate, title: 'Created on mobile',
        time: '15:00',
        createdBy: 'Fake Hub Admin',
        accountKind: 'hub',
      },
    })
    assert.equal(memberCreate.status, 201)
    const memberCreatedId = (await memberCreate.json()).id
    const hubCreate = await request(demo.base, '/api/events', {
      cookie: cookieAHub,
      body: {
        date: demo.sample.sharedCandidateDate, title: 'Created by hub',
        time: '16:00', createdBy: 'Fake Mobile Person',
      },
    })
    assert.equal(hubCreate.status, 201)
    const hubCreatedId = (await hubCreate.json()).id
    const authorResponse = await getJson(demo, '/api/event-creators', cookieA)
    assert.equal(authorResponse.status, 200)
    const authorLabels = authorResponse.data.creators
    assert.equal(authorLabels.find(v => v.eventId === memberCreatedId).displayName,
      'Family A Member Two')
    assert.equal(authorLabels.find(v => v.eventId === memberCreatedId).accountKind,
      'person')
    assert.equal(authorLabels.find(v => v.eventId === hubCreatedId).displayName,
      'Family A Hub')
    assert.equal(authorLabels.find(v => v.eventId === hubCreatedId).accountKind,
      'hub')
    assert.deepEqual((await getJson(demo, '/api/event-creators', cookieB))
      .data.creators, [])
    assert.deepEqual(
      (await getJson(demo, '/api/events', cookieAMember)).data
        .filter(v => [memberCreatedId, hubCreatedId].includes(v.id))
        .map(v => v.title),
      ['Created on mobile', 'Created by hub'],
    )
    // Complete integration: owner invites, recipient registers, signs in,
    // remains in Family A, and loses ONLY that membership when revoked.
    // None of these operations mutate Family B or existing accounts.
    const issued = await request(demo.base, '/api/households/member-invitations', {
      cookie: cookieA, body: {},
    })
    assert.equal(issued.status, 201)
    const invited = await issued.json()
    assert.match(invited.token, /^[a-f0-9]{64}$/)
    const shareLink = new URL(invited.joinUrl)
    assert.equal(shareLink.origin, 'https://' + new URL(demo.base).host)
    assert.equal(shareLink.pathname, '/join')
    assert.equal(shareLink.search, '')
    assert.equal(shareLink.hash, '#token=' + invited.token)
    assert.equal((await request(demo.base, '/join')).status, 200)
    const memberBefore = await getJson(demo, '/api/households/members', cookieA)
    assert.equal(memberBefore.status, 200)
    const memberB = await getJson(demo, '/api/households/members', cookieB)
    assert.equal(memberB.status, 200)
    assert.deepEqual(memberB.data.members.map(v => v.username), ['demo-family-b'])
    assert.equal((await request(demo.base, '/api/households/members', {
      cookie: cookieAMember,
    })).status, 403)
    assert.equal((await request(demo.base, '/api/households/member-invitations', {
      cookie: cookieAMember, body: {},
    })).status, 403)
    const newPassword = 'Synthetic-Invitation-Test-Password-2026!'
    const newUsername = 'new-integration-member'
    const registration = {
      token: invited.token,
      username: newUsername, displayName: 'New Demo Member',
      password: newPassword,
    }
    const forged = await request(demo.base, '/api/households/join', {
      body: { ...registration, householdId: 'family-b' },
    })
    assert.equal(forged.status, 400)
    const joined = await request(demo.base, '/api/households/join', {
      body: registration,
    })
    assert.equal(joined.status, 201)
    assert.equal(joined.headers.get('set-cookie'), null)
    assert.deepEqual(await joined.json(), { ok: true, next: '/login' })
    assert.equal((await request(demo.base, '/api/households/join', {
      body: { ...registration, username: 'replay-account' },
    })).status, 400)
    const newCookie = await login(demo, { username: newUsername, password: newPassword })
    const assigned = await getJson(demo, '/api/households', newCookie)
    assert.deepEqual(assigned.data.households.map(v => [v.householdId, v.role]),
      [['family-a', 'member']])
    assert.equal((await getJson(demo, '/api/households/select', newCookie)).status, 404)
    const crossHousehold = await request(demo.base, '/api/households/select', {
      cookie: newCookie, body: { householdId: 'family-b' },
    })
    assert.equal(crossHousehold.status, 403)
    assert.equal((await getJson(demo, '/api/households/members', newCookie)).status, 403)
    assert.deepEqual((await getJson(demo, '/api/events', newCookie))
      .data.map(v => v.title), [
        'DEMO A — BBQ to share',
        'DEMO A — PRIVATE appointment',
        'Created on mobile',
        'Created by hub',
      ])
    assert.deepEqual((await getJson(demo, '/api/events', cookieB))
      .data.map(v => v.title), ['DEMO B — PRIVATE family event'])
    const ownerRoster = await getJson(demo, '/api/households/members', cookieA)
    assert.equal(ownerRoster.data.members.length, memberBefore.data.members.length + 1)
    const newMember = ownerRoster.data.members.find(v => v.username === newUsername)
    assert.equal(newMember?.role, 'member')
    const remove = await request(demo.base,
      '/api/households/members/' + newMember.userId + '/remove', {
        cookie: cookieA, body: {},
      })
    assert.equal(remove.status, 200)
    assert.equal((await getJson(demo, '/api/events', newCookie)).status, 403)
    assert.equal((await request(demo.base, '/api/households/member-invitations', {
      cookie: newCookie, body: {},
    })).status, 403)
    assert.equal((await getJson(demo, '/api/events', cookieA)).status, 200)
    assert.equal((await getJson(demo, '/api/events', cookieB)).status, 200)
    assert.equal((await getJson(demo, '/api/households/members', cookieB))
      .data.members.length, memberB.data.members.length)
    console.log('[PASS] Owner -> invite -> signup -> member login -> isolation -> removal.')
    console.log('[PASS] Settings member directory and one-time invitation endpoints are owner-only.')
    console.log('[PASS] Household removal revokes access without affecting the other household.')

    console.log('[PASS] Mobile member and hub accounts have distinct session identities and audit authors.')
    console.log('[PASS] Forged createdBy fields cannot impersonate another family member or hub.')
    console.log('[PASS] Creator identities are accessible only within the verified household.')
    console.log('[PASS] Browser demo uses separate SQLite households and multiple personal/hub accounts.')
    console.log('[PASS] Real calendar frontend and central login work behind one localhost gateway.')
    console.log('[PASS] A handpicked event can be invited and accepted without sharing a private calendar.')
    console.log('[PASS] Demo never opens production, test preview ports or a Tailscale listener.')
  } finally {
    await demo.close()
  }
})
