export declare const DEFAULT_LIST_CATEGORY: 'General'
export declare const SUGGESTED_LIST_CATEGORIES: readonly string[]
export declare function suggestListCategory(value: unknown): string | null
export declare function normalizeListCategory(value: unknown): string
export declare function ensureListItemCategories(database: any): void
export declare function organizeExistingListItems(database: any, listId: number): { categorized: number; remainingGeneral: number } | null
