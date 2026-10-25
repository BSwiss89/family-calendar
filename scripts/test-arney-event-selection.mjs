import test from 'node:test'
import assert from 'node:assert/strict'
import { selectionPreviewRequest } from '../src/arneyEventSelection.mjs'
test('only an exact supported candidate can receive a server-preview request', () => {
  const decision = {
    status:'needs_selection',readOnly:true,requiresSelection:true,
    action:'reschedule', options:[
      { eventId:1,supported:true }, { eventId:2,supported:false },
    ],
    previewRequest:{action:'reschedule',newDate:'2026-12-22',newTime:'14:30'},
  }
  assert.deepEqual(selectionPreviewRequest(decision,1),{
    action:'reschedule',eventId:1,newDate:'2026-12-22',newTime:'14:30',
  })
  for(const id of [2,3,0,-1,'1',undefined]) {
    assert.equal(selectionPreviewRequest(decision,id),null)
  }
  assert.equal(selectionPreviewRequest({...decision, status:'ready_for_confirmation'},1),null)
  assert.equal(selectionPreviewRequest({...decision, readOnly:false},1),null)
  assert.equal(selectionPreviewRequest({...decision, options:[...decision.options,{eventId:1,supported:true}]},1),null)
  assert.equal(selectionPreviewRequest({...decision, previewRequest:{action:'cancel'}},1),null)
})
test('cancellation preview cannot smuggle rescheduling fields',()=>{
  const decision={status:'needs_selection',readOnly:true,requiresSelection:true,
    action:'cancel',options:[{eventId:9,supported:true}],
    previewRequest:{action:'cancel',newDate:'2027-01-01',newTime:'12:00'}}
  assert.deepEqual(selectionPreviewRequest(decision,9),{action:'cancel',eventId:9})
})
