// Real App, synthetic profiles and mocked APIs, disposable Vite source copy.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {createServer} from 'vite'
import react from '@vitejs/plugin-react'
import sharp from 'sharp'

const {chromium,webkit} = await import(process.env.FAMILY_CALENDAR_PLAYWRIGHT_MODULE || 'playwright')
const source = fileURLToPath(new URL('../',import.meta.url))
const baseline = spawnSync('git',['show','249d55527851290cbd9111ca81dc1650cd404c96:src/App.tsx'],{cwd:source,encoding:'utf8'})
assert.equal(baseline.status,0,'Fetch full Git history to inspect the deployed baseline')
const png=await sharp({create:{width:8,height:8,channels:3,background:'#4488bb'}}).png().toBuffer()
const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><div id="root"></div><script type="module">
import React from 'react';import {createRoot} from 'react-dom/client';import App from '/src/App.tsx';
createRoot(document.getElementById('root')).render(React.createElement(App));
</script></body></html>`

test('mobile People Edit opens the actual photo editor', {timeout:180000}, async t=>{
  const browsers={chromium:await chromium.launch(),webkit:await webkit.launch()}
  try {
    for(const mode of ['baseline','fixed']) {
      const root=fs.mkdtempSync(path.join(os.tmpdir(),'calendar-mobile-editor-'))
      fs.cpSync(path.join(source,'src'),path.join(root,'src'),{recursive:true})
      fs.mkdirSync(path.join(root,'Server'))
      for(const name of fs.readdirSync(path.join(source,'Server'))) {
        if(name.endsWith('.mjs')) fs.copyFileSync(path.join(source,'Server',name),path.join(root,'Server',name))
      }
      fs.symlinkSync(path.join(source,'node_modules'),path.join(root,'node_modules'),'junction')
      fs.writeFileSync(path.join(root,'package.json'),'{}')
      if(mode==='baseline') fs.writeFileSync(path.join(root,'src/App.tsx'),baseline.stdout)
      const server=await createServer({root,configFile:false,publicDir:false,cacheDir:path.join(root,'.vite-cache'),
        plugins:[react(),{name:'mobile-editor-fixture',configureServer(vite){
          vite.middlewares.use('/__mobile_editor',async(_req,res,next)=>{
            try {res.setHeader('Content-Type','text/html');res.end(await vite.transformIndexHtml('/__mobile_editor',html))}
            catch(error){next(error)}
          })
        }}],server:{host:'127.0.0.1',port:0,fs:{allow:[root,source]}}})
      try {
        await server.listen()
        const origin=`http://127.0.0.1:${server.httpServer.address().port}`
        const cases=[{engine:'chromium',touch:true},{engine:'webkit',touch:true},...(mode==='fixed'?[{engine:'chromium',touch:false}]:[])]
        for(const {engine,touch} of cases) {
          await t.test(`${engine} ${mode} ${touch?'touch':'desktop'}: tap Edit with seven profiles`,async()=>{
            const viewport=touch?(engine==='webkit'?{width:430,height:932}:{width:393,height:852}):{width:1280,height:900}
            const context=await browsers[engine].newContext({viewport,isMobile:touch,hasTouch:touch,reducedMotion:'reduce'})
            try {
              await context.addInitScript(()=>localStorage.setItem('family-calendar.profile.v1.legacy.familyadmin','person:1'))
              const page=await context.newPage()
              page.setDefaultTimeout(15000)
              page.on('pageerror',error=>console.error('App fixture error:',error.message))
              let people=Array.from({length:7},(_,i)=>({id:i+1,name:`Person ${i+1}`,color:'#4488bb',image:i===0?'original.png':null}))
              const writes=[]
              let rejectSave=false
              await page.route('**/*',async route=>{
                const req=route.request(),url=new URL(req.url()),p=url.pathname
                if(url.origin!==origin) return route.fulfill({status:503,body:'External services disabled in fixture'})
                if(p.startsWith('/uploads/')) return route.fulfill({contentType:'image/png',body:png})
                if(p==='/test-notification-pilot/refresh') return route.fulfill({json:{ok:true}})
                if(!p.startsWith('/api/')) return route.continue()
                const send=json=>route.fulfill({json})
                if(p==='/api/auth/status') return send({enabled:true,authenticated:true,username:'familyadmin'})
                if(p==='/api/auth/device-profile') return send({ok:true})
                if(p==='/api/people'&&req.method()==='GET') return send(people)
                if(p==='/api/people/1'&&req.method()==='PUT') {
                  if(rejectSave) return route.fulfill({status:400,json:{error:'Save rejected for regression test'}})
                  const body=req.postDataBuffer().toString('latin1')
                  const removing=/name="removeImage"\r\n\r\ntrue/.test(body)
                  const uploading=/name="image"; filename=/.test(body)
                  writes.push({removing,uploading})
                  people=people.map(person=>person.id===1?{...person,image:removing?null:uploading?'replacement.png':person.image}:person)
                  return send(people[0])
                }
                if(p==='/api/test-notification-pilot') return send({personId:1,notifications:[]})
                if(p.includes('push/config')) return send({enabled:false})
                return send([])
              })
              await page.goto(origin+'/__mobile_editor')
              if(touch) {
                await page.getByRole('button',{name:'Settings',exact:true}).first()[touch?'tap':'click']()
                await page.getByRole('button',{name:/Manage People/})[touch?'tap':'click']()
              } else {
                await page.locator('.sidebar-nav-button').filter({hasText:'People'}).click()
              }
              const card=page.locator('.person-card').filter({has:page.getByRole('heading',{name:'Person 1',exact:true})})
              if (mode === 'fixed') {
                assert.equal(await page.getByRole('heading', {name:'Family Calendar', exact:true}).count(), 0)
                assert.equal((await page.locator('.person-color-row').allTextContents()).join('').trim(), '')
                assert.equal(await card.locator('.person-color-dot').count(), 1)
                assert.ok((await card.getByRole('button', {name:'Edit',exact:true}).boundingBox()).height >= 44)
                const strip = page.locator('.app-status-bar-strip')
                assert.equal(await strip.count(), 1)
                assert.equal(await strip.evaluate(el => el.parentElement === document.body), true)
                const style = await strip.evaluate(el => {
                  const css = getComputedStyle(el), rect = el.getBoundingClientRect()
                  return {display:css.display, position:css.position, color:css.backgroundColor,
                    events:css.pointerEvents, top:rect.top, width:rect.width, height:rect.height}
                })
                if (touch) {
                  assert.equal(style.display, 'block')
                  assert.equal(style.position, 'fixed')
                  assert.equal(style.color, 'rgb(239, 231, 218)')
                  assert.equal(style.events, 'none')
                  assert.equal(style.top, 0)
                  assert.equal(style.width, viewport.width)
                  assert.equal(style.height, 6)
                  const geometry = () => page.evaluate(() => {
                    const p = document.querySelector('.people-page').getBoundingClientRect()
                    const c = document.querySelector('.person-card').getBoundingClientRect()
                    return {pageTop:p.top, cardTop:c.top, height:document.documentElement.scrollHeight, y:scrollY}
                  })
                  const before = await geometry()
                  await strip.evaluate(el => el.style.display = 'none')
                  assert.deepEqual(await geometry(), before, 'Strip must not move or resize the page')
                  await strip.evaluate(el => el.style.removeProperty('display'))
                  assert.deepEqual(await geometry(), before)
                  await page.evaluate(() => window.scrollTo(0, 200))
                  assert.equal((await strip.boundingBox()).y, 0, 'Strip stays fixed while document scrolls')
                  await page.evaluate(() => window.scrollTo(0, 0))
                } else assert.equal(style.display, 'none')
              }
              await card.getByRole('button',{name:'Edit',exact:true})[touch?'tap':'click']()
              const editor=page.locator('.people-editor-card')
              if(mode==='baseline') {
                const state=await editor.evaluate(el=>({top:el.getBoundingClientRect().top,title:el.querySelector('h2').textContent.trim()}))
                assert.ok(state.top>=viewport.height || state.top<0 || state.title!=='Edit Person','Baseline unexpectedly opened a visible editor')
                console.log(`BASELINE ${engine}: editor title=${state.title}, top=${state.top}`)
                return
              }
              await page.waitForFunction(()=>{
                const heading=document.querySelector('.people-editor-card h2')
                const rect=heading?.getBoundingClientRect()
                return heading?.textContent.trim()==='Edit Person'&&rect.top>=0&&rect.bottom<window.innerHeight
              },null,{timeout:10000})
              assert.equal(await card.getAttribute('draggable'),touch?'false':'true')
              assert.equal(await editor.evaluate(el=>document.activeElement===el),true)
              await editor.getByRole('button',{name:'Remove photo',exact:true})[touch?'tap':'click']()
              assert.equal(writes.length,0)
              await editor.getByRole('button',{name:'Undo removal',exact:true})[touch?'tap':'click']()
              assert.equal(await editor.locator('.person-image-preview').count(),1)
              assert.equal(await editor.getAttribute('role'),'dialog')
              assert.equal(await editor.getAttribute('aria-modal'),'true')
              assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden')
              await editor.locator('.person-name-display')[touch?'tap':'click']()
              await page.locator('.person-keyboard-overlay').waitFor()
              await page.mouse.click(2,2)
              await page.locator('.person-keyboard-overlay').waitFor({state:'hidden'})
              await editor.getByRole('button',{name:'Cancel',exact:true})[touch?'tap':'click']()
              assert.equal(writes.length,0)
              await page.locator('.person-editor-overlay').waitFor({state:'hidden'})
              assert.equal(await page.evaluate(()=>document.body.style.overflow),'')
              // Escape and backdrop close without saving.
              await card.getByRole('button',{name:'Edit',exact:true})[touch?'tap':'click']()
              await page.keyboard.press('Escape')
              await page.locator('.person-editor-overlay').waitFor({state:'hidden'})
              await card.getByRole('button',{name:'Edit',exact:true})[touch?'tap':'click']()
              await page.mouse.click(2,2)
              await page.locator('.person-editor-overlay').waitFor({state:'hidden'})
              assert.equal(writes.length,0)
              // Selecting the same person again must also reopen the editor.
              await card.getByRole('button',{name:'Edit',exact:true})[touch?'tap':'click']()
              await editor.getByRole('button',{name:'Remove photo',exact:true})[touch?'tap':'click']()
              rejectSave=true
              await editor.getByRole('button',{name:'Save Person',exact:true})[touch?'tap':'click']()
              await page.getByText('Save rejected for regression test',{exact:true}).waitFor()
              assert.equal(await editor.getAttribute('role'),'dialog')
              assert.equal(writes.length,0)
              rejectSave=false
              await editor.getByRole('button',{name:'Save Person',exact:true})[touch?'tap':'click']()
              await page.waitForFunction(()=>document.querySelector('.people-editor-card h2')?.textContent.trim()==='Add Person')
              assert.deepEqual(writes,[{removing:true,uploading:false}])
              assert.equal(await card.locator('img').count(),0)
              await card.getByRole('button',{name:'Edit',exact:true})[touch?'tap':'click']()
              await editor.getByLabel('Profile photo',{exact:true}).setInputFiles({name:'replacement.png',mimeType:'image/png',buffer:png})
              await editor.getByRole('button',{name:'Save Person',exact:true})[touch?'tap':'click']()
              await page.waitForFunction(()=>document.querySelector('.people-editor-card h2')?.textContent.trim()==='Add Person')
              assert.deepEqual(writes[1],{removing:false,uploading:true})
              await card.locator('img[src="/uploads/replacement.png"]').waitFor()

              // Add is available above the people list and opens the same modal without scrolling.
              const addButton=page.getByRole('button',{name:'Add Person',exact:true})
              assert.equal(await addButton.count(),1)
              const addBox=await addButton.boundingBox()
              const firstCardBox=await card.boundingBox()
              assert.ok(addBox&&firstCardBox&&addBox.y<firstCardBox.y,'Add Person should appear above the people cards')
              const scrollBefore=await page.evaluate(()=>window.scrollY)
              await addButton[touch?'tap':'click']()
              await page.waitForFunction(()=>{
                const dialog=document.querySelector('.people-editor-card')
                const rect=dialog?.getBoundingClientRect()
                return dialog?.querySelector('h2')?.textContent.trim()==='Add Person'&&
                  dialog.getAttribute('role')==='dialog'&&rect.top>=0&&rect.bottom<=window.innerHeight
              })
              assert.equal(await editor.getAttribute('aria-modal'),'true')
              assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden')
              assert.equal(await page.evaluate(()=>window.scrollY),scrollBefore,'Opening Add Person must not scroll the page')
              await editor.getByRole('button',{name:'Cancel',exact:true})[touch?'tap':'click']()
              await page.locator('.person-editor-overlay').waitFor({state:'hidden'})
              assert.equal(await page.evaluate(()=>document.body.style.overflow),'')
            } finally {await context.close()}
          })
        }
      } finally {await server.close();fs.rmSync(root,{recursive:true,force:true})}
    }
  } finally {await Promise.all(Object.values(browsers).map(browser=>browser.close()))}
})
