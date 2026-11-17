import test from 'node:test'
import { consolidateRecipeIngredientAmounts } from '../Server/arney-recipe-ingredient-aggregation.mjs'
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

test('iPhone regression: full creator-pinned gochujang chicken comment becomes 14 ingredients and three directions', () => {
  const comment = [
    '📌 RECIPE:',
    'Chili Chicken Thighs:',
    '•12 oz boneless & skinless chicken thighs',
    '•1 tbsp: garlic powder, onion powder',
    '•1/2 tbsp (7 mL) sugar-free Thai sweet chili sauce',
    '•1 tsp paprika',
    '•1/2 tsp salt',
    '•1/4 tsp ground black pepper',
    'Sticky Gochujang Glaze:',
    '•1 1/2 tbsp (22 mL) Gochujang paste',
    '•1 tbsp (15 mL): raw organic honey, low sodium soy sauce',
    '•1 tsp rice vinegar',
    '•1/2 tsp sesame oil (optional)',
    'To Serve:',
    '•cooked jasmine rice, divided',
    '•Quick Pickled Veggies (recipe already on my page)',
    '•sesame seeds',
    '•green onion, finely chopped',
    '•1. Line an air fryer rack with parchment. Season chicken and air fry for ~15 minutes at 400°F, flipping halfway.',
    '•2. While that’s going, quickly whisk Sticky Gochujang glaze. Once chicken is cooked, remove from heat, coat generously in glaze, and return to air fryer for ~2 minutes to caramelize.',
    '•3. Chop chicken, top with (optional) sesame seeds and green onion. Serve alongside (optional) rice and pickled veggies. Enjoy!',
  ].join('\n')
  const result = parseSocialRecipeCaption(comment)
  assert.equal(result.name, '')
  assert.deepEqual(result.ingredients.split('\n'), [
    '12 oz boneless & skinless chicken thighs',
    '1 tbsp: garlic powder, onion powder',
    '1/2 tbsp (7 mL) sugar-free Thai sweet chili sauce',
    '1 tsp paprika',
    '1/2 tsp salt',
    '1/4 tsp ground black pepper',
    '1 1/2 tbsp (22 mL) Gochujang paste',
    '1 tbsp (15 mL): raw organic honey, low sodium soy sauce',
    '1 tsp rice vinegar',
    '1/2 tsp sesame oil (optional)',
    'cooked jasmine rice, divided',
    'Quick Pickled Veggies (recipe already on my page)',
    'sesame seeds',
    'green onion, finely chopped',
  ])
  assert.equal(result.ingredientParts.length, 14)
  assert.deepEqual([...new Set(result.ingredientParts.map(x => x.section))], [
    'chili chicken thighs', 'sticky gochujang glaze', 'to serve',
  ])
  assert.equal(result.instructions.split('\n').length, 3)
  assert.match(result.instructions, /^Line an air fryer rack with parchment/)
  assert.match(result.instructions, /\nWhile that’s going,/)
  assert.match(result.instructions, /\nChop chicken,/)
  assert.doesNotMatch(result.ingredients, /Line an air fryer|While that’s going|Chop chicken/)
})

