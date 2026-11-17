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
  const laterSqueeze=lines.slice(ovenAfter+1).some(x=>
    /\bsqueeze\b.*\bgarlic\b|\bgarlic\b.*\bsqueeze\b/i.test(x))
  const updated=[...lines]
  updated[early]='Cut the top off the whole garlic bulb and place it in the tray with the onions.'
  if (!laterSqueeze) updated.splice(ovenAfter+1,0,
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

function stripUnsupportedPaperTowel(lines, evidence) {
  // Video explicitly says 'baking paper' / 'parchment', not paper towel.
  // Only correct that wording when real non-model evidence supports it.
  if (!/\b(?:baking|parchment)\s+paper\b/i.test(evidence) ||
      /\bpaper towel\b/i.test(evidence)) return lines
  return lines.map(line=> /\bpaper towel\b/i.test(line) &&
      /\b(?:chicken|set aside)\b/i.test(line)
    ? line.replace(/\s*(?:with\s+)?paper towel\s+underneath\b[.,;]?/ig,'')
      .replace(/\b(?:on|over)\s+a?\s*paper towel\b[.,;]?/ig,'')
      .replace(/[,.;\s]+$/,'')+'.'
    : line)
}

function ovenMinutes(line) {
  const text=String(line).replace(/[–—]/g,'-')
  const ranged=/\b(\d{1,3})\s*-\s*(\d{1,3})\s*(?:min(?:ute)?s?)\b/i.exec(text)
  if (ranged) return [Number(ranged[1]),Number(ranged[2])]
  const single=/\b(\d{1,3})\s*(?:min(?:ute)?s?)\b/i.exec(text)
  return single ? [Number(single[1]),Number(single[1])] : null
}

function ovenSubject(line) {
  if (/\bchicken\b/i.test(line)) return 'chicken'
  if (/\bonions?\b/i.test(line)) return 'onions'
  if (/\b(?:potatoes|potato)\b/i.test(line)) return 'potatoes'
  if (/\bfish\b/i.test(line)) return 'fish'
  return ''
}

function sameOvenAction(first,second) {
  const heat=heatKey(first)
  if (!heat || heat!==heatKey(second)) return false
  const firstSubject=ovenSubject(first),secondSubject=ovenSubject(second)
  if (firstSubject && secondSubject && firstSubject!==secondSubject) return false
  const a=ovenMinutes(first),b=ovenMinutes(second)
  if (a && b) {
    // Match exact ranges or one endpoint (OCR sometimes only reads 25 Min).
    const sameRange=a[0]===b[0]&&a[1]===b[1]
    const oneEndpoint=(a[0]===a[1]&&[b[0],b[1]].includes(a[0])&&b[1]-b[0]<=10) ||
      (b[0]===b[1]&&[a[0],a[1]].includes(b[0])&&a[1]-a[0]<=10)
    if (!sameRange && !oneEndpoint) return false
  } else if (!a || !b) return false
  return true
}

function removeRepeatedOvenSteps(lines) {
  const result=[]
  for (const line of lines) {
    if (!ovenContext(line)) {result.push(line);continue}
    const previous=result.findIndex(existing=>sameOvenAction(existing,line))
    if (previous<0) {result.push(line);continue}
    const existing=result[previous]
    // Keep the first, correctly ordered step. Borrow only a missing halfway
    // action from a later duplicate; do not copy its temperature/time.
    const found=/\b(?:flip|turn|stir|mix)\b.{0,30}\bhalfway\b/i.exec(line)
    if (!/\bhalfway\b/i.test(existing) && found) {
      const action=/\bflip\b/i.test(found[0])?'flip':
        /\bturn\b/i.test(found[0])?'turn':'stir'
      result[previous]=existing.replace(/[.]\s*$/,'')+'; '+action+' halfway through.'
    }
  }
  const hasMeasuredOven=result.some(ovenContext)
  return hasMeasuredOven ? result.filter(line=>
    !/\b(?:bake|oven)\b.{0,50}\bsettings?\b.{0,20}\bscreen\b/i.test(line)) : result
}
export function refineSocialRecipeInstructions({
  instructions = '', ingredients = '', caption = '', visibleText = '', transcript = '',
} = {}) {
  if (typeof instructions !== 'string') return ''
  const lines=instructions.split(/\r?\n/)
    .map(line=>line.trim().replace(/\*\*/g,'')
      .replace(/^\s*(?:[-•*]|\d{1,2}[.)])\s+/,'')) // formatting only
    .filter(Boolean)
  if (!lines.length) return ''
  const evidence=[caption,visibleText,transcript].filter(Boolean).join('\n')
  const corrected=videoBackedGarlicCorrection(
    cleanSeasoningAllocation(stripUnsupportedPaperTowel(lines,evidence),ingredients),ingredients)
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
