import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  normalizeSocialRecipeUrl,
  parseSocialRecipeCaption,
  previewSocialRecipe,
} from '../Server/arney-social-recipe-import.mjs'

test('accepts direct public Instagram Reel and post links, strips tracking', () => {
  const reel = normalizeSocialRecipeUrl('https://www.instagram.com/reel/ABCDE_fghi1/?igsh=abc123')
  assert.equal(reel.platform, 'Instagram')
  assert.equal(reel.url, 'https://www.instagram.com/reel/ABCDE_fghi1/')
  assert.equal(reel.endpoint, 'instagram_oembed')
  assert.equal(normalizeSocialRecipeUrl('https://instagram.com/p/12345_abc/').platform, 'Instagram')
})

test('supports Facebook share/reel URLs including a real share/r shape', () => {
  const share = normalizeSocialRecipeUrl('https://www.facebook.com/share/r/1A8Sz2b3cf/?mibextid=wwXIfr')
  assert.equal(share.platform, 'Facebook')
  assert.equal(share.url, 'https://www.facebook.com/share/r/1A8Sz2b3cf/')
  assert.equal(share.endpoint, 'oembed_video')
  assert.equal(normalizeSocialRecipeUrl('https://m.facebook.com/reel/1234567890').endpoint, 'oembed_video')
  const watch = normalizeSocialRecipeUrl('https://facebook.com/watch/?v=1234567890&fbclid=tracking')
  assert.equal(watch.url, 'https://www.facebook.com/watch/?v=1234567890')
  const post = normalizeSocialRecipeUrl('https://facebook.com/SomeCreator/posts/1234567')
  assert.equal(post.endpoint, 'oembed_post')
})

test('refuses unrelated URLs, credentials, subdomain spoofing, redirect tricks, local services', () => {
  for (const url of [
    'http://www.instagram.com/reel/ABCDE_fghi1/',
    'https://instagram.com.evil.example/reel/ABCDE_fghi1/',
    'https://facebook.com@127.0.0.1/private',
    'https://www.facebook.com:1234/share/r/1A8Sz2b3cf/',
    'https://www.instagram.com/yourprofile/',
    'https://www.instagram.com/reel/../private',
    'https://fb.watch/xyz123',
    'https://www.facebook.com/home.php?redirect=https://127.0.0.1',
    'https://www.facebook.com/share/r/abc',
    'file:///etc/passwd',
    'https://localhost/reel/123456789',
  ]) assert.throws(() => normalizeSocialRecipeUrl(url), TypeError, url)
})

test('only clearly labeled caption sections become recipe fields, original quantities retained', () => {
  const caption = [
    'Creamy Garlic Chicken',
    '',
    'Ingredients:',
    '• 2 chicken breasts',
    '- 1 cup heavy cream',
    '',
    'Directions:',
    '1. Brown chicken in a pan.',
    '2. Add cream and simmer.',
    '',
    '#dinner #recipe',
  ].join('\n')
  const draft = parseSocialRecipeCaption(caption)
  assert.equal(draft.name, 'Creamy Garlic Chicken')
  assert.equal(draft.titleIsExplicit, false)
  assert.equal(draft.ingredients, '2 chicken breasts\n1 cup heavy cream')
  assert.equal(draft.instructions, 'Brown chicken in a pan.\nAdd cream and simmer.')
  assert.equal(draft.suppliedCaption, true)
})

test('Jalal-style Instagram captions with emoji headings preserve quantities, servings and macros', () => {
  const caption = [
    'Creamy Peri Peri Chicken Pasta🍗🧀🍝',
    'Macros Per Serving (8 Total)',
    '592 Calories | 55g Protein | 54g Carbs | 19g Fat',
    'Ingredients (Makes 8 Servings)',
    'Peri Peri Chicken',
    '- 1500g Raw Boneless Skinless Chicken Thighs, fat trimmed',
    '- 100g Nando’s Peri Peri Medium Sauce',
    'Creamy Peri Peri Pasta',
    '- 480g Uncooked Protein Rigatoni Pasta',
    '👨‍🍳 Instructions',
    '1. Trim excess fat from the chicken thighs.',
    '2. Bake at 200C / 400F for 22-25 minutes.',
  ].join('\n')
  const result = parseSocialRecipeCaption(caption)
  assert.match(result.name, /Creamy Peri Peri Chicken Pasta/)
  assert.equal(result.servings, '8')
  assert.match(result.notes, /592 Calories \| 55g Protein \| 54g Carbs \| 19g Fat/)
  assert.match(result.ingredients, /1500g Raw Boneless Skinless Chicken Thighs/)
  assert.match(result.ingredients, /480g Uncooked Protein Rigatoni Pasta/)
  assert.doesNotMatch(result.ingredients, /Makes 8 Servings/)
  assert.doesNotMatch(result.ingredients, /Instructions/)
  assert.equal(result.instructions, 'Trim excess fat from the chicken thighs.\nBake at 200C / 400F for 22-25 minutes.')
})

test('unlabeled Bang Bang chicken Reel captions recover only stated bullets and numbered cooking steps', () => {
  const caption = [
    '😋 HIGH PROTEIN BANG BANG CHICKEN POWER BOWLS',
    '4 portions of easy meal prep',
    '• 500g chicken breast',
    '• 2 tbsp sweet chili sauce',
    '• 150g white rice',
    '1. Preheat oven to 400F.',
    '2. Cook the chicken for 24 minutes.',
    'Protein-packed meal prep!',
  ].join('\n')
  const result = parseSocialRecipeCaption(caption)
  assert.match(result.name, /BANG BANG CHICKEN POWER BOWLS/)
  assert.equal(result.ingredients, '500g chicken breast\n2 tbsp sweet chili sauce\n150g white rice')
  assert.equal(result.instructions, 'Preheat oven to 400F.\nCook the chicken for 24 minutes.')
})

