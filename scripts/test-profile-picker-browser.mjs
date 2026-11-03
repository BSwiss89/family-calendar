// Disposable browser fixture: mocked APIs, loopback Vite, no calendar/database.
// npm install --no-save --package-lock=false playwright@1.62.1
// npx playwright install chromium
// node --test scripts/test-profile-picker-browser.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const { chromium } = await import(process.env.FAMILY_CALENDAR_PLAYWRIGHT_MODULE || 'playwright')
const key = 'family-calendar.profile.v1.legacy.familyadmin'
const html = `<!doctype html><html><head></head><body><div id="root"></div>
<script type="module">
import React, {useState, useCallback} from 'react';
import {createRoot} from 'react-dom/client';
import Picker from '/src/HouseholdProfilePicker.tsx';
function Fixture() {
  const [revision, setRevision] = useState(0);
  const [switchRequest, setSwitch] = useState(0);
  const [active, setActive] = useState(null);
  const [created, setCreated] = useState([]);
  const change = useCallback((name, id) => setActive({name, id}), []);
  const add = useCallback(person => setCreated(rows => [...rows, person]), []);
  window.refreshPeople = () => setRevision(value => value + 1);
  return React.createElement(React.Fragment, null,
    React.createElement('output', {id:'active'}, JSON.stringify(active)),
    React.createElement('output', {id:'created'}, JSON.stringify(created)),
    React.createElement('button', {onClick:()=>setSwitch(n=>n+1)}, 'Switch Profile'),
    React.createElement(Picker, {switchRequest, peopleRevision:revision,
      onProfileChange:change, onProfileCreated:add}));
}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null,
  React.createElement(Fixture)));
</script></body></html>`

test('profile lifecycle in the real React picker', {timeout: 90000}, async t => {
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    server: {host: '127.0.0.1', port: 0},
  })
  server.middlewares.use('/__profile_fixture', async (_req, res, next) => {
    try {
      res.setHeader('Content-Type', 'text/html')
      res.end(await server.transformIndexHtml('/__profile_fixture', html))
    } catch (error) { next(error) }
  })
  let browser
  try {
    await server.listen()
    browser = await chromium.launch({headless: true, executablePath: process.env.FAMILY_CALENDAR_CHROMIUM || undefined})
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`

    async function fixture({remember = 'person:1', blocked = false, failSync = false} = {}) {
      const context = await browser.newContext({viewport: {width: 390, height: 844}})
      t.after(() => context.close())
      await context.addInitScript(({key, remember, blocked}) => {
        if (remember) localStorage.setItem(key, remember)
        if (blocked) {
          for (const method of ['getItem', 'setItem']) {
            Storage.prototype[method] = () => { throw new DOMException('Storage blocked', 'SecurityError') }
          }
        }
      }, {key, remember, blocked})
      const page = await context.newPage()
      const state = {
        people: [{id:1, name:'Bobby', color:'#3a82f6', image:null},
          {id:2, name:'Haylee', color:'#ff66aa', image:null}],
        creates: 0, selected: null, failSync,
      }
      await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname
        const send = (json, status = 200) => route.fulfill({status, json})
        if (path === '/api/auth/status') {
          return send({enabled:true, authenticated:true, username:'familyadmin'})
        }
        if (path === '/api/people' && route.request().method() === 'GET') return send(state.people)
        if (path === '/api/people' && route.request().method() === 'POST') {
          state.creates++
          const person = {id:3, name:'New member', color:'#3a82f6', image:null}
          state.people.push(person)
          return send(person)
        }
        if (path === '/api/auth/device-profile') {
          if (state.failSync) return send({error:'Temporary device save failure'}, 503)
          state.selected = route.request().postDataJSON()
          return send({ok:true})
        }
        throw new Error(`Unexpected API: ${path}`)
      })
      await page.goto(origin + '/__profile_fixture')
      return {page, state}
    }

    async function active(page, name, id) {
      await page.waitForFunction(expected =>
        document.querySelector('#active')?.textContent === JSON.stringify(expected), {name, id})
    }

    await t.test('rename updates the active label; deletion clears it and requires a new choice', async () => {
      const {page, state} = await fixture()
      await active(page, 'Bobby', 1)
      state.people[0].name = 'Robert'
      await page.evaluate(() => window.refreshPeople())
      await active(page, 'Robert', 1)
      state.people = state.people.filter(person => person.id !== 1)
      await page.evaluate(() => window.refreshPeople())
      await active(page, null, null)
      await page.getByRole('heading', {name:"Who's using the calendar?"}).waitFor()
      assert.equal(await page.getByRole('button', {name:'Robert Personal profile'}).count(), 0)
      await page.getByRole('button', {name:'Haylee Personal profile'}).click()
      await active(page, 'Haylee', 2)
      assert.deepEqual(state.selected, {kind:'person', personId:2})
    })

    for (const blocked of [false, true]) {
      await t.test(`create updates the app without reloading (storage blocked=${blocked})`, async () => {
        const {page, state} = await fixture({remember:null, blocked})
        await page.evaluate(() => { window.navigationSentinel = 'still here' })
        await page.getByRole('button', {name:'Create Profile New household member'}).click()
        await page.getByLabel('Profile name', {exact:true}).fill('New member')
        await page.getByRole('button', {name:'Create & Continue'}).click()
        await active(page, 'New member', 3)
        assert.equal(state.creates, 1)
        assert.equal(await page.evaluate(() => window.navigationSentinel), 'still here')
        assert.equal(JSON.parse(await page.locator('#created').textContent())[0].id, 3)
        if (blocked) {
          await page.getByRole('status').filter({hasText:'cannot remember'}).waitFor()
          state.people.find(person => person.id === 3).name = 'Renamed member'
          await page.evaluate(() => window.refreshPeople())
          await active(page, 'Renamed member', 3)
        }
      })
    }

    await t.test('a created profile survives a failed device save without being submitted twice', async () => {
      const {page, state} = await fixture({remember:null, failSync:true})
      await page.getByRole('button', {name:'Create Profile New household member'}).click()
      await page.getByLabel('Profile name', {exact:true}).fill('New member')
      await page.getByRole('button', {name:'Create & Continue'}).click()
      await page.getByRole('alert').filter({hasText:'Profile created.'}).waitFor()
      assert.equal(JSON.parse(await page.locator('#created').textContent())[0].id, 3)
      state.failSync = false
      await page.getByRole('button', {name:'New member Personal profile'}).click()
      await active(page, 'New member', 3)
      assert.equal(state.creates, 1)
    })
  } finally {
    await browser?.close()
    await server.close()
  }
})
