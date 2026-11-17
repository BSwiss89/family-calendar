// TEST-only primary recipe assembly. Use schema-constrained Ollama and
// explicit error categories; never silently treat failed model output as valid.
export const PRIMARY_RECIPE_SCHEMA={
  type:'object',
  properties:{
    name:{type:'string'},ingredients:{type:'array',items:{type:'string'}},
    instructions:{type:'array',items:{type:'string'}},
    videoIngredientsAdded:{type:'array',items:{type:'string'}},
    videoInstructionsAdded:{type:'array',items:{type:'string'}},
    conflicts:{type:'array',items:{type:'string'}},
    servings:{type:'string'},nutritionNotes:{type:'string'},
  },
  required:['name','ingredients','instructions','videoIngredientsAdded',
    'videoInstructionsAdded','conflicts','servings','nutritionNotes'],
  additionalProperties:false,
}

const sliceEdge=(text,head,tail)=>{
  const value=typeof text==='string'?text.trim():''
  return value.length<=head+tail ? value :
    value.slice(0,head)+'\n[intervening repeated evidence omitted]\n'+value.slice(-tail)
}

export function buildPrimaryRecipeRequest({
  caption='',comment='',transcript='',visibleText='',
}={}) {
  const screen=String(visibleText)
  const visualAt=screen.indexOf('Visual cooking actions around ')
  const ocr=visualAt>=0?screen.slice(0,visualAt):screen
  const visual=visualAt>=0?screen.slice(visualAt):''
  const evidence=[
    'CREATOR CAPTION (source of ingredient totals):\n'+sliceEdge(caption,5000,800),
    String(comment).trim()?'CREATOR COMMENT:\n'+String(comment).slice(0,1500):'',
    String(transcript).trim()?'SPOKEN WORDS (chronological):\n'+sliceEdge(transcript,2800,1200):'',
    String(ocr).trim()?'TIMESTAMPED SCREEN TEXT (repeated variants possible):\n'+sliceEdge(ocr,1600,1400):'',
    String(visual).trim()?'CHRONOLOGICAL OBSERVED ACTIONS:\n'+sliceEdge(visual,3400,2200):'',
  ].filter(Boolean).join('\n\n')
  const system=[
    'Extract a cooking recipe STRICTLY from the evidence. Return JSON matching the provided schema.',
    'Every array contains SHORT STRINGS, never objects. No essays or explanation.',
    'Ingredients: preserve creator-caption ingredient totals. Never invent items, quantities, oils, garnishes, temperatures or substitutions.',
    'Instructions: chronological concise cooking steps grounded in spoken, readable or visibly confirmed actions. Oven settings alone are not a complete method.',
    'When seasonings are divided, ingredient quantities are recipe totals; reserve half without doubling totals.',
    'If a whole garlic bulb is roasted with onions, squeeze roasted garlic only after baking, never before.',
    'Include each oven time/temperature once WITH its corresponding cooking action.',
    'videoIngredientsAdded/videoInstructionsAdded: only video facts not already in caption.',
    'conflicts: only real contradictions between sources, not details omitted from caption.',
    'servings and nutritionNotes: only when explicitly supported. Leave unknown fields empty.',
    'Do not make up cooking actions or ingredient quantities. Be concise to complete JSON.',
  ].join('\n')
  return {
    model:'ministral-3:8b',stream:false,think:false,
    format:PRIMARY_RECIPE_SCHEMA,keep_alive:'5m',
    options:{temperature:0,num_ctx:8192,num_predict:1700},
    messages:[
      {role:'system',content:system},
      {role:'user',content:evidence.slice(0,19200)},
    ],
  }
}

export function checkPrimaryRecipeShape(input) {
  if (!input || typeof input!=='object' || Array.isArray(input)) return false
  const value=input.recipe && typeof input.recipe==='object' && !Array.isArray(input.recipe)
    ? input.recipe:input
  return ['name','servings','nutritionNotes'].every(k=>typeof value[k]==='string') &&
    ['ingredients','instructions','videoIngredientsAdded','videoInstructionsAdded','conflicts']
      .every(k=>Array.isArray(value[k]) && value[k].length<=90 &&
        value[k].every(x=>typeof x==='string' && x.length<=1200))
}

export async function runPrimaryRecipeOrganizer(evidence, {
  fetchImpl=fetch,timeoutMs=135_000,onStatus=()=>{},
}={}) {
  const values=[evidence?.caption,evidence?.comment,evidence?.transcript,evidence?.visibleText]
  if (!values.some(v=>typeof v==='string' && v.trim())) {
    onStatus('no-evidence');return null
  }
  try {
    const response=await fetchImpl('http://127.0.0.1:11434/api/chat',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(buildPrimaryRecipeRequest(evidence)),
      signal:AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {onStatus('http-error');return null}
    const data=await response.json()
    if (data?.done_reason==='length') {onStatus('output-truncated');return null}
    const raw=data?.message?.content
    if (typeof raw!=='string' || !raw.trim()) {
      onStatus('empty-output');return null
    }
    let parsed
    try {parsed=JSON.parse(raw)} catch {
      onStatus('invalid-json');return null
    }
    if (!checkPrimaryRecipeShape(parsed)) {
      onStatus('wrong-json-shape');return null
    }
    const result=parsed.recipe && typeof parsed.recipe==='object'?parsed.recipe:parsed
    onStatus('ok')
    return result
  } catch(error) {
    onStatus(error?.name==='TimeoutError'||error?.name==='AbortError'
      ?'timeout':'request-failed')
    return null
  }
}
