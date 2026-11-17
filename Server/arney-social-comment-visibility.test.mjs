import test from 'node:test'
import assert from 'node:assert/strict'
import { selectPublicCreatorRecipeComment } from './arney-social-video-import.mjs'

test('selects a verified creator-pinned recipe from the first ten comments', () => {
  const metadata = { uploader_id: 'chef123', comments: [
    {author_id:'other',text:'Add 1 tsp of sugar',is_pinned:true},
    {author_id:'chef123',text:'Ingredients: 2 cups pasta; cook for 10 minutes.',is_pinned:true},
  ] }
  const result = selectPublicCreatorRecipeComment(metadata)
  assert.equal(result.source, 'creator-pinned')
  assert.equal(result.pinnedConfirmed, true)
  assert.equal(result.commentsExamined, 2)
})

test('finds a creator recipe after 40 newer comments already in yt-dlp metadata', () => {
  const metadata = { extractor_key:'Instagram', channel:'fitfoodiestasia', uploader_id:'fitfoodiestasia', comments: [
    ...Array.from({length:40}, (_, i) => ({
      author_id:'viewer'+i, author:'viewer'+i, text:'Great video '+i,
      timestamp:1790000000+i,
    })),
    {author_id:'192837465',author:'fitfoodiestasia',text:'Ingredients: 2 eggs and 200g pasta. Instructions: Mix and cook for 10 minutes.', timestamp:1760000000},
  ] }
  const result = selectPublicCreatorRecipeComment(metadata)
  assert.equal(result.creatorVerified,true)
  assert.equal(result.text.includes('200g pasta'),true)
  assert.equal(result.source,'creator-comment')
  assert.equal(result.pinnedConfirmed,false)
  assert.equal(result.commentsExamined,41)
  assert.equal(result.reason,'creator-comment-found')
})

test('reports all returned comments examined when the creator is absent', () => {
  const metadata={uploader_id:'chef123',comments:Array.from({length:45},(_,i)=>({author_id:'viewer'+i,text:'Looks good'}))}
  const result=selectPublicCreatorRecipeComment(metadata)
  assert.equal(result.text,'')
  assert.equal(result.commentsExamined,45)
  assert.equal(result.reason,'no-verified-creator-recipe-in-returned-comments')
})

test('distinguishes missing comment metadata from no qualifying first-ten comment', () => {
  const result = selectPublicCreatorRecipeComment({uploader_id:'chef123'})
  assert.equal(result.reason, 'comments-not-exposed')
  assert.equal(result.commentsExamined, 0)
})

test('does not treat a matching display name as verified creator identity', () => {
  const result = selectPublicCreatorRecipeComment({uploader_id:'chef123',comments:[
    {author:'chef123',text:'Recipe: add 1 tsp salt',is_pinned:true}
  ]})
  assert.equal(result.creatorVerified,false)
})
