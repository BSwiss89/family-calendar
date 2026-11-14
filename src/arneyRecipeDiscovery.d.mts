export type ArneyRecipePreferences = { onePot: boolean; pasta: boolean; kidFriendly: boolean }
export type PublicRecipe = {
  id: string; name: string; url: string; image: string; category: string; area: string;
  ingredients: string[]; instructions: string; matchNotes: string[]
}
export function parseArneyRecipeDiscovery(raw: unknown): { query: string | null; preferences: ArneyRecipePreferences } | null
export function normalizeArneyRecipeResults(payload: unknown): PublicRecipe[]
