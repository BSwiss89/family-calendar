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

test('Home editor is entered from a long-held visible three-line card handle', () => {
  assert.match(app, /className="home-widget-grip"/)
  assert.match(app, /setActivatorNodeRef/)
  assert.match(app, /onPointerDown=\{enabled[\s\S]*?listeners\?\.onPointerDown\?\.\(event\)/)
  assert.match(app, /onKeyDown=\{enabled[\s\S]*?listeners\?\.onKeyDown\?\.\(event\)/)
  assert.match(app, /onEnterEdit\(\)/)
  assert.match(app, /\}, 650\)/)
  assert.equal((app.match(/onEnterEdit=\{\(\) => setIsEditingHome\(true\)\}/g) || []).length, 6)
  assert.match(css, /home-widget-grip-bars > span:nth-child\(3\)/)
  assert.match(app, /Done Editing/)
})

test('small mobile cards can occupy one of two columns and narrow weather scales down', () => {
  assert.match(css, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/)
  assert.match(css, /home-widget\.home-widget-size-small\s*\{\s*grid-column: span 1;/)
  assert.match(css, /@container \(max-width: 235px\)/)
  assert.match(css, /home-weather-active \.home-weather-temperature\s*\{[\s\S]*?font-size: 36px;/)
  assert.match(app, /saveHomeWidgetLayout\(\{/)
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
    })
    saveHomeWidgetLayout(saved)
    assert.deepEqual(readHomeWidgetLayout(), saved)

    values.set('family-calendar-home-widget-layout-v1', '{broken json')
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
