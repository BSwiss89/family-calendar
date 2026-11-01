import test from 'node:test'
import assert from 'node:assert/strict'
import {isPrivateArneyEventCandidate} from '../src/arneyPrivateEventCandidate.mjs'
test('private signed-preview candidate requires an explicit event-change verb',()=>{
  for(const phrase of [
    'Hey Calendar, cancel event "Dentist" on 2026-12-20',
    'Calendar, please reschedule dentist', 'Arnie, move event "Dentist" on 2026-12-20 to 2026-12-21',
    'Computer, delete event "Dentist" on 2026-12-20', 'remove event "Dentist" on 2026-12-20',
  ]) assert.equal(isPrivateArneyEventCandidate(phrase),true,phrase)
  for(const phrase of [
    'What is on my calendar today?', 'Add milk to Groceries',
    'Schedule dentist tomorrow', 'calendarize this',
    'I want to cancel everything', '', 4, 'a'.repeat(501),
  ]) assert.equal(isPrivateArneyEventCandidate(phrase),false,String(phrase))
})
