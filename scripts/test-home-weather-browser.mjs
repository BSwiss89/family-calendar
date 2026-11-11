import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const { chromium, webkit } = await import(process.env.FAMILY_CALENDAR_PLAYWRIGHT_MODULE || 'playwright')
const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style><style>.home-widget-layout-controls[hidden]{display:none!important}</style></head><body>
<div class="calendar-app"><section class="home-dashboard">
<div class="home-widget-grid" id="grid">
<section class="home-widget home-widget-weather home-widget-size-small home-widget-width-half" id="card">
  <div class="home-widget-layout-controls" id="controls" hidden>
    <button class="home-widget-resize-button" type="button">Height: Small</button>
    <button class="home-widget-width-button" type="button">Width: Half</button>
  </div>
  <div class="home-weather home-weather-active weather-theme-cloudy" id="weather">
    <div class="home-weather-title">Weather</div>
    <button class="home-weather-settings-button" type="button" aria-label="Weather settings">⚙</button>
    <div class="home-weather-current">
      <div class="home-weather-location">Home · 77375</div>
      <div class="home-weather-main">
        <div class="home-weather-artwork weather-theme-cloudy" aria-hidden="true">
          <div class="weather-art-sun weather-art-sun-behind"></div>
          <div class="weather-art-cloud weather-art-cloud-main"></div>
        </div>
        <span class="home-weather-compact-icon" aria-hidden="true">🌤️</span>
        <strong class="home-weather-temperature">71°</strong>
      </div>
      <div class="home-weather-details">
        <span>Feels like 75°</span>
        <span>H 72° · L 60°</span>
        <span>Rain 68%</span>
      </div>
    </div>
    <a class="home-weather-source" href="https://open-meteo.com/">Weather by Open-Meteo</a>
  </div>
</section>
<section class="home-widget home-widget-today home-widget-size-small home-widget-width-half" id="neighbor">Today</section>
</div></section></div></body></html>`

function rect(element) {
  const r = element.getBoundingClientRect()
  return {left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height}
}

test('weather stays readable at half/full width and all three vertical heights in Chromium and iPhone WebKit', {timeout:90000}, async () => {
  for (const [name, driver] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await driver.launch({headless:true})
    try {
      const page = await browser.newPage({
        viewport:{width:390,height:844}, isMobile:true, hasTouch:true,
      })
      try {
        await page.setContent(html, {waitUntil:'domcontentloaded'})
        for (const width of ['half', 'full']) {
          for (const height of ['small', 'medium', 'large']) {
            const result = await page.evaluate(({width, height}) => {
              const card = document.querySelector('#card')
              card.className = `home-widget home-widget-weather home-widget-size-${height} home-widget-width-${width}`
              const weather = document.querySelector('#weather')
              weather.className = 'home-weather home-weather-active weather-theme-cloudy'
              const get = selector => {
                const r = document.querySelector(selector).getBoundingClientRect()
                return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}
              }
              const icon = document.querySelector('.home-weather-compact-icon')
              const art = document.querySelector('.home-weather-artwork')
              const details = document.querySelector('.home-weather-details')
              const title = document.querySelector('.home-weather-title')
              const titleRange = document.createRange()
              titleRange.selectNodeContents(title)
              return {
                card:get('#card'),icon:get('.home-weather-compact-icon'),
                art:get('.home-weather-artwork'),temp:get('.home-weather-temperature'),
                main:get('.home-weather-main'),details:get('.home-weather-details'),
                source:get('.home-weather-source'),title:{right:titleRange.getBoundingClientRect().right},
                gear:get('.home-weather-settings-button'),
                textColor:getComputedStyle(title).color,
                iconDisplay:getComputedStyle(icon).display,
                artDisplay:getComputedStyle(art).display,
                innerScroll:weather.scrollHeight > weather.clientHeight + 4,
                maxScroll:weather.scrollHeight-weather.clientHeight,
                neighbor:get('#neighbor'),
              }
            }, {width,height})
            const info = `${name} ${width} ${height}`
            assert.ok(result.card.width > 130, `${info}: card isn't wide enough`)
            assert.ok(result.temp.right <= result.card.right - 5, `${info}: temperature clipped horizontally`)
            assert.ok(result.temp.left >= result.card.left + 5, `${info}: temperature clipped at left`)
            assert.ok(result.details.top >= result.temp.bottom - 3, `${info}: weather facts overlap temperature`)
            assert.ok(result.title.right <= result.gear.left + 3, `${info}: settings overlaps title`)
            assert.equal(result.textColor, 'rgb(22, 59, 81)', `${info}: cloudy label should be high-contrast navy`)
            if (width === 'half' || height === 'small') {
              assert.notEqual(result.iconDisplay, 'none', `${info}: compact icon missing`)
              assert.equal(result.artDisplay, 'none', `${info}: art should not collide on a compact card`)
              assert.ok(result.icon.right <= result.temp.left + 3, `${info}: icon overlaps temperature`)
            } else {
              assert.equal(result.iconDisplay, 'none', `${info}: redundant emoji in illustrated view`)
              assert.notEqual(result.artDisplay, 'none', `${info}: illustrated view missing`)
              assert.ok(result.art.right <= result.temp.left + 3, `${info}: illustration overlaps temperature`)
            }
            assert.ok(result.source.bottom <= result.card.bottom + 4, `${info}: source outside the card`)
            assert.ok(result.details.bottom <= result.card.bottom + 3, `${info}: facts below card`)
            if (height === 'small') assert.equal(result.innerScroll, false, `${info}: small card hides facts below a scroll`)
            if (width === 'half') assert.ok(Math.abs(result.card.width-result.neighbor.width) < 5, `${info}: neighbors not equal half widths`)
          }
        }
        const dark = await page.evaluate(() => {
          const weather = document.querySelector('#weather')
          weather.className = 'home-weather home-weather-active weather-theme-rain'
          return getComputedStyle(document.querySelector('.home-weather-title')).color
        })
        assert.equal(dark,'rgb(255, 255, 255)',`${name}: rain theme should use white text`)
        await page.evaluate(() => {
          const grid = document.querySelector('#grid')
          const card = document.querySelector('#card')
          grid.classList.add('home-widget-grid-editing')
          card.className = 'home-widget home-widget-weather home-widget-size-small home-widget-width-half'
          document.querySelector('#controls').hidden = false
          document.querySelector('#weather').className = 'home-weather home-weather-active weather-theme-cloudy'
        })
        const edit = await page.evaluate(() => {
          const a = document.querySelector('#controls').getBoundingClientRect()
          const b = document.querySelector('.home-weather-temperature').getBoundingClientRect()
          const c = document.querySelector('.home-weather-details').getBoundingClientRect()
          return {controlsBottom:a.bottom, tempTop:b.top, detailsTop:c.top,tempBottom:b.bottom}
        })
        assert.ok(edit.tempTop >= edit.controlsBottom - 3,`${name}: editing controls overlap temperature`)
        assert.ok(edit.detailsTop >= edit.tempBottom - 3,`${name}: edit mode weather facts overlap temperature`)
      } finally {
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }
})
