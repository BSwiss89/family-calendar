// Disposable real-browser geometry check; never touches LIVE, TEST, SQLite,
// sessions or a running calendar. Uses production CSS for iPhone WebKit.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const { chromium, webkit } = await import(process.env.FAMILY_CALENDAR_PLAYWRIGHT_MODULE || 'playwright')
const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8') + '\n' +
  readFileSync(new URL('../src/FamilyDailyNotes.css', import.meta.url), 'utf8')
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body><main class="calendar-app"><section class="home-dashboard">
<div class="home-widget-grid" id="grid">
<section class="home-widget home-widget-notes home-widget-size-small home-widget-width-half" id="note-card">
<div class="home-widget-heading" id="title"><span>Notes</span></div>
<div class="family-daily-notes"><textarea aria-label="Shared family note" rows="3"></textarea>
<div class="family-daily-notes-bottom"><span>Shared today</span></div></div></section></div></section></main>
<div class="quick-add-overlay"><div class="quick-add-sheet" id="sheet">
<div class="quick-add-header"><div><span class="quick-add-eyebrow">Add something</span><h2>Quick Add</h2></div><button class="quick-add-close">×</button></div>
<div class="quick-add-options" id="options">
${['Event','List','Recipe','Photo / Screenshot'].map((label,i)=>`<button class="quick-add-option" data-original="${i}"><span class="quick-add-option-icon">+</span><span class="quick-add-option-text"><strong>${label}</strong><small>Add or manage</small></span></button>`).join('')}
<button class="quick-add-option quick-add-settings-option" id="settings"><span class="quick-add-option-icon">⚙</span><span class="quick-add-option-text"><strong>Settings</strong><small>Calendar and family preferences</small></span></button>
</div></div></div></body></html>`

test('Home headers align at top, and all five Quick Add actions fit without shrinking four tiles', { timeout: 120000 }, async () => {
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
            const sheetEl = document.querySelector('#sheet')
            const sheet = box(sheetEl)
            const title = box(document.querySelector('#title'))
            const card = box(document.querySelector('#note-card'))
            const note = box(document.querySelector('.family-daily-notes textarea'))
            return { original, settings, sheet, title, card, note, sheetScrollHeight: sheetEl.scrollHeight, sheetClientHeight: sheetEl.clientHeight }
          })
          const where = engine + ' ' + viewport.width + 'x' + viewport.height
          assert.equal(measurements.original.length, 4, where + ': lost original actions')
          for (const tile of measurements.original) assert.ok(tile.height >= 112, where + ': original tile was shrunk')
          assert.ok(measurements.settings.height >= 40 && measurements.settings.height <= 64, where + ': Settings row is not compact')
          assert.ok(measurements.settings.y >= measurements.original[2].bottom, where + ': Settings overlaps the original tiles')
          assert.ok(measurements.settings.width >= measurements.original[0].width * 1.9, where + ': Settings is not full width')
          assert.ok(measurements.sheet.y >= 0 && measurements.sheet.bottom <= viewport.height + 1, where + ': Quick Add exceeds available viewport')
          assert.ok(measurements.sheetScrollHeight <= measurements.sheetClientHeight + 1, where + ': Quick Add requires vertical scrolling')
          assert.ok(measurements.title.y - measurements.card.y <= 24, where + ': Home title has unnecessary top gap')
          assert.ok(measurements.note.right <= measurements.card.right + 1, where + ': Notes textarea extends outside card')
        } finally { await page.close() }
      }
    } finally { await browser.close() }
  }
})
