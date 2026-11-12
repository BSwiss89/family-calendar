// Disposable browser test: real React popup, simulated profile selection,
// and no calls to a calendar server, database, weather service or LIVE site.
import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const { chromium, webkit } = await import(process.env.FAMILY_CALENDAR_PLAYWRIGHT_MODULE || 'playwright')
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body><div id="root"></div><script type="module">
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import ReleaseHighlights from '/src/ReleaseHighlights.tsx';
function Fixture(){
  const query = new URLSearchParams(window.location.search);
  const [person,setPerson] = useState(query.get('person')==='home'?null:1);
  const [account,setAccount] = useState('family-calendar.profile.v1.legacy.familyadmin');
  const [pending,setPending] = useState(query.get('pending')==='1');
  window.releaseFixture = {setPerson,setAccount,setPending};
  return React.createElement(React.Fragment,null,
    React.createElement('div',{id:'calendar'}, 'Calendar works normally'),
    React.createElement(ReleaseHighlights,{personId:person,accountKey:account,suppress:pending}));
}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));
</script></body></html>`

test('curated update notice is acknowledged once per person/device and yields to event alerts', {timeout:150000}, async t => {
  const server = await createServer({
    root:fileURLToPath(new URL('../', import.meta.url)),
    plugins:[react(),{name:'release-notes-fixture',configureServer(vite){
      vite.middlewares.use('/__release_fixture',async(_req,res,next)=>{
        try {res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__release_fixture',html))}
        catch(error){next(error)}
      })
    }}],
    server:{host:'127.0.0.1',port:0},
  })
  const browsers = []
  try {
    await server.listen()
    const origin = 'http://127.0.0.1:' + server.httpServer.address().port
    for (const [name, driver] of [['chromium',chromium],['webkit',webkit]]) {
      const browser=await driver.launch({headless:true})
      browsers.push(browser)
      await t.test(name+' iPhone-sized release acknowledgement', async()=>{
        const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})
        try {
          const page=await context.newPage()
          page.setDefaultTimeout(10000)
          page.on('pageerror',err=>{throw err})
          await page.goto(origin+'/__release_fixture')
          const notice=page.getByRole('dialog',{name:"What's new in Family Calendar"})
          await notice.waitFor()
          assert.equal(await notice.locator('li').count(),3)
          const rect=await notice.boundingBox()
          assert.ok(rect && rect.width<=390 && rect.x>=0 && rect.y>=0 && rect.y+rect.height<=844)
          assert.equal(await page.locator('#calendar').textContent(),'Calendar works normally')
          await notice.getByRole('button',{name:'Got it'}).click()
          await notice.waitFor({state:'hidden'})
          const count=await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.includes('release-notice.v1.')).length)
          assert.equal(count,1,'ack must be stored once on this browser')
          await page.reload()
          await page.waitForTimeout(1050)
          assert.equal(await notice.count(),0,'acknowledged update should not reopen after reload')

          await page.evaluate(()=>window.releaseFixture.setPerson(2))
          await notice.waitFor()
          await notice.getByRole('button',{name:'Maybe later'}).click()
          await notice.waitFor({state:'hidden'})
          await page.evaluate(()=>window.releaseFixture.setPerson(1))
          await page.evaluate(()=>window.releaseFixture.setPerson(2))
          await notice.waitFor()
          await notice.getByRole('button',{name:'Got it'}).click()
          assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.includes('release-notice.v1.')).length),2)
          await page.evaluate(()=>window.releaseFixture.setAccount('family-calendar.profile.v1.other-household.familyadmin'))
          await notice.waitFor()
          await notice.getByRole('button',{name:'Got it'}).click()
          assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.includes('release-notice.v1.')).length),3)
        }finally{await context.close()}
      })

      await t.test(name+' notifications take priority and Later never acknowledges',async()=>{
        const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})
        try {
          const page=await context.newPage()
          await page.goto(origin+'/__release_fixture?pending=1')
          await page.waitForTimeout(1050)
          const notice=page.getByRole('dialog',{name:"What's new in Family Calendar"})
          assert.equal(await notice.count(),0,'event invitation must take priority')
          await page.evaluate(()=>window.releaseFixture.setPending(false))
          await notice.waitFor()
          await notice.getByRole('button',{name:'Maybe later'}).click()
          await notice.waitFor({state:'hidden'})
          assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(k=>k.includes('release-notice.v1.')).length),0)
          await page.reload()
          await page.evaluate(()=>window.releaseFixture.setPending(false))
          await notice.waitFor()
          await page.keyboard.press('Escape')
          await notice.waitFor({state:'hidden'})
        }finally{await context.close()}
      })

      await t.test(name+' wall profile never receives a personal acknowledgement',async()=>{
        const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})
        try {
          const page=await context.newPage()
          await page.goto(origin+'/__release_fixture?person=home')
          await page.waitForTimeout(1050)
          assert.equal(await page.getByRole('dialog').count(),0)
        }finally{await context.close()}
      })

      await t.test(name+' desktop layout stays readable',async()=>{
        const context=await browser.newContext({viewport:{width:1280,height:900}})
        try {
          const page=await context.newPage()
          await page.goto(origin+'/__release_fixture')
          const notice=page.getByRole('dialog',{name:"What's new in Family Calendar"})
          await notice.waitFor()
          const rect=await notice.boundingBox()
          assert.ok(rect && rect.width<=440 && rect.y>=0 && rect.y+rect.height<=900)
          await notice.getByRole('button',{name:'Got it'}).click()
        }finally{await context.close()}
      })
    }
  }finally{
    await Promise.all(browsers.map(b=>b.close()))
    await server.close()
  }
})
