// Read-only ingredient arithmetic for social recipe previews. Never infer
// densities or convert weight into volume; never change saved recipes.
const units = [
  [/^(?:g|grams?|grammes?)$/i, 'mass', 1, 'g'],
  [/^(?:kg|kilograms?)$/i, 'mass', 1000, 'g'],
  [/^(?:mg|milligrams?)$/i, 'mass', .001, 'g'],
  [/^(?:ml|milliliters?|millilitres?)$/i, 'liquid', 1, 'ml'],
  [/^(?:l|liters?|litres?)$/i, 'liquid', 1000, 'ml'],
  [/^(?:tsp|teaspoons?)$/i, 'spoons', 1, 'tsp'],
  [/^(?:tbsp|tablespoons?)$/i, 'spoons', 3, 'tsp'],
  [/^(?:cups?)$/i, 'spoons', 48, 'tsp'],
  [/^(?:oz|ounces?)$/i, 'imperial-mass', 1, 'oz'],
  [/^(?:lb|lbs|pounds?)$/i, 'imperial-mass', 16, 'oz'],
  [/^(?:cloves?)$/i, 'cloves', 1, 'cloves'],
  [/^(?:slices?)$/i, 'slices', 1, 'slices'],
  [/^(?:pieces?)$/i, 'pieces', 1, 'pieces'],
]
const amountRx = /^(\d+(?:[.,]\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+|[¼½¾⅓⅔⅛⅜⅝⅞])\s*(?:(mg|kg|g|grams?|grammes?|milligrams?|kilograms?|ml|l|milliliters?|millilitres?|liters?|litres?|cups?|tablespoons?|tbsp|teaspoons?|tsp|oz|ounces?|lbs?|pounds?|cloves?|slices?|pieces?)\b\s*)?(.+)$/iu
const fractions = { '¼': .25, '½': .5, '¾': .75, '⅓': 1/3, '⅔': 2/3, '⅛': .125, '⅜': .375, '⅝': .625, '⅞': .875 }
const fmt = value => Number(value.toFixed(3)).toString()
function quantity(value) {
  if (fractions[value] !== undefined) return fractions[value]
  return value.split(/\s+/).reduce((sum, part) => {
    if (!part.includes('/')) return sum + Number(part.replace(',', '.'))
    const [n, d] = part.split('/').map(Number)
    return sum + (d > 0 ? n/d : NaN)
  }, 0)
}
function parseIngredient(value) {
  const match = amountRx.exec(value.trim())
  if (!match) return null
  const number = quantity(match[1]), name = match[3]?.trim().replace(/^of\s+/i, '')
  if (!Number.isFinite(number) || number <= 0 || number > 100000 ||
      !name || name.length > 160 || /^[0-9]/.test(name) ||
      /^(?:calories?|kcal|protein|carbs?|fat)\b/i.test(name)) return null
  const unit = match[2] || ''
  const spec = unit ? units.find(entry => entry[0].test(unit)) : null
  if (unit && !spec) return null
  const family = spec?.[1] || 'count', factor = spec?.[2] || 1
  const normalized = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  if (normalized.length < 2) return null
  return { name, family, unit, value: number * factor, key: family + ':' + normalized }
}
function display(number, family, unitsUsed) {
  if (family === 'spoons') {
    if (unitsUsed.every(u => /^(?:tbsp|tablespoons?)$/i.test(u)))
      return fmt(number/3) + ' tbsp'
    if (unitsUsed.every(u => /^cups?$/i.test(u))) return fmt(number/48) + ' cup'
    return fmt(number) + ' tsp'
  }
  const unit = family === 'mass' ? 'g' : family === 'liquid' ? 'ml'
    : family === 'imperial-mass' ? 'oz' : family === 'count' ? ''
    : family
  return fmt(number) + (unit ? (['g','ml','oz'].includes(unit) ? '' : ' ') + unit : '')
}
function sectionLabel(value) {
  const label = typeof value === 'string'
    ? value.toLowerCase().replace(/^for\s+(?:the\s+|a\s+)?/,'')
      .replace(/\s+ingredients?$/i, '').replace(/[:\-–—]+$/, '').trim()
    : ''
  return !label || /^(?:ingredients?|recipe|what you need|what you'll need)$/i.test(label)
    ? 'main recipe' : label.slice(0,45)
}
// Only explicit, comparable measured lines are combined. Separate-section
// allocations go into the existing recipe Notes/description rather than
// contaminating the single item added to a grocery list.
export function consolidateRecipeIngredientAmounts(ingredientText = '', parts = []) {
  const lines = typeof ingredientText === 'string'
    ? ingredientText.split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0,80) : []
  const available = Array.isArray(parts) ? parts.slice(0,160) : []
  const used = new Set()
  const entries = lines.map(line => {
    let section = ''
    for (let i=0; i<available.length; i++) {
      if (used.has(i) || available[i]?.line?.trim() !== line) continue
      used.add(i)
      section = available[i]?.section || ''
      break
    }
    return { line, section: sectionLabel(section), parsed: parseIngredient(line) }
  })
  const groups = new Map()
  entries.forEach((entry,i) => {
    if (!entry.parsed) return
    const list = groups.get(entry.parsed.key) || []
    list.push(i)
    groups.set(entry.parsed.key,list)
  })
  const replace = new Map(), skip = new Set(), notes = []
  for (const indices of groups.values()) {
    if (indices.length < 2) continue
    const matches = indices.map(i=>entries[i])
    const total = matches.reduce((s,entry)=>s+entry.parsed.value,0)
    if (!Number.isFinite(total) || total>1e6) continue
    const first = matches[0].parsed
    const summary = display(total,first.family,matches.map(x=>x.parsed.unit))+' '+first.name
    if (summary.length>260) continue
    replace.set(indices[0],summary)
    for (const i of indices.slice(1)) skip.add(i)
    if (new Set(matches.map(x=>x.section)).size>1) {
      const split = matches.map(entry=>display(entry.parsed.value,entry.parsed.family,[entry.parsed.unit])+' for '+entry.section)
      notes.push(first.name+': '+split.join('; '))
    }
  }
  const ingredients=entries.flatMap((entry,i)=>skip.has(i)?[]:[replace.get(i)||entry.line]).join('\n').slice(0,7000)
  const allocationNotes=notes.length?'Ingredient breakdown:\n'+notes.join('\n'):''
  return {ingredients,allocationNotes}
}
