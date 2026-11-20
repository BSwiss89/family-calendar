// Pure, shared legacy input-validation behavior used by the Family Calendar API.
// Keep these semantics stable across LIVE and TEST. No auth, data, or IO access.
export function isValidDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date)
}

export function isValidTitle(title) {
  return (
    typeof title === 'string' &&
    title.trim().length > 0 &&
    title.trim().length <= 200
  )
}

export function isValidPersonName(name) {
  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.trim().length <= 50
  )
}

export function isValidColor(color) {
  return /^#[0-9A-Fa-f]{6}$/.test(color)
}
export function cleanOptionalText(value, maxLength) {
  if (typeof value !== 'string') {
    return null
  }

  const cleaned = value.trim()

  if (cleaned.length === 0) {
    return null
  }

  return cleaned.slice(0, maxLength)
}

