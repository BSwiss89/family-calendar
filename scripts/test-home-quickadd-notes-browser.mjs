// Disposable real-browser geometry check; never touches LIVE, TEST, SQLite,
// sessions or a running calendar. Uses production CSS for iPhone WebKit.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const { chromium, webkit } = await import(process.env.FAMILY_CALENDAR_PLAYWRIGHT_MODULE || 'playwright')
const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8') + '\n' +
  readFileSync(new URL('../src/App.css', import.meta.url), 'utf8') + '\n' +
  readFileSync(new URL('../src/FamilyDailyNotes.css', import.meta.url), 'utf8')
const notesComponent = readFileSync(new URL('../src/FamilyDailyNotes.tsx', import.meta.url), 'utf8')
const fontCode = notesComponent.match(/^function fitNoteFont\(textarea: HTMLTextAreaElement\) \{[\s\S]*?^\}/m)?.[0]?.replace(': HTMLTextAreaElement', '')
assert.ok(fontCode, 'real responsive text fitter exists in Notes component')
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body><main class="calendar-app"><section class="home-dashboard">
<div class="home-widget-grid" id="grid">
<section class="home-widget home-widget-notes home-widget-size-small home-widget-width-half" id="note-card">
<div class="home-widget-heading" id="title"><span>Notes</span></div>
<div class="family-daily-notes"><textarea aria-label="Shared family note" id="daily-note" rows="3"></textarea></div></section></div></section></main>
<div class="quick-add-overlay"><div class="quick-add-sheet quick-add-actions-sheet" id="sheet">
<div class="quick-add-header"><div><span class="quick-add-eyebrow">Add something</span><h2>Quick Add</h2></div><button class="quick-add-close">×</button></div>
<div class="quick-add-options" id="options">
${['Add Event','Add List Item','Add Recipe','Add Photo'].map((label,i)=>`<button class="quick-add-option" data-original="${i}"><span class="quick-add-option-icon">+</span><span class="quick-add-option-text"><strong>${label}</strong><small>Add or manage</small></span></button>`).join('')}
<button class="quick-add-option quick-add-settings-option" id="settings"><span class="quick-add-option-icon">⚙</span><span class="quick-add-option-text"><strong>Settings</strong><small>Calendar and family preferences</small></span></button>
<button class="quick-add-option quick-add-arney-option" id="ask-arney"><span class="quick-add-option-icon">✦</span><span class="quick-add-option-text"><strong>Ask Arney</strong><small>Type a question or request</small></span><span class="quick-add-arney-new">NEW</span></button>
</div></div></div><script>${fontCode}</script></body></html>`

test('Home headers align at top, and six floating Quick Add rows fit phone screens without scrolling', { timeout: 120000 }, async () => {
  for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await driver.launch({ headless: true })
    try {
      for (const viewport of [{ width: 375, height: 667 }, { width: 390, height: 844 }, { width: 402, height: 874 }]) {
        const page = await browser.newPage({ viewport, isMobile: true, hasTouch: true })
        try {
          await page.setContent(html, { waitUntil: 'domcontentloaded' })
          const measurements = await page.evaluate(() => {
            const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom } }
            const original = [...document.querySelectorAll('[data-original]')].map(box)
            const settings = box(document.querySelector('#settings'))
            const arney = box(document.querySelector('#ask-arney'))
            const actions = [...document.querySelectorAll('#options > button')].map(box)
            const visualLayout = getComputedStyle(document.querySelector('#options')).flexDirection
            const sheetEl = document.querySelector('#sheet')
            const sheet = box(sheetEl)
            const title = box(document.querySelector('#title'))
            const card = box(document.querySelector('#note-card'))
            const note = box(document.querySelector('.family-daily-notes textarea'))
            return { original, settings, arney, actions, visualLayout, sheet, title, card, note, sheetOverflow: getComputedStyle(sheetEl).overflowY, sheetScrollHeight: sheetEl.scrollHeight, sheetClientHeight: sheetEl.clientHeight }
          })
          const where = engine + ' ' + viewport.width + 'x' + viewport.height
          assert.equal(measurements.original.length, 4, where + ': lost original actions')
          assert.equal(measurements.actions.length, 6, where + ': exactly six actions expected')
          assert.equal(measurements.visualLayout, 'column', where + ': Quick Add is not a single list')
          for (const [index, row] of measurements.actions.entries()) {
            assert.ok(row.height >= 44 && row.height <= 52, where + ': menu row ' + index + ' not compact')
            assert.ok(Math.abs(row.x - measurements.actions[0].x) <= 1, where + ': menu rows not vertically aligned')
            assert.ok(Math.abs(row.width - measurements.actions[0].width) <= 1, where + ': menu row widths differ')
            if (index > 0) assert.ok(row.y >= measurements.actions[index - 1].bottom - 1,
              where + ': menu row overlaps preceding row')
          }
          assert.ok(measurements.settings.y >= measurements.original[3].bottom - 1, where + ': Settings is out of order')
          assert.ok(measurements.arney.y >= measurements.settings.bottom - 1, where + ': Ask Arney is out of order')
          assert.ok(measurements.sheet.width < viewport.width * .87, where + ': menu is not a compact popup')
          assert.ok(measurements.sheet.right <= viewport.width + 1 && measurements.sheet.right >= viewport.width - 19,
            where + ': menu is not anchored near the blue plus')
          assert.ok(measurements.sheet.y >= 0 && measurements.sheet.bottom <= viewport.height + 1, where + ': Quick Add exceeds available viewport')
          assert.ok(measurements.sheetScrollHeight <= measurements.sheetClientHeight + 12,
            where + ': menu contents overflow more than the decorative 7px pointer tail')
          assert.ok(measurements.sheetOverflow === 'visible',
            where + ': Quick Add popup unexpectedly has scrolling enabled')
          assert.ok(measurements.actions[5].bottom <= measurements.sheet.bottom + 1,
            where + ': final Ask Arney row is clipped below the popup')
          assert.ok(measurements.title.y - measurements.card.y <= 24, where + ': Home title has unnecessary top gap')
          assert.ok(measurements.note.right <= measurements.card.right + 1, where + ': Notes textarea extends outside card')
          assert.ok(measurements.note.height >= 100, where + ': Notes editor does not fill available card space')
          assert.ok(measurements.note.bottom <= measurements.card.bottom + 1, where + ': Notes editor extends below card')
          assert.ok(measurements.note.bottom >= measurements.card.bottom - 35, where + ': Notes editor wastes bottom card space')
          const fontChecks = await page.evaluate(() => {
            const card = document.querySelector('#note-card')
            const note = document.querySelector('#daily-note')
            note.value = 'Milk'
            fitNoteFont(note)
            const largeFont = parseFloat(getComputedStyle(note).fontSize)
            note.value = ('Remember the groceries, the bills, the appointment and the family schedule. ').repeat(15)
            fitNoteFont(note)
            const denseFont = parseFloat(getComputedStyle(note).fontSize)
            const canScroll = getComputedStyle(note).overflowY === 'auto'
            card.classList.replace('home-widget-size-small', 'home-widget-size-large')
            const grownHeight = note.getBoundingClientRect().height
            note.value = 'Milk'
            fitNoteFont(note)
            const expandedFont = parseFloat(getComputedStyle(note).fontSize)
            return { largeFont, denseFont, expandedFont, grownHeight, canScroll, noFooter: !document.querySelector('.family-daily-notes-bottom') }
          })
          assert.ok(fontChecks.noFooter, where + ': permanent Notes footer returned')
          assert.ok(fontChecks.largeFont >= 23 && fontChecks.largeFont <= 26, where + ': short note did not grow')
          assert.ok(fontChecks.denseFont >= 16 && fontChecks.denseFont < fontChecks.largeFont, where + ': dense note did not shrink')
          assert.ok(fontChecks.canScroll, where + ': dense notes must remain scrollable instead of clipped')
          assert.ok(fontChecks.grownHeight >= measurements.note.height + 100, where + ': editor did not fill taller Notes card')
          assert.ok(fontChecks.expandedFont >= 23, where + ': text did not reflow in expanded Notes card')
        } finally { await page.close() }
      }
    } finally { await browser.close() }
  }
})
