import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { DatabaseSync } from 'node:sqlite'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  installFamilyAuth,
  createFamilyAuthTables,
  setFamilyAccount,
  verifyFamilyPassword,
} from '../Server/family-auth.mjs'

const serverFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../Server')
const password = 'Really-Long-Unique-Family-Passphrase-For-Tests'

async function startServer(database, mode = 'required', installer = installFamilyAuth) {
  const app = express()
  app.use(express.json())
  installer(app, database, serverFolder, mode)
  app.get('/api/health', (_request, response) => response.json({ status: 'ok' }))
  app.get('/api/events', (_request, response) => response.json({ events: ['PRIVATE'] }))
  app.post('/api/events', (_request, response) => response.json({ created: true }))
  app.get('/uploads/private-image', (_request, response) => response.send('PRIVATE IMAGE'))
  app.get('/', (_request, response) => response.send('PRIVATE CALENDAR'))
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const host = '127.0.0.1:' + address.port
  return {
    base: 'http://' + host,
    origin: 'https://' + host,
    close: () => new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve())),
  }
}

test('scrypt passwords do not expose plaintext and reject wrong values', async () => {
  const db = new DatabaseSync(':memory:')
  try {
    setFamilyAccount(db, 'bobby', 'Family admin', password)
    const saved = db.prepare('SELECT password_hash FROM family_users').get()
    assert.match(saved.password_hash, /^scrypt-v1:/)
    assert.doesNotMatch(saved.password_hash, /Really-Long/)
    assert.equal(await verifyFamilyPassword(password, saved.password_hash), true)
    assert.equal(await verifyFamilyPassword('wrong-password', saved.password_hash), false)
    assert.equal(await verifyFamilyPassword('wrong-password', null), false)
    assert.throws(() => setFamilyAccount(db, 'x', 'Bad', password), /Username/)
    assert.throws(() => setFamilyAccount(db, 'valid', 'Bad', 'short'), /14/)
  } finally {
    db.close()
  }
})

test('auth protects every calendar API, homepage and private uploads before public access', async () => {
  const db = new DatabaseSync(':memory:')
  setFamilyAccount(db, 'familyadmin', 'Family Admin', password)
  const site = await startServer(db)
  try {
    const health = await fetch(site.base + '/api/health')
    assert.equal(health.status, 200)
    assert.equal((await health.json()).status, 'ok')

    for (const route of ['/api/events', '/uploads/private-image', '/']) {
      const response = await fetch(site.base + route, { redirect: 'manual' })
      assert.equal(response.status, route.startsWith('/api/') ? 401 : 303, 'Protected: ' + route)
      assert.doesNotMatch(await response.text(), /PRIVATE/)
    }

    const loginPage = await fetch(site.base + '/login')
    assert.equal(loginPage.status, 200)
    const loginHtml = await loginPage.text()
    assert.match(loginHtml, /Family Calendar/)
    assert.match(loginHtml, /id="login-content" hidden/)
    assert.match(loginHtml, /Checking your saved login/)
    assert.match(loginHtml, /id="session-check"/)
    const loginScript = await fetch(site.base + '/auth/login.js')
    assert.equal(loginScript.status, 200)
    assert.match(await loginScript.text(), /showLoginForm/)


    const insecure = await fetch(site.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Origin': 'http://127.0.0.1:1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'familyadmin', password }),
    })
    assert.equal(insecure.status, 403)

    const wrong = await fetch(site.base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: site.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'familyadmin', password: 'incorrect' }),
    })
    assert.equal(wrong.status, 401)

    const login = await fetch(site.base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: site.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'familyadmin', password, deviceLabel: 'Test laptop' }),
    })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')
    assert.match(cookie, /__Host-fc_live_session=[a-f0-9]{64}/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /Secure/)
    assert.match(cookie, /SameSite=Strict/)
    const headerCookie = cookie.split(';')[0]
    const databaseSession = db.prepare('SELECT token_hash, device_label FROM family_sessions').get()
    assert.equal(databaseSession.device_label, 'Test laptop')
    assert.doesNotMatch(databaseSession.token_hash, new RegExp(headerCookie.slice(-16)))
    assert.equal(databaseSession.token_hash.length, 64)

    const authorized = await fetch(site.base + '/api/events', { headers: { Cookie: headerCookie } })
    assert.equal(authorized.status, 200)
    assert.deepEqual((await authorized.json()).events, ['PRIVATE'])

    // A valid remembered session should never render the login form again.
    // Redirect it server-side directly to the calendar without a browser fetch delay.
    const signedInLoginPage = await fetch(site.base + '/login', {
      headers: { Cookie: headerCookie },
      redirect: 'manual',
    })
    assert.equal(signedInLoginPage.status, 303)
    assert.equal(signedInLoginPage.headers.get('location'), '/')

    const image = await fetch(site.base + '/uploads/private-image', { headers: { Cookie: headerCookie } })
    assert.equal(image.status, 200)
    assert.equal(await image.text(), 'PRIVATE IMAGE')

    const csrf = await fetch(site.base + '/api/events', {
      method: 'POST',
      headers: { Cookie: headerCookie, Origin: 'https://evil.example' },
    })
    assert.equal(csrf.status, 403)

    const trusted = await fetch(site.base + '/api/auth/devices', { headers: { Cookie: headerCookie } })
    assert.equal(trusted.status, 200)
    const devices = (await trusted.json()).devices
    assert.equal(devices.length, 1)
    assert.equal(devices[0].current, true)

    const logout = await fetch(site.base + '/api/auth/logout', {
      method: 'POST',
      headers: { Cookie: headerCookie, Origin: site.origin },
    })
    assert.equal(logout.status, 200)
    const after = await fetch(site.base + '/api/events', { headers: { Cookie: headerCookie } })
    assert.equal(after.status, 401)
  } finally {
    await site.close()
    db.close()
  }
})

