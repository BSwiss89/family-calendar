// Conservative lexical DDL comparison, never evaluates archived SQL.
// Only counts and fixed categories escape this module. This is not a SQL
// equivalence parser: unmatched tokens require human review.
const tokenPattern = /\s+|--[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|\x60(?:\x60\x60|[^\x60])*\x60|\[[^\]]*\]|[A-Za-z_][A-Za-z0-9_$]*|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|<=|>=|<>|!=|==|\|\||<<|>>|->>|->|[(),.;=<>+\-*/%~&|]/y
function tokens(sql) {
 if(typeof sql!=='string'||!sql.length||sql.length>100000)throw Error('Unreviewed DDL')
 const result=[]
 let i=0
 while(i<sql.length){
  tokenPattern.lastIndex=i
  const m=tokenPattern.exec(sql)
  if(!m)throw Error('Unreviewed DDL token')
  i=tokenPattern.lastIndex
  const x=m[0]
  if(/^\s/.test(x)||x.startsWith('--')||x.startsWith('/*'))continue
  // Bare SQLite keywords and ASCII identifiers are case insensitive.
  // Quoted tokens, including string literals, are preserved byte-for-byte.
  result.push(/^[A-Za-z_]/.test(x)?x.toLowerCase():x)
 }
 return result
}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
function balancedEnd(t,start){
 let depth=0
 for(let i=start;i<t.length;i++){
  if(t[i]==='(')depth++
  else if(t[i]===')'&&--depth===0)return i
 }
 throw Error('Unbalanced DDL')
}
function parts(sql){
 const t=tokens(sql),start=t.indexOf('(')
 if(start<0||t[0]!=='create'||t[1]!=='table')throw Error('Unreviewed DDL header')
 const end=balancedEnd(t,start)
 const groups=[]
 let group=[],depth=0
 for(const x of t.slice(start+1,end)){
  if(x===','&&depth===0){if(!group.length)throw Error('Empty DDL group');groups.push(group);group=[];continue}
  if(x==='(')depth++
  if(x===')')depth--
  group.push(x)
 }
 if(!group.length||depth!==0)throw Error('Unreviewed DDL group')
 groups.push(group)
 const checks=[]
 for(const g of groups){
  for(let i=0;i<g.length-1;i++){
   if(g[i]==='check'&&g[i+1]==='('){
    const stop=balancedEnd(g,i+1)
    checks.push(g.slice(i+2,stop))
    i=stop
   }
  }
 }
 return {t,header:t.slice(0,start),suffix:t.slice(end+1),groups,checks}
}
const sorted=xs=>xs.map(x=>JSON.stringify(x)).sort()
export function reviewLegacyTableDefinitionDifference(actualSql,expectedSql){
 try {
  const a=parts(actualSql),b=parts(expectedSql)
  const exact=actualSql===expectedSql
  const lexical=same(a.t,b.t)
  const reordered=same(a.header,b.header)&&same(a.suffix,b.suffix)&&same(sorted(a.groups),sorted(b.groups))
  return {
   classification:exact?'EXACT':lexical?'LEXICAL_MATCH':reordered?'DECLARATION_REORDER_ONLY':'REVIEW_REQUIRED',
   checkExpressionTokensMatch:same(sorted(a.checks),sorted(b.checks)),
   // Token equality alone does not prove equivalent enforcement order.
   semanticEquivalenceProven:false
  }
 } catch {
  return {classification:'UNRECOGNIZED_DDL_REVIEW_REQUIRED',checkExpressionTokensMatch:false,semanticEquivalenceProven:false}
 }
}

// The only remaining historical discrepancy is event_people. Recognize
// exactly the reviewed two single-column CASCADE foreign keys, in either
// column or table declaration form. Never strip arbitrary SQL clauses.
export function reviewEventPeopleReferencePlacement(sql) {
 try {
  const a=parts(sql)
  if(!same(a.header,['create','table','event_people'])||!same(a.suffix,['strict']))return false
  for(const eventInline of [true,false])for(const personInline of [true,false]){
   const eventRef='REFERENCES events(id) ON DELETE CASCADE'
   const personRef='REFERENCES people(id) ON DELETE CASCADE'
   const declarations=[
    'event_id INTEGER NOT NULL'+(eventInline?' '+eventRef:''),
    'person_id INTEGER NOT NULL'+(personInline?' '+personRef:''),
    'PRIMARY KEY(event_id,person_id)',
    ...(!eventInline?['FOREIGN KEY(event_id) '+eventRef]:[]),
    ...(!personInline?['FOREIGN KEY(person_id) '+personRef]:[])
   ]
   const b=parts('CREATE TABLE event_people ('+declarations.join(',')+') STRICT')
   if(same(sorted(a.groups),sorted(b.groups)))return true
  }
  return false
 } catch {return false}
}
