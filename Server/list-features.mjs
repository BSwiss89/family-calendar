// Shared list features. Categories are stored in SQLite so every device sees them.
export const DEFAULT_LIST_CATEGORY = 'General'

export function normalizeListCategory(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_LIST_CATEGORY
  if (typeof value !== 'string') throw new TypeError('Category must be text.')
  const category = value.trim()
  if (!category) return DEFAULT_LIST_CATEGORY
  if (category.length > 40) throw new RangeError('Category must be 40 characters or fewer.')
  return category
}

export function ensureListItemCategories(database) {
  const columns = database.prepare('PRAGMA table_info(list_items)').all()
  if (!columns.some(column => column.name === 'category')) {
    // Additive migration: keeps every existing list item and marks it General.
    database.exec("ALTER TABLE list_items ADD COLUMN category TEXT NOT NULL DEFAULT 'General'")
  }
}