test('iPhone Sesame Chicken Rice Bowls caption: 12 ingredients, ten bowls, four macros and reheating notes', () => {
  const caption = [
    'Sesame Chicken Rice Bowls',
    '(Makes 10 Bowls)',
    '',
    'Macros Per Bowl:',
    '- 400 Calories',
    '- 45g Protein',
    '- 39g Carbs',
    '- 5g Fat',
    '',
    'Ingredients:',
    '- 60oz Ground Chicken Breast (1700g)',
    '- 0.75 Cup Soy Sauce (180g)',
    '- 0.5 Cup No Sugar Added Ketchup (120g)',
    '- 0.25 Cup Honey (80g)',
    '- 0.5 Tbsp Sesame Oil (8g)',
    '- 2 Tbsps Rice Vinegar (30g)',
    '- 2 Tbsps Minced Garlic (20g)',
    '- 1 Tbsp Red Pepper Flakes (Optional) (8g)',
    '- Fresh Green Onions (60g)',
    '- Sesame Seeds (20g)',
    '- 2 Cups Dry White Rice (360g)',
    '- 3 Cups Chicken Bone Broth (720g)',
    '',
    'Additional Notes: To reheat the meal preps from frozen, follow these steps. Add a few tablespoons of water to the container, cover with a wet paper towel, and microwave for around 5-6 minutes.',
  ].join('\n')
  const result = parseSocialRecipeCaption(caption)
  assert.equal(result.name, 'Sesame Chicken Rice Bowls')
  assert.equal(result.servings, '10')
  assert.equal(result.ingredients.split('\n').length, 12)
  assert.match(result.ingredients, /60oz Ground Chicken Breast \(1700g\)/)
  assert.match(result.ingredients, /Fresh Green Onions \(60g\)/)
  assert.match(result.ingredients, /3 Cups Chicken Bone Broth \(720g\)/)
  assert.doesNotMatch(result.ingredients, /Calories|Protein|Carbs|5g Fat|Additional Notes|microwave/i)
  assert.equal(result.instructions, '')
  assert.match(result.notes, /Creator-reported macros per bowl: 400 Calories \| 45g Protein \| 39g Carbs \| 5g Fat/)
  assert.match(result.notes, /Creator notes: To reheat.*microwave for around 5-6 minutes/i)
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


test('iPhone regression: social introduction is not title; all unbulleted measured ingredients stay intact', () => {
  const caption = [
    'This was 10 out of 10! We made a huge batch so if you want leftovers, try this!',
    '',
    'Caramelized Onion and Garlic Chicken Pasta',
    '',
    '3 large yellow onions, thinly sliced',
    '2 heads garlic, halved crosswise',
    '4 chicken breasts',
    '1/3 cup olive oil, divided',
    'Salt and freshly ground black pepper',
    '2 tsp dried Italian seasoning',
    '2 tsp paprika',
    '1/2 tsp red pepper flakes, optional',
    '2 lb pasta',
    '1 cup heavy cream',
    '1 cup freshly grated Parmesan, plus more for serving',
    'Fresh parsley, chopped, for serving',
    '1-2 cup reserved pasta water',
    '',
    'Instructions',
    'Roast the onions and garlic: Heat oven to 400°F. In a large baking dish, toss the sliced onions with 2-3 tablespoons olive oil, salt and pepper.',
    'Add the chicken: Season the chicken with the remaining olive oil, salt, pepper, Italian seasoning and red pepper flakes.',
    'Cook the pasta: While the chicken bakes, cook the pasta in salted water until al dente.',
    'Make the sauce: Mash the garlic into the onions, then stir in the cream, Parmesan and ½ cup pasta water.',
  ].join('\n')
  const result = parseSocialRecipeCaption(caption)
  assert.equal(result.name, 'Caramelized Onion and Garlic Chicken Pasta')
  const expected = [
    '3 large yellow onions, thinly sliced',
    '2 heads garlic, halved crosswise',
    '4 chicken breasts',
    '1/3 cup olive oil, divided',
    'Salt and freshly ground black pepper',
    '2 tsp dried Italian seasoning',
    '2 tsp paprika',
    '1/2 tsp red pepper flakes, optional',
    '2 lb pasta',
    '1 cup heavy cream',
    '1 cup freshly grated Parmesan, plus more for serving',
    'Fresh parsley, chopped, for serving',
    '1-2 cup reserved pasta water',
  ]
  assert.deepEqual(result.ingredients.split('\n'), expected)
  assert.equal(result.ingredientParts.length, expected.length)
  assert.equal(result.instructions.split('\n').length, 4)
  assert.doesNotMatch(result.name, /this was 10 out of 10/i)
  assert.doesNotMatch(result.ingredients, /Roast the onions|Instructions/i)
})

test('not every numeral or unlabelled promotional paragraph is an ingredient list', () => {
  const result = parseSocialRecipeCaption([
    'This was 10 out of 10! We made 4 huge batches and shared with friends.',
    'I made 3 mistakes on my first attempt.',
    'Save this for later.',
    'Instructions',
    '1. See the original full recipe link.',
  ].join('\n'))
  assert.equal(result.name, '')
  assert.equal(result.ingredients, '')
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

test('all description ingredient sections survive sauce, toppings and garnish headings after cooking steps', () => {
  const description = [
    'High Protein Chicken Bowls',
    'Ingredients:',
    '- 500g chicken breast',
    '- 200g cooked rice',
    'Instructions:',
    '1. Cook the chicken for 20 minutes.',
    '2. Combine chicken and rice.',
    'SAUCE INGREDIENTS:',
    '• 2 tbsp mayonnaise',
    '• 1 tbsp sweet chili sauce',
    'For the garnish:',
    '- scallions to taste',
    'Method:',
    '3. Drizzle sauce and add scallions.',
  ].join('\n')
  const draft = parseSocialRecipeCaption(description)
  assert.equal(draft.name,'High Protein Chicken Bowls')
  assert.deepEqual(draft.ingredients.split('\n'), [
    '500g chicken breast',
    '200g cooked rice',
    '2 tbsp mayonnaise',
    '1 tbsp sweet chili sauce',
    'scallions to taste',
  ])
  assert.deepEqual(draft.instructions.split('\n'), [
    'Cook the chicken for 20 minutes.',
    'Combine chicken and rice.',
    'Drizzle sauce and add scallions.',
  ])
})

test('measured ingredient bullets after a directions section cannot be silently omitted or treated as instructions', () => {
  const draft = parseSocialRecipeCaption([
    'Chicken Salad',
    'Ingredients:',
    '- 1 lb chicken',
    'Directions:',
    '1. Cook the chicken.',
    '• 1 cup Greek yogurt',
    '• 2 tsp mustard',
    '2. Mix and serve.',
  ].join('\n'))
  assert.deepEqual(draft.ingredients.split('\n'), ['1 lb chicken', '1 cup Greek yogurt', '2 tsp mustard'])
  assert.deepEqual(draft.instructions.split('\n'), ['Cook the chicken.', 'Mix and serve.'])
})

test('preserves sectioned description without requiring each subsection to say Ingredients', () => {
  const draft = parseSocialRecipeCaption([
    'Garlic Chicken',
    'Ingredients (serves 4)',
    '- 2 chicken thighs',
    'For the marinade:',
    '- 1 tbsp olive oil',
    '- 2 tsp garlic',
    'For the dressing:',
    '- 2 tbsp yogurt',
    'Instructions:',
    '1. Mix and cook the chicken.',
  ].join('\n'))
  assert.equal(draft.ingredients.split('\n').length, 4)
  assert.match(draft.ingredients,/olive oil/)
  assert.match(draft.ingredients,/yogurt/)
  assert.equal(draft.instructions, 'Mix and cook the chicken.')
})

test('consolidates sauce and marinade sriracha into one measured ingredient with a section breakdown', () => {
  const caption = parseSocialRecipeCaption([
    'Sweet Chili Chicken',
    'For the sauce:',
    '- 30g sriracha',
    '- 100g mayonnaise',
    'Instructions:',
    '1. Whisk the sauce.',
    'For the marinade:',
    '- 70g sriracha',
    '2. Marinate the chicken.',
  ].join('\n'))
  assert.deepEqual(caption.ingredientParts.filter(item => /sriracha/i.test(item.line)), [
    { line: '30g sriracha', section: 'sauce' },
    { line: '70g sriracha', section: 'marinade' },
  ])
  const result = consolidateRecipeIngredientAmounts(caption.ingredients, caption.ingredientParts)
  assert.equal(result.ingredients, '100g sriracha\n100g mayonnaise')
  assert.match(result.allocationNotes, /sriracha: 30g for sauce; 70g for marinade/i)
  assert.equal(caption.instructions, 'Whisk the sauce.\nMarinate the chicken.')
})

test('uses exact compatible units without guessing that 20g equals 2 tbsp', () => {
  const result = consolidateRecipeIngredientAmounts([
    '30g sriracha',
    '0.07kg sriracha',
    '2 tbsp sriracha',
    '150g raw chicken',
    '200g cooked chicken',
  ].join('\n'), [
    {line:'30g sriracha',section:'sauce'},
    {line:'0.07kg sriracha',section:'marinade'},
  ])
  assert.equal(result.ingredients, [
    '100g sriracha',
    '2 tbsp sriracha',
    '150g raw chicken',
    '200g cooked chicken',
  ].join('\n'))
  assert.match(result.allocationNotes,/30g for sauce; 70g for marinade/)
})

test('quantity descriptions with optional of combine safely without combining different ingredient names', () => {
  const result = consolidateRecipeIngredientAmounts('30 grams of sriracha\n70g sriracha\n30g fresh chili sauce')
  assert.equal(result.ingredients, '100g sriracha\n30g fresh chili sauce')
})

test('same ingredient with compatible count units is a single total; different descriptions stay separate', () => {
  const result = consolidateRecipeIngredientAmounts([
    '2 cloves garlic',
    '3 cloves garlic',
    '1 clove garlic powder',
    '1 cup water',
    '250ml water',
  ].join('\n'))
  assert.equal(result.ingredients,'5 cloves garlic\n1 clove garlic powder\n1 cup water\n250ml water')
  assert.equal(result.allocationNotes,'')
})

test('does not silently drop unsupported amounts, non-numeric text, or different qualifiers', () => {
  const input = 'salt to taste\n30g fresh sriracha\n70g dried sriracha\none bunch cilantro'
  const result = consolidateRecipeIngredientAmounts(input)
  assert.equal(result.ingredients, input)
  assert.equal(result.allocationNotes,'')
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
