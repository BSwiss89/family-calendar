// Display-only examples. Each phrase must pass parseArneyRecipeDiscovery;
// tapping runs the same read-only search as speaking through blue +.
export const ARNEY_RECIPE_SUGGESTIONS = Object.freeze([
  'Find easy dinner ideas',
  'Show me kid-friendly meals',
  'Find something for picky eaters',
  'Give me family dinner ideas',
  'Find easy chicken recipes',
  'Show me simple pasta dishes',
  'Find meals with ground beef',
  'Find mild dinners for kids',
  'Show me one-pot meals',
  'Find easy casseroles',
  'Find quick dinner ideas',
  'Find easy breakfast ideas',
  'Find budget-friendly meals',
  'Find healthy family dinners',
  'Find meals with fewer dishes to wash',
  'Give me something different for dinner',
  'Find easy meals for busy weeknights',
  'Find chicken and rice recipes',
])
export const ARNEY_RECIPE_SUGGESTIONS_PER_PAGE = 6
export function suggestionPage(page) {
  const count=Math.ceil(ARNEY_RECIPE_SUGGESTIONS.length/ARNEY_RECIPE_SUGGESTIONS_PER_PAGE)
  const safe=Number.isInteger(page)&&page>=0?page%count:0
  return ARNEY_RECIPE_SUGGESTIONS.slice(safe*ARNEY_RECIPE_SUGGESTIONS_PER_PAGE,
    (safe+1)*ARNEY_RECIPE_SUGGESTIONS_PER_PAGE)
}
