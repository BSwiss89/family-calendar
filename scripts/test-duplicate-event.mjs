import test from 'node:test'
import assert from 'node:assert/strict'
import { makeEventDuplicateDraft } from '../src/duplicateEvent.mjs'

const sourceEvent = () => ({
  id: 17, batchId: 'batch-1',
  date: '2026-10-21', endDate: null,
  title: 'Dentist', time: '14:30', endTime: '15:30',
  notes: 'Bring insurance', location: 'Houston, TX 77002',
  people: [{id:2,name:'A'}, {id:3,name:'B'}],
  repeatUnit: 'week', repeatInterval: 2,
  repeatEndType: 'count', repeatCount: 12,
  exceptions: ['2026-10-28'],
})

test('duplicate copies details but not identity, batch, exceptions, or series', () => {
  const source = sourceEvent()
  const original = structuredClone(source)
  const draft = makeEventDuplicateDraft(source,'2026-11-04')
  assert.deepEqual(draft, {
    title:'Dentist', date:'2026-11-04', endDate:null,
    time:'14:30',endTime:'15:30',allDay:false,
    notes:'Bring insurance',location:'Houston, TX 77002',personIds:[2,3],
    repeatUnit:'none',repeatInterval:1,repeatEndType:'never',
    repeatEndDate:null,repeatCount:null,
  })
  assert.deepEqual(source,original)
  for(const forbidden of ['id','batchId','exceptions','repeatCountFromSource']) {
    assert.equal(Object.hasOwn(draft,forbidden),false,forbidden)
  }
})

test('a recurring series duplicates only its selected occurrence', () => {
  const source = sourceEvent()
  source.date='2026-10-01'
  assert.equal(makeEventDuplicateDraft(source,'2026-12-24').date,'2026-12-24')
  assert.equal(makeEventDuplicateDraft(source,'2026-12-24').repeatUnit,'none')
})

test('multi-day duration stays the same across months and years', () => {
  const source = sourceEvent()
  source.date='2026-10-30'
  source.endDate='2026-11-02'
  const draft=makeEventDuplicateDraft(source,'2026-12-31')
  assert.equal(draft.endDate,'2027-01-03')
})

test('all-day events remain all day', () => {
  const source = sourceEvent()
  source.time=null
  source.endTime=null
  const draft=makeEventDuplicateDraft(source,'2026-11-17')
  assert.equal(draft.allDay,true)
  assert.equal(draft.time,'')
  assert.equal(draft.endTime,'')
})

test('invalid date is rejected rather than silently shifted', () => {
  assert.throws(()=>makeEventDuplicateDraft(sourceEvent(),'2026-02-30'),/Invalid calendar date/)
  assert.throws(()=>makeEventDuplicateDraft(sourceEvent(),'10\/21\/2026'),/YYYY-MM-DD/)
})
