export type ArneyRecipePreferences = {
  onePot: boolean; pasta: boolean; kidFriendly: boolean; easy: boolean; quick: boolean;
  purpose: '' | 'picky' | 'budget' | 'healthy' | 'different';
  method: '' | 'air-fryer' | 'slow-cooker' | 'breakfast' | 'casserole' | 'low-cleanup'
}
export type PublicRecipe = {
  id: string; name: string; url: string; image: string; category: string; area: string;
  ingredients: string[]; instructions: string; matchNotes: string[]
}
export function parseArneyRecipeDiscovery(raw: unknown): { query: string; preferences: ArneyRecipePreferences } | null
export function normalizeArneyRecipeResults(payload: unknown): PublicRecipe[]
