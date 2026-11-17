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

test('never selects a creator comment beyond the initial ten', () => {
  const metadata = { uploader_id: 'chef123', comments: [
    ...Array.from({length:10}, (_, i) => ({author_id:'other',text:'Great video '+i})),
    {author_id:'chef123',text:'Recipe: add 2 cups pasta',is_pinned:true},
  ] }
  const result = selectPublicCreatorRecipeComment(metadata)
  assert.equal(result.text, '')
  assert.equal(result.commentsExamined, 10)
  assert.equal(result.reason, 'no-verified-creator-recipe-in-first-10')
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
