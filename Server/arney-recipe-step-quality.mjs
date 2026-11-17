// TEST-only: conservative presentation cleanup for an evidence-grounded
// social Reel recipe. Never creates new ingredient quantities or cooking times.
const normalize = value => String(value || '').toLowerCase().normalize('NFKC')
  .replace(/[^\p{L}\p{N}]+/gu,' ').replace(/\s+/g,' ').trim()

function heatKey(line) {
  const text = line.replace(/\*\*/g,'').replace(/[–—]/g,'-')
  const c = /(?:^|[^\d])(\d{3})\s*°?\s*C\b/i.exec(text)
  const f = /(?:^|[^\d])(\d{3})\s*°?\s*F\b/i.exec(text)
  if (!c || !f) return ''
  const celsius=Number(c[1]),fahrenheit=Number(f[1])
  if (celsius<110 || celsius>290 ||
      Math.abs(celsius*9/5+32-fahrenheit)>18) return ''
  return celsius+':'+fahrenheit
}

function ovenContext(line) {
  return /\b(?:bake|oven|roast|cook)\b/i.test(line) && heatKey(line)
}

function isPrepOfRawGarlic(line) {
  return /\b(?:whole\s+)?garlic bulb\b/i.test(line) &&
    /\bcut\b/i.test(line) && /\bsqueeze\b/i.test(line)
}

function videoBackedGarlicCorrection(lines, ingredients) {
  if (!/\b(?:whole|entire)\s+garlic\s+bulb\b/i.test(ingredients)) return lines
  const early = lines.findIndex(isPrepOfRawGarlic)
  if (early < 0) return lines
  // Only shift the action when the recipe itself identifies cooking the onions
  // and garlic together in an oven. Otherwise refuse to guess chronology.
  const ovenAfter = lines.findIndex((line,i)=>i>early &&
    /\b(?:bake|roast|oven)\b/i.test(line) &&
    (/\bonions?\b/i.test(line) ||
      lines.slice(Math.max(early,i-3),i).some(x=>/\bonions?\b/i.test(x))))
  if (ovenAfter < 0) return lines
  if (lines.slice(ovenAfter+1).some(x=>/\bsqueeze\b.*\bgarlic\b|\bgarlic\b.*\bsqueeze\b/i.test(x)))
    return lines
  const updated=[...lines]
  updated[early]='Cut the top off the whole garlic bulb and place it in the tray with the onions.'
  updated.splice(ovenAfter+1,0,
    'Once the onions and garlic have baked, squeeze the roasted garlic cloves from the bulb into the onions.')
  return updated
}

function cleanSeasoningAllocation(lines, ingredients) {
  // User evidence says quantities listed in Ingredients are TOTAL recipe
  // amounts. Avoid describing full amounts as though each half gets them all.
  const hasSeasoning = /\bseason(?:ing)?\b/i.test(ingredients) &&
    /\b(?:paprika|garlic powder|onion powder|herb)\b/i.test(ingredients)
  const remainderUsed = lines.some(line=>/\b(?:remaining|rest of|other half)\b.{0,40}\bseasoning\b/i.test(line))
  if (!hasSeasoning || !remainderUsed) return lines
  const idx=lines.findIndex(line => /\bchicken\b/i.test(line) &&
    /\bhalf\b/i.test(line) && /\b(?:seasoning|paprika|garlic powder|onion powder|herb)\b/i.test(line))
  if (idx<0) return lines
  const output=[...lines]
  const olive = /\bolive oil\b/i.test(ingredients)
  output[idx]='Combine the measured seasonings listed in Ingredients. Use half to season the chicken'+
    (olive?' with the listed olive oil':'')+
    '; reserve the other half for the onions.'
  return output
}

function stripUnsupportedPaperTowel(lines) {
  const mentionsBakingPaper=lines.some(line=>/\b(?:baking|parchment)\s+paper\b/i.test(line))
  return lines.map(line=> /\bpaper towel\b/i.test(line) &&
      /\b(?:chicken|set aside)\b/i.test(line)
    ? line.replace(/\s*(?:with\s+)?paper towel\s+underneath\b[.,;]?/ig,'')
      .replace(/\b(?:on|over)\s+a?\s*paper towel\b[.,;]?/ig,'')
      .replace(/[,.;\s]+$/,'') + (mentionsBakingPaper?' (keep the baking paper with the tray).':'.')
    : line)
}

function removeRepeatedOvenSteps(lines) {
  const result=[],ovenIndices=new Map()
  for (const text of lines) {
    let line=text
    const key=ovenContext(line)
    if (!key) { result.push(line);continue }
    if (!ovenIndices.has(key)) {
      ovenIndices.set(key,result.length)
      result.push(line)
      continue
    }
    const idx=ovenIndices.get(key)
    const existing=result[idx]
    // Retain the first, correctly ordered step. Borrow a missing halfway
    // action from a later duplicate without ever copying its temperature/time.
    const hasHalfway=/\bhalfway\b/i.test(existing)
    const found=/\b(?:flip|turn|stir|mix)\b.{0,30}\bhalfway\b/i.exec(line)
    if (!hasHalfway && found) {
      const action=/\bflip\b/i.test(found[0])?'flip':
        /\bturn\b/i.test(found[0])?'turn':'stir'
      result[idx]=existing.replace(/[.]\s*$/,'')+'; '+action+' halfway through.'
    }
  }
  return result
}

export function refineSocialRecipeInstructions({ instructions = '', ingredients = '' } = {}) {
  if (typeof instructions !== 'string') return ''
  const lines=instructions.split(/\r?\n/)
    .map(line=>line.trim().replace(/\*\*/g,'')
      .replace(/^\s*(?:[-•*]|\d{1,2}[.)])\s+/,'')) // formatting only
    .filter(Boolean)
  if (!lines.length) return ''
  const corrected=videoBackedGarlicCorrection(
    cleanSeasoningAllocation(stripUnsupportedPaperTowel(lines),ingredients),ingredients)
  const deduped=removeRepeatedOvenSteps(corrected)
  // Deduplicate identical lines separately from oven-equivalent duplicates.
  const keys=new Set()
  return deduped.filter(line=>{
    const key=normalize(line)
    if (!key || keys.has(key)) return false
    keys.add(key);return true
  }).slice(0,80).join('\n').slice(0,8000)
}

export function filterRealRecipeConflicts(conflicts = []) {
  if (!Array.isArray(conflicts)) return []
  return conflicts.filter(value=>typeof value==='string')
    .map(line=>line.replace(/\*\*/g,'').trim())
    .filter(line=>line.length>0 &&
      !/\bno conflict\b|\bconfirmed by (?:visual|video)\b/i.test(line) &&
      // Omission is not a disagreement: the caption need not enumerate
      // every action shown in the Reel.
      !/\bcaption\b.{0,45}\b(?:does not|doesn.t|did not|omits?|not mention|not specify)\b/i.test(line))
    .slice(0,5).map(line=>line.slice(0,220))
}
