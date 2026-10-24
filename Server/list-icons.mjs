// Stable, locally rendered list-icon choices. User-created lists are not assigned
// inferred icons or colors based on their names.
export const LIST_ICON_IDS = Object.freeze([
  'shopping-cart', 'garage', 'briefcase', 'checklist', 'star', 'balloons',
  'paw-print', 'plane', 'gift', 'wrench', 'calendar', 'folder',
  'utensils', 'car', 'gamepad', 'graduation-cap', 'package', 'file-text',
  'pill', 'shirt', 'book', 'music', 'camera', 'plant',
])
const choices = new Set(LIST_ICON_IDS)

// A null choice is intentional: the Create List button begins with no icon.
export function normalizeListIcon(value) {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !choices.has(value)) {
    throw new RangeError('Choose an available list icon.')
  }
  return value
}

export function ensureListIcons(database) {
  const columns = database.prepare('PRAGMA table_info(lists)').all()
  if (!columns.some(column => column.name === 'icon')) {
    database.exec('ALTER TABLE lists ADD COLUMN icon TEXT')
  }
}
