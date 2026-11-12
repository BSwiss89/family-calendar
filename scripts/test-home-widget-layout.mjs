import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  HOME_WIDGET_IDS,
  normalizeHomeWidgetLayout,
  readHomeWidgetLayout,
  saveHomeWidgetLayout,
} from '../src/homeWidgetLayout.ts'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')

test('defaults include six Home widgets in their established order and sizes', () => {
  const layout = normalizeHomeWidgetLayout(null)
  assert.deepEqual(layout.order, [...HOME_WIDGET_IDS])
  assert.equal(layout.sizes.weather, 'medium')
  assert.equal(layout.sizes.upcoming, 'small')
  assert.equal(layout.sizes.lists, 'large')
})

test('valid device-local layout order and sizes round-trip through normalization', () => {
  const order = [...HOME_WIDGET_IDS].reverse()
  const layout = normalizeHomeWidgetLayout({
    order,
    sizes: { weather: 'small', today: 'large', upcoming: 'medium' },
  })
  assert.deepEqual(layout.order, order)
  assert.equal(layout.sizes.weather, 'small')
  assert.equal(layout.sizes.today, 'large')
  assert.equal(layout.sizes.upcoming, 'medium')
  assert.equal(layout.sizes.notes, 'medium')
})

test('invalid, duplicate, or missing widget IDs reset the order and invalid sizes are ignored', () => {
  for (const order of [
    ['weather', 'weather', 'today', 'notes', 'meals', 'lists'],
    ['weather', 'today'],
    [...HOME_WIDGET_IDS, 'unexpected'],
  ]) {
    assert.deepEqual(normalizeHomeWidgetLayout({
      order, sizes: { weather: 'gigantic', lists: 'small' },
    }).order, [...HOME_WIDGET_IDS])
  }
  const layout = normalizeHomeWidgetLayout({
    order: [...HOME_WIDGET_IDS], sizes: { weather: 'gigantic', lists: 'small' },
  })
  assert.equal(layout.sizes.weather, 'medium')
  assert.equal(layout.sizes.lists, 'small')
})