test('unlabeled captions without quantities or numbered cooking steps do not make up a recipe', () => {
  const result = parseSocialRecipeCaption('Easy recipe!\nMore details in comments\n#dinner')
  assert.equal(result.ingredients, '')
  assert.equal(result.instructions, '')
})

test('does not invent instructions or ingredients from vague social posts', () => {
  const result = parseSocialRecipeCaption('Save this delicious dinner idea for later!\nFollow me for more!')
  assert.equal(result.ingredients, '')
  assert.equal(result.instructions, '')
  const empty = parseSocialRecipeCaption('')
  assert.equal(empty.name, '')
  assert.equal(empty.ingredients, '')
  assert.equal(empty.instructions, '')
  assert.throws(() => parseSocialRecipeCaption('x'.repeat(10001)), TypeError)
})

test('official fixed Meta host only, one GET, no credentials or private caption in outbound URL', async () => {
  let calls = []
  const fetchStub = async (url, options) => {
    calls.push({ url, options })
    return { ok: true, body: { cancel: async () => {} }, json() { throw new Error('Should never parse embed HTML as recipe data') } }
  }
  const caption = 'Recipe: Chicken Soup\nIngredients:\n- 2 cups stock\nInstructions:\n1. Boil the stock'
  const result = await previewSocialRecipe({
    url: 'https://www.instagram.com/reel/ABCDE_fghi1/?utm_source=social', caption,
  }, fetchStub)
  assert.equal(result.platform, 'Instagram')
  assert.equal(result.sourceUrl, 'https://www.instagram.com/reel/ABCDE_fghi1/')
  assert.equal(result.publicEmbedAvailable, true)
  assert.equal(result.name, 'Chicken Soup')
  assert.equal(result.titleIsExplicit, true)
  assert.equal(result.ingredients, '2 cups stock')
  assert.equal(result.instructions, 'Boil the stock')
  assert.deepEqual(result.missing, [])
  assert.equal(calls.length, 1)
  const outbound = new URL(calls[0].url)
  assert.equal(outbound.origin, 'https://graph.facebook.com')
  assert.equal(outbound.pathname, '/v27.0/instagram_oembed')
  assert.equal(outbound.searchParams.get('url'), result.sourceUrl)
  assert.equal(outbound.searchParams.get('access_token'), null)
  assert.ok(!outbound.href.includes('Chicken Soup') && !outbound.href.includes('stock'))
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.redirect, 'error')
})

test('Meta inaccessible/private response never blocks draft from user-pasted caption', async () => {
  const result = await previewSocialRecipe({
    url: 'https://www.facebook.com/share/r/1A8Sz2b3cf/',
    caption: 'Soup\nIngredients:\n- 1 cup beans',
  }, async () => { throw new Error('network down') })
  assert.equal(result.publicEmbedAvailable, false)
  assert.equal(result.name, 'Soup')
  assert.equal(result.ingredients, '1 cup beans')
  assert.equal(result.instructions, '')
  assert.deepEqual(result.missing, ['instructions'])
  assert.ok(result.notice.includes('missing instructions'))
})

test('link-only mode cannot imply any recipe was extracted or a video transcribed', async () => {
  const draft = await previewSocialRecipe({
    url: 'https://www.instagram.com/reel/ABCDE_fghi1/',
  }, async () => ({ ok: true }))
  assert.equal(draft.publicEmbedAvailable, true)
  assert.equal(draft.suppliedCaption, false)
  assert.equal(draft.name, '')
  assert.equal(draft.ingredients, '')
  assert.equal(draft.instructions, '')
  assert.ok(draft.notice.includes('Videos are not downloaded or transcribed'))
})

test('malicious input fails before any outbound network request', async () => {
  let called = false
  await assert.rejects(() => previewSocialRecipe({
    url: 'https://internal.example.test/secret',
    caption: 'Ingredients:\n- Password: 123',
  }, async () => { called = true }), TypeError)
  assert.equal(called, false)
})

test('authenticated backend route is preview-only; existing Save Recipe remains the sole write', () => {
  const server = readFileSync(new URL('../Server/index.mjs', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  const routeStart = server.indexOf("app.post('/api/arney/social-recipe-preview'")
  const routeEnd = server.indexOf('// Source photo bytes are requested ONLY', routeStart)
  const route = server.slice(routeStart, routeEnd)
  assert.ok(routeStart > server.indexOf("installFamilyAuth("))
  assert.ok(route.includes("previewSocialRecipe("))
  assert.ok(route.includes("Cache-Control', 'private, no-store'"))
  for (const forbidden of ['database.prepare(', '.run(', 'upload.single(', "app.get('/uploads"]) {
    assert.ok(!route.includes(forbidden), forbidden)
  }
  assert.ok(client.includes('Import from Instagram or Facebook'))
  assert.ok(client.includes('/api/arney/social-recipe-video-preview'))
  assert.ok(client.includes('setRecipeSourceUrl(data.sourceUrl)'))
  assert.ok(client.includes('onSubmit={saveRecipe}'))
  assert.ok(client.includes('Save Recipe'))
  assert.ok(client.includes('editingRecipeId === null'))
})