test('password reset revokes remembered devices and no periodic login is required while active', async () => {
  const db = new DatabaseSync(':memory:')
  setFamilyAccount(db, 'familyadmin', 'Family Admin', password)
  const site = await startServer(db)
  try {
    const login = await fetch(site.base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: site.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'familyadmin', password, deviceLabel: 'Phone' }),
    })
    const cookie = login.headers.get('set-cookie').split(';')[0]
    // Simulate a session last used more than a day ago but still within the
    // 180-day inactivity window. Access must slide the expiry and cookie.
    const yesterday = Date.now() - 2 * 24 * 60 * 60 * 1000
    db.prepare('UPDATE family_sessions SET last_seen_at = ?, expires_at = ?')
      .run(yesterday, yesterday + 180 * 24 * 60 * 60 * 1000)
    const refresh = await fetch(site.base + '/api/events', { headers: { Cookie: cookie } })
    assert.equal(refresh.status, 200)
    assert.match(refresh.headers.get('set-cookie'), /__Host-fc_live_session/)
    const renewed = db.prepare('SELECT expires_at FROM family_sessions').get()
    assert.ok(renewed.expires_at > Date.now() + 179 * 24 * 60 * 60 * 1000)

    setFamilyAccount(db, 'familyadmin', 'Family Admin', 'Brand-New-Secure-Test-Passphrase')
    const afterReset = await fetch(site.base + '/api/events', { headers: { Cookie: cookie } })
    assert.equal(afterReset.status, 401)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM family_sessions').get().count, 0)
  } finally {
    await site.close()
    db.close()
  }
})

