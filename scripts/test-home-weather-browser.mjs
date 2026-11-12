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
        <div class="home-weather-art-panel" aria-hidden="true">
          <div class="home-weather-artwork weather-theme-cloudy" aria-hidden="true">
            <div class="weather-art-sun weather-art-sun-behind"></div>
            <div class="weather-art-cloud weather-art-cloud-main"></div>
          </div>
        </div>
        <div class="home-weather-temperature-panel">
          <strong class="home-weather-temperature">71°</strong>
        </div>
      </div>
      <div class="home-weather-details">
        <span class="home-weather-detail-pill"><span class="home-weather-detail-label">Feels like</span><strong>75°</strong></span>
        <span class="home-weather-detail-pill"><span class="home-weather-detail-label">High / Low</span><strong>H 72° · L 60°</strong></span>
        <span class="home-weather-detail-pill"><span class="home-weather-detail-label">Rain</span><strong>68%</strong></span>
      </div>
    </div>
    <a class="home-weather-source" href="https://open-meteo.com/">Weather by Open-Meteo</a>
  </div>
</section>
<section class="home-widget home-widget-today home-widget-size-small home-widget-width-half" id="neighbor">Today</section>
</div></section></div></body></html>`


function box(element) {
  const r = element.getBoundingClientRect()
  return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}
}
function overlap(a,b) {
  return Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left)) *
         Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top))
}

test('original weather illustration stays in a soft panel and all forecast panels reflow', {timeout:120000}, async () => {
  for (const [engine,driver] of [['chromium',chromium],['webkit',webkit]]) {
    const browser=await driver.launch({headless:true})
    try {
      for (const viewportWidth of [390,1024]) {
        const page=await browser.newPage({
          viewport:{width:viewportWidth,height:900},isMobile:viewportWidth===390,hasTouch:viewportWidth===390,
        })
        try {
          await page.setContent(html,{waitUntil:'domcontentloaded'})
          for (const width of ['half','full']) for (const height of ['small','medium','large']) for (const editing of [false,true]) {
            const result=await page.evaluate(({width,height,editing})=>{
              const grid=document.querySelector('#grid')
              const card=document.querySelector('#card')
              card.className='home-widget home-widget-weather home-widget-size-'+height+' home-widget-width-'+width
              grid.classList.toggle('home-widget-grid-editing',editing)
              document.querySelector('#controls').hidden=!editing
              const box=selector=>{const r=document.querySelector(selector).getBoundingClientRect()
                return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}
              const range=document.createRange()
              range.selectNodeContents(document.querySelector('.home-weather-title'))
              const pills=[...document.querySelectorAll('.home-weather-detail-pill')].map(node=>{
                const r=node.getBoundingClientRect()
                const t=node.querySelector('strong').getBoundingClientRect()
                return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,
                        textLeft:t.left,textRight:t.right,textBottom:t.bottom}
              })
              return {card:box('#card'),weather:box('#weather'),art:box('.home-weather-art-panel'),
                artDisplay:getComputedStyle(document.querySelector('.home-weather-artwork')).display,
                artScale:getComputedStyle(document.querySelector('.home-weather-artwork')).transform,
                tempPanel:box('.home-weather-temperature-panel'),
                temp:box('.home-weather-temperature'),pills,details:box('.home-weather-details'),
                controls:box('#controls'),source:box('.home-weather-source'),
                titleRight:range.getBoundingClientRect().right,
                gear:box('.home-weather-settings-button'),
                color:getComputedStyle(document.querySelector('.home-weather-title')).color,
                tempFont:parseFloat(getComputedStyle(document.querySelector('.home-weather-temperature')).fontSize),
                scrollExcess:document.querySelector('#weather').scrollHeight-document.querySelector('#weather').clientHeight,
              }
            },{width,height,editing})
            const info=engine+' '+viewportWidth+'px '+width+'/'+height+' edit='+editing
            assert.ok(result.card.width>=130,info+': card too narrow')
            assert.ok(result.art.width>=25&&result.art.height>=25,info+': illustrated panel collapsed')
            assert.ok(result.tempPanel.width>=25&&result.tempPanel.height>=25,info+': temperature panel collapsed')
            assert.ok(overlap(result.art,result.tempPanel)<=1,info+': artwork and temperature panels overlap')
            assert.equal(result.artDisplay,'block',info+': original sun/cloud artwork hidden')
            assert.notEqual(result.artScale,'none',info+': artwork has no responsive scale')
            assert.ok(result.temp.left>=result.tempPanel.left-1&&result.temp.right<=result.tempPanel.right+1,
              info+': temperature outside glass panel')
            assert.ok(result.tempFont>=27,info+': temperature is too small')
            assert.equal(result.pills.length,3,info+': needs three independent glass forecast panels')
            for (const [i,p] of result.pills.entries()) {
              assert.ok(p.height>=13,info+': forecast panel '+i+' collapsed')
              assert.ok(p.textLeft>=p.left-1&&p.textRight<=p.right+1,info+': forecast value '+i+' overflows')
              assert.ok(p.textBottom<=p.bottom+1,info+': forecast value '+i+' vertical overflow')
              assert.ok(overlap(p,result.art)<=1&&overlap(p,result.tempPanel)<=1,
                info+': forecast panel '+i+' overlaps temperature or artwork')
            }
            for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)
              assert.ok(overlap(result.pills[i],result.pills[j])<=1,info+': forecast panels overlap')
            assert.ok(result.pills[2].bottom<=result.card.bottom+1,info+': forecast below card')
            if(!editing){
              assert.ok(result.source.bottom<=result.card.bottom+1,info+': attribution below card')
              assert.ok(result.titleRight<=result.gear.left+4,info+': settings overlaps title')
            }else{
              assert.ok(result.art.top>=result.controls.bottom-3,info+': editor controls overlap art')
              assert.ok(result.tempPanel.top>=result.controls.bottom-3,info+': editor controls overlap temperature')
            }
            if(viewportWidth===390&&width==='half') {
              assert.ok(result.pills[0].top<result.pills[1].top&&result.pills[1].top<result.pills[2].top,
                info+': compact glass panels must stack vertically')
            }
            assert.equal(result.color,'rgb(23, 59, 83)',info+': cloudy theme text must be dark enough')
            // Decorative sun/cloud pseudo-elements can extend outside their
            // clipped panel, so scrollHeight is not a reliable readability test.
            // Assert the actual text and glass panels stay within the card above.
          }
          const dark=await page.evaluate(()=>{
            document.querySelector('#grid').classList.remove('home-widget-grid-editing')
            document.querySelector('#weather').className='home-weather home-weather-active weather-theme-rain'
            return getComputedStyle(document.querySelector('.home-weather-title')).color
          })
          assert.equal(dark,'rgb(255, 255, 255)',engine+' '+viewportWidth+': dark storm theme should keep white text')
        }finally{await page.close()}
      }
    }finally{await browser.close()}
  }
})