test('press and hold any noninteractive card area to edit; grips mount only in edit mode', () => {
  assert.match(app, /function beginHold\(event: PointerEvent<HTMLElement>\)/)
  assert.match(app, /target\.closest\('button, a, input, textarea, select/)
  assert.match(app, /onPointerDown=\{enabled \? undefined : beginHold\}/)
  assert.match(app, /onPointerMove=\{enabled \? undefined : moveHold\}/)
  assert.match(app, /onPointerCancel=\{cancelHold\}/)
  assert.match(app, /onPointerLeave=\{cancelHold\}/)
  assert.match(app, /\}, 650\)/)
  assert.match(app, /\{enabled && \(\s*<>[\s\S]*?className="home-widget-grip"/)
  assert.match(app, /setActivatorNodeRef/)
  assert.match(css, /home-widget-grip-bars > span:nth-child\(3\)/)
  assert.match(app, /Done Editing/)
})

test('all six cards independently choose height and width during editing', () => {
  assert.equal((app.match(/onEnterEdit=\{\(\) => setIsEditingHome\(true\)\}/g) ?? []).length, 6)
  assert.equal((app.match(/onCycleHeight=\{\(\) =>/g) ?? []).length, 6)
  assert.equal((app.match(/onToggleWidth=\{\(\) =>/g) ?? []).length, 6)
  assert.match(app, /Height: \{height\}/)
  assert.match(app, /Width: \{width\}/)
  assert.match(app, /widths: homeWidgetWidths/)
  assert.match(app, /saveHomeWidgetLayout\(\{/)
})

test('three distinct heights and both widths work independently on desktop and mobile', () => {
  const rules = css.slice(css.lastIndexOf('/* Home editor v2:'))
  assert.match(rules, /grid-auto-rows: 100px;/)
  assert.match(rules, /home-widget\.home-widget-size-small \{ grid-row: span 2; \}/)
  assert.match(rules, /home-widget\.home-widget-size-medium \{ grid-row: span 3; \}/)
  assert.match(rules, /home-widget\.home-widget-size-large \{ grid-row: span 4; \}/)
  assert.match(rules, /home-widget\.home-widget-width-half \{ grid-column: span 2; \}/)
  assert.match(rules, /home-widget\.home-widget-width-full \{ grid-column: span 4; \}/)
  assert.match(rules, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(rules, /home-widget\.home-widget-width-half \{\s*grid-column: span 1;/)
  assert.match(rules, /home-widget\.home-widget-width-full \{\s*grid-column: span 2;/)
  assert.match(rules, /home-widget-layout-controls/)
  assert.match(css, /@container \(max-width: 235px\)/)
})

test('all combinations of vertical size and horizontal width persist independently', () => {
  for (const height of ['small', 'medium', 'large']) {
    for (const width of ['half', 'full']) {
      const layout = normalizeHomeWidgetLayout({
        sizes: Object.fromEntries(HOME_WIDGET_IDS.map((id) => [id, height])),
        widths: Object.fromEntries(HOME_WIDGET_IDS.map((id) => [id, width])),
      })
      for (const id of HOME_WIDGET_IDS) {
        assert.equal(layout.sizes[id], height)
        assert.equal(layout.widths[id], width)
      }
    }
  }
})

test('v1 layout settings are migrated with their original mobile width behavior', () => {
  const layout = normalizeHomeWidgetLayout({
    order: [...HOME_WIDGET_IDS].reverse(),
    sizes: { weather: 'small', today: 'large', upcoming: 'medium' },
  })
  assert.equal(layout.widths.weather, 'half')
  assert.equal(layout.widths.today, 'full')
  assert.equal(layout.widths.upcoming, 'full')
})

test('device layout survives refresh and tolerates missing browser storage', () => {
  const originalWindow = globalThis.window
  const values = new Map()
  try {
    globalThis.window = {
      localStorage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
    }
    const saved = normalizeHomeWidgetLayout({
      order: [...HOME_WIDGET_IDS].reverse(),
      sizes: { weather: 'small', meals: 'large' },
      widths: { weather: 'full', meals: 'half' },
    })
    saveHomeWidgetLayout(saved)
    assert.deepEqual(readHomeWidgetLayout(), saved)

    values.set('family-calendar-home-widget-layout-v2', '{broken json')
    assert.deepEqual(readHomeWidgetLayout().order, [...HOME_WIDGET_IDS])
    globalThis.window = {
      localStorage: {
        getItem: () => { throw new Error('Storage disabled') },
        setItem: () => { throw new Error('Storage disabled') },
      },
    }
    assert.doesNotThrow(() => saveHomeWidgetLayout(saved))
    assert.deepEqual(readHomeWidgetLayout().order, [...HOME_WIDGET_IDS])
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})

test('legacy storage is read only when v2 has not been saved', () => {
  const originalWindow = globalThis.window
  const values = new Map([[
    'family-calendar-home-widget-layout-v1',
    JSON.stringify({
      sizes: { notes: 'small', lists: 'large' },
      order: [...HOME_WIDGET_IDS].reverse(),
    }),
  ]])
  try {
    globalThis.window = {
      localStorage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
      },
    }
    assert.equal(readHomeWidgetLayout().widths.notes, 'half')
    assert.deepEqual(readHomeWidgetLayout().order, [...HOME_WIDGET_IDS].reverse())
    const layout = normalizeHomeWidgetLayout({
      sizes: { notes: 'large' },
      widths: { notes: 'half' },
    })
    saveHomeWidgetLayout(layout)
    assert.ok(values.has('family-calendar-home-widget-layout-v2'))
    assert.deepEqual(readHomeWidgetLayout(), layout)
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
})