test('account login throttling is independent behind one reverse proxy', async () => {
  const db = new DatabaseSync(':memory:')
  setFamilyAccount(db, 'accountalpha', 'Alpha Household', password)
  setFamilyAccount(db, 'accountbeta', 'Beta Household', password)

  const site = await startServer(db)
  try {
    const login = (username, suppliedPassword, forwardedIp) => fetch(
      site.base + '/api/auth/login',
      {
        method: 'POST',
        headers: {
          Origin: site.origin,
          'Content-Type': 'application/json',
          'X-Forwarded-For': forwardedIp,
        },
        body: JSON.stringify({ username, password: suppliedPassword }),
      }
    )

    for (let i = 0; i < 10; i++) {
      const response = await login(
        'accountalpha', 'wrong-password', `198.51.100.${i + 1}`
      )
      assert.equal(response.status, 401)
    }

    // Changing a forwarded IP cannot bypass this account's limit.
    const blocked = await login('accountalpha', password, '203.0.113.50')
    assert.equal(blocked.status, 429)
    assert.ok(Number(blocked.headers.get('retry-after')) > 0)

    // A second account behind the same proxy can still log in.
    const separate = await login('accountbeta', password, '203.0.113.50')
    assert.equal(separate.status, 200)
    assert.match(separate.headers.get('set-cookie'), /__Host-fc_live_session=/)

    // Unknown account names follow the same identity-based rule.
    for (let i = 0; i < 10; i++) {
      const response = await login('unknownfamily', 'wrong-password', '127.0.0.1')
      assert.equal(response.status, 401)
    }

    const unknownBlocked = await login('unknownfamily', password, '198.51.100.5')
    assert.equal(unknownBlocked.status, 429)

    const otherUnknown = await login('anotherunknown', 'wrong-password', '198.51.100.5')
    assert.equal(otherUnknown.status, 401)
  } finally {
    await site.close()
    db.close()
  }
})
test('legacy private deployments stay unchanged until auth is explicitly enabled', async () => {
  const db = new DatabaseSync(':memory:')
  const site = await startServer(db, 'disabled')
  try {
    const data = await fetch(site.base + '/api/events')
    assert.equal(data.status, 200)
    const status = await fetch(site.base + '/api/auth/status')
    assert.deepEqual(await status.json(), { enabled: false })
  } finally {
    await site.close()
    db.close()
  }
})

test('LIVE and TEST have independent secure cookies on the same hostname', async () => {
  const priorPort = process.env.FAMILY_CALENDAR_PORT
  process.env.FAMILY_CALENDAR_PORT = '13002'
  let testAuth
  try {
    testAuth = (await import('../Server/family-auth.mjs?test-site-13002')).installFamilyAuth
  } finally {
    if (priorPort === undefined) delete process.env.FAMILY_CALENDAR_PORT
    else process.env.FAMILY_CALENDAR_PORT = priorPort
  }
  const db = new DatabaseSync(':memory:')
  setFamilyAccount(db, 'testfamily', 'Test Family', password)
  const site = await startServer(db, 'required', testAuth)
  try {
    const login = await fetch(site.base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: site.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testfamily', password, deviceLabel: 'Test browser' }),
    })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')
    assert.match(cookie, /__Host-fc_test_session=[a-f0-9]{64}/)
    const cookiePair = cookie.split(';')[0]
    const authorized = await fetch(site.base + '/api/events', { headers: { Cookie: cookiePair } })
    assert.equal(authorized.status, 200)
    const liveNamedCookie = cookiePair.replace('__Host-fc_test_session=', '__Host-fc_live_session=')
    const denied = await fetch(site.base + '/api/events', { headers: { Cookie: liveNamedCookie } })
    assert.equal(denied.status, 401)
  } finally {
    await site.close()
    db.close()
  }
})


test('existing admin credentials and trusted device sessions survive additive profile migration', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec([
      'CREATE TABLE family_users (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE,',
      'display_name TEXT NOT NULL, password_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0) STRICT;',
      'CREATE TABLE family_sessions (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES family_users(id),',
      'token_hash TEXT NOT NULL UNIQUE, device_label TEXT NOT NULL, created_at INTEGER NOT NULL,',
      'last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER) STRICT;',
      "INSERT INTO family_users VALUES (1,'familyadmin','Admin','hash-unchanged',0);",
      "INSERT INTO family_sessions VALUES (4,1,'hash-session','iPhone',123,123,9999999999999,NULL);",
    ].join(' '))
    createFamilyAuthTables(db)
    createFamilyAuthTables(db)
    const saved = db.prepare('SELECT username,password_hash,disabled FROM family_users').get()
    assert.deepEqual({ ...saved }, { username: 'familyadmin', password_hash: 'hash-unchanged', disabled: 0 })
    const session = db.prepare('SELECT id,device_label,token_hash,selected_profile_kind,selected_person_id FROM family_sessions').get()
    assert.equal(session.id, 4)
    assert.equal(session.device_label, 'iPhone')
    assert.equal(session.token_hash, 'hash-session')
    assert.equal(session.selected_profile_kind, null)
    assert.equal(session.selected_person_id, null)
  } finally {
    db.close()
  }
})

