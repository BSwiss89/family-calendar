// TEST-only fail-soft extraction of observed cooking actions when local
// recipe organization is temporarily unavailable. This never fabricates
// measured quantities, guesses hidden steps, or upgrades model observation to
// verified caption information.
const actionVerb = /\b(?:add|adding|place|placing|put|putting|pour|pouring|mix|mixing|stir|stirring|chop|chopping|slice|slicing|spread|spreading|bake|baking|roast|roasting|squeeze|squeezing|spray|spraying|combine|combining|cook|cooking|boil|boiling|drain|draining|season|seasoning|cut|cutting|top|topping|fold|folding|transfer|transferring|flip|flipping)\b/i
const foodAction = /\b(?:chicken|onions?|garlic|pasta|cheese|cream|sauce|milk|tray|baking paper|parchment|spices?|seasonings?|oil|tomato|water|pan|bowl|oven|butter|rice|vegetables?|noodles?|meat|flour|broth|ingredients?)\b/i
const uncertain = /\b(?:maybe|possibly|probably|presumably|appears to|seems to|might be|could be|unclear|not visible|not discernible|unreadable|cannot tell|can't tell)\b/i
const normalize = value => String(value).toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu,' ').trim()

export function meaningfulCookingStepCount(instructions = '') {
  if (typeof instructions !== 'string') return 0
  return instructions.split('\n').filter(line =>
    actionVerb.test(line) &&
    !(/^\s*(?:oven\s+)?bake at \d{3}°?C\s*\/?\s*\d{3}°?F/i.test(line) &&
      /\bminutes?\b/i.test(line)) &&
    !(/^\s*oven bake at \d{3}°?C/i.test(line))
  ).length
}

export function extractObservedCookingSteps(visibleText = '', maxSteps = 20) {
  if (typeof visibleText !== 'string' || !visibleText) return []
  const sections = visibleText.split(/(?=^Visual cooking actions around \d+(?:\.\d+)?(?:-\d+(?:\.\d+)?)? seconds:)/gm)
  const steps = [], seen = new Set()
  for (const section of sections) {
    const match = /^Visual cooking actions around [\d.]+(?:-[\d.]+)? seconds:\s*([\s\S]*)$/m.exec(section)
    if (!match) continue
    const lines = match[1].split(/\n|(?<=[.!?])\s+(?=[A-Z])/)
    for (const raw of lines) {
      const candidate = raw.trim().replace(/^(?:[-•*]|\d{1,2}[.)])\s*/,'')
        .replace(/^(?:step|frame|action)\s*\d+:\s*/i,'')
        .replace(/\s+/g,' ').slice(0,245).trim()
      if (candidate.length < 12 || candidate.length > 240 ||
          !actionVerb.test(candidate) || !foodAction.test(candidate) ||
          uncertain.test(candidate) ||
          /\b(?:settings on screen|use the temperature shown|not specified)\b/i.test(candidate)) continue
      const key=normalize(candidate)
      if (seen.has(key)) continue
      seen.add(key)
      steps.push(candidate)
      if (steps.length >= Math.max(1,Math.min(30,maxSteps))) return steps
    }
  }
  return steps
}

export function canImproveRecipeDraft(before, after) {
  if (!after || typeof after !== 'object') return false
  const was=meaningfulCookingStepCount(before?.instructions||'')
  const now=meaningfulCookingStepCount(after.instructions||'')
  return Boolean((after.ingredients && !before?.ingredients) ||
    (after.instructions && !before?.instructions) ||
    (after.name && !before?.name) ||
    now > was)
}

export function organizeRecoveryEvidence({caption='',comment='',transcript='',visibleText=''}={}) {
  // Keep the video sequence and short cooking text cards, not thousands of
  // repeated timestamps that can exhaust the local model's prompt budget.
  const visual = String(visibleText).split(/(?=^Visual cooking actions around \d)/m)
    .slice(1).join('').slice(0,4000)
  const ocr = String(visibleText).split(/^Visual cooking actions around \d/m)[0].slice(0,3600)
  return [
    'Verified creator recipe description (total ingredient quantities):\n'+String(caption).slice(0,2500),
    String(comment).trim()?'Creator comment:\n'+String(comment).slice(0,1200):'',
    String(transcript).trim()?'Spoken video instructions:\n'+String(transcript).slice(0,3500):'',
    visual ? 'Chronological visual observations (may need user verification):\n'+visual:'',
    ocr ? 'On-screen OCR cooking text:\n'+ocr:'',
  ].filter(Boolean).join('\n\n').slice(0,11500)
}
