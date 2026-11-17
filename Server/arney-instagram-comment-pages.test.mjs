import test from 'node:test'
import assert from 'node:assert/strict'
import { instagramShortcodeMediaId, readInstagramCreatorRecipePages } from './arney-instagram-comment-pages.mjs'
import { selectPublicCreatorRecipeComment } from './arney-social-video-import.mjs'

const url = 'https://www.instagram.com/reel/DUY0rQbkVFe/'
const meta = { extractor_key:'Instagram', channel:'fitfoodiestasia', uploader_id:'1234567' }
const json = body => new Response(JSON.stringify(body), {
  status:200, headers:{'content-type':'application/json'},
})
const options = { selectComment:selectPublicCreatorRecipeComment }
const commenter = (author, text, timestamp, pk) => ({
  pk:String(pk), text, created_at:timestamp,
  user:{username:author, pk:author==='fitfoodiestasia'?'1234567':String(pk)},
})

test('converts only canonical Instagram shortcode paths to safe numeric media identifiers', () => {
  assert.match(instagramShortcodeMediaId(url), /^[0-9]{10,25}$/)
  assert.equal(instagramShortcodeMediaId('https://other.example/reel/DUY0rQbkVFe/'), '')
  assert.equal(instagramShortcodeMediaId('http://www.instagram.com/reel/DUY0rQbkVFe/'), '')
  assert.equal(instagramShortcodeMediaId('https://www.instagram.com/accounts/login/'), '')
})

test('follows an explicit public Instagram cursor and stops when an older creator recipe is found', async () => {
  const visits=[]
  const fetchImpl=async (uri, init) => {
    const target=new URL(uri)
    visits.push({target,init})
    assert.equal(target.host,'www.instagram.com')
    assert.match(target.pathname,/^\/api\/v1\/media\/[0-9]+\/comments\/$/)
    assert.equal(target.searchParams.get('sort_order'),'recent')
    assert.equal(init.credentials,'omit')
    assert.equal(init.redirect,'error')
    assert.equal(init.headers.Cookie,undefined)
    if(visits.length===1) {
      assert.equal(target.searchParams.get('min_id'),null)
      return json({comments:[commenter('viewer','Looks great!',1795000000,'10')],
        has_more_comments:true,next_min_id:'{"cached_comments_cursor":"x+y"}'})
    }
    if(visits.length===2) {
      assert.equal(target.searchParams.get('min_id'),'{"cached_comments_cursor":"x+y"}')
      return json({comments:[commenter('fitfoodiestasia','Ingredients: 2 cups rice. Instructions: Cook rice.',1760000000,'11')],
        has_more_comments:true,next_min_id:'next_page'})
    }
    throw Error('Unexpected third request after recipe matched')
  }
  const result=await readInstagramCreatorRecipePages(url,meta,{...options,fetchImpl})
  assert.equal(result.creatorVerified,true)
  assert.equal(result.pinnedConfirmed,false)
  assert.match(result.text,/Cook rice/)
  assert.equal(result.commentsExamined,2)
  assert.equal(result.pagesChecked,2)
  assert.equal(visits.length,2)
})

test('returns after first creator recipe and never fetches more comments', async () => {
  let attempts=0
  const result=await readInstagramCreatorRecipePages(url,meta,{...options,
    fetchImpl:async()=>{
      attempts++
      return json({comments:[commenter('fitfoodiestasia','Recipe: 200g pasta. Bake for 12 minutes.',1760000000,'12')],
        has_more_comments:true,next_min_id:'another'})
    }})
  assert.equal(result.creatorVerified,true)
  assert.equal(attempts,1)
  assert.equal(result.pagesChecked,1)
})

test('fails closed without a public continuation cursor instead of guessing or scrolling', async () => {
  let attempts=0
  const result=await readInstagramCreatorRecipePages(url,meta,{...options,
    fetchImpl:async()=>{attempts++;return json({
      comments:[commenter('viewer','Delicious',1790000000,'13')],
      has_more_comments:true,
    })},
  })
  assert.equal(result.reason,'comment-pagination-unavailable')
  assert.equal(result.commentsExamined,1)
  assert.equal(result.pagesChecked,1)
  assert.equal(attempts,1)
})

test('sets a strict five-page ceiling and never requests a sixth page', async () => {
  const calls=[]
  const result=await readInstagramCreatorRecipePages(url,meta,{...options,
    fetchImpl:async(uri)=>{
      calls.push(uri)
      return json({comments:[commenter('viewer','Delicious',1790000000+calls.length,calls.length)],
        has_more_comments:true,next_min_id:'next'+calls.length})
    },
  })
  assert.equal(result.reason,'comment-page-limit')
  assert.equal(result.pagesChecked,5)
  assert.equal(result.commentsExamined,5)
  assert.equal(calls.length,5)
})

test('does not retry Instagram rate limits, login rejection, or invalid responses', async () => {
  for(const [status,reason] of [[429,'comment-rate-limited'],[403,'comment-access-denied']]){
    let tries=0
    const result=await readInstagramCreatorRecipePages(url,meta,{...options,
      fetchImpl:async()=>{tries++;return new Response('',{status})}})
    assert.equal(result.reason,reason)
    assert.equal(tries,1)
  }
  const bad=await readInstagramCreatorRecipePages(url,meta,{...options,
    fetchImpl:async()=>new Response('not-json',{status:200})})
  assert.equal(bad.reason,'comment-invalid-page')
})

test('does not request Instagram when creator metadata or source URL is untrusted', async () => {
  let calls=0
  const fetchImpl=async()=>{calls++;throw Error('Must not fetch')}
  const badMeta=await readInstagramCreatorRecipePages(url,{channel:'anonymous'},{...options,fetchImpl})
  const badUrl=await readInstagramCreatorRecipePages('https://evil.test/reel/DUY0rQbkVFe/',meta,{...options,fetchImpl})
  assert.equal(badMeta.reason,'creator-metadata-unavailable')
  assert.equal(badUrl.reason,'invalid-instagram-url')
  assert.equal(calls,0)
})