test('Devices screen tracks each authenticated session profile without granting permissions', async () => {
  const db = new DatabaseSync(':memory:')
  setFamilyAccount(db, 'familyadmin', 'Family Admin', password)
  db.exec("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE) STRICT;")
  db.exec("INSERT INTO people(name) VALUES ('Bobby'),('Haylee')")
  const site = await startServer(db)
  try {
    const login = async (label) => {
      const res = await fetch(site.base + '/api/auth/login', {
        method: 'POST',
        headers: { Origin: site.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'familyadmin', password, deviceLabel: label }),
      })
      assert.equal(res.status, 200)
      return res.headers.get('set-cookie').split(';')[0]
    }
    const phone = await login('iPhone')
    const wall = await login('Wall calendar')
    const devicesFor = (cookie) => fetch(site.base + '/api/auth/devices', {
      headers: { Cookie: cookie },
    }).then(async res => {
      assert.equal(res.status, 200)
      return (await res.json()).devices
    })
    let rows = await devicesFor(phone)
    assert.equal(rows.length, 2)
    assert.ok(rows.every(item => item.selectedProfile === null))
    const select = (cookie, origin, body) => fetch(site.base + '/api/auth/device-profile', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal((await select('', site.origin, { kind: 'home' })).status, 401)
    assert.equal((await select(phone, 'https://attacker.example', { kind: 'home' })).status, 403)
    assert.equal((await select(phone, site.origin, { kind: 'person', personId: 9999 })).status, 400)
    assert.equal((await select(phone, site.origin, { kind: 'person', personId: '1' })).status, 400)
    assert.equal((await select(phone, site.origin, { kind: 'unknown' })).status, 400)
    assert.equal((await select(phone, site.origin, { kind: 'person', personId: 1 })).status, 200)
    assert.equal((await select(wall, site.origin, { kind: 'home' })).status, 200)
    rows = await devicesFor(phone)
    assert.equal(rows.find(item => item.label === 'iPhone').selectedProfile, 'Bobby')
    assert.equal(rows.find(item => item.label === 'Wall calendar').selectedProfile, 'Home')
    assert.ok(rows.find(item => item.label === 'iPhone').current)
    assert.ok(!rows.find(item => item.label === 'Wall calendar').current)
    // Renaming a person appears automatically, with no stale session label.
    db.prepare('UPDATE people SET name = ? WHERE id = ?').run('Robert', 1)
    rows = await devicesFor(wall)
    assert.equal(rows.find(item => item.label === 'iPhone').selectedProfile, 'Robert')
    // Removing the person causes an unselected label, not a dead name.
    db.prepare('DELETE FROM people WHERE id = ?').run(1)
    rows = await devicesFor(phone)
    assert.equal(rows.find(item => item.label === 'iPhone').selectedProfile, null)
    assert.equal(rows.find(item => item.label === 'Wall calendar').selectedProfile, 'Home')
    // Revoked devices cannot update the metadata or appear on the screen.
    const wallRow = rows.find(item => item.label === 'Wall calendar')
    const revoked = await fetch(site.base + '/api/auth/devices/' + wallRow.id + '/revoke', {
      method: 'POST', headers: { Cookie: phone, Origin: site.origin },
    })
    assert.equal(revoked.status, 200)
    assert.equal((await select(wall, site.origin, { kind: 'home' })).status, 401)
    assert.equal((await devicesFor(phone)).length, 1)
    const accountPage = await fetch(site.base + '/auth/account.js')
    assert.match(await accountPage.text(), /Profile: /)
  } finally {
    await site.close()
    db.close()
  }
})
