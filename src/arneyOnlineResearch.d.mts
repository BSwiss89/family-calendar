export type ArneyPublicRecipeRequest = { query: string | null }
export type ArneyPublicRecipeReply = { kind: 'information' | 'error'; text: string }
export function parseArneyPublicRecipeRequest(raw: unknown): ArneyPublicRecipeRequest | null
export function formatArneyPublicRecipeReply(payload: unknown, query: string): ArneyPublicRecipeReply
