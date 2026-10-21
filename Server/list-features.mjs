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

export function duplicateListInDatabase(database, sourceId, newName) {
  const original = database.prepare('SELECT id FROM lists WHERE id = ?').get(sourceId)
  if (!original) return null
  database.exec('BEGIN IMMEDIATE')
  try {
    const created = database.prepare('INSERT INTO lists (name) VALUES (?)').run(newName)
    const newId = Number(created.lastInsertRowid)
    const originalItems = database.prepare(
      'SELECT text, category, sort_order FROM list_items WHERE list_id = ? ORDER BY sort_order, id'
    ).all(sourceId)
    const insert = database.prepare(
      'INSERT INTO list_items (list_id, text, category, completed, sort_order) VALUES (?, ?, ?, 0, ?)'
    )
    originalItems.forEach((item, index) => {
      insert.run(newId, item.text, item.category, index + 1)
    })
    database.exec('COMMIT')
    return { id: newId, name: newName, copiedItems: originalItems.length }
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}
