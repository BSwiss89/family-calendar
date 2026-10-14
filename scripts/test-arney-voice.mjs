import test from 'node:test'
import assert from 'node:assert/strict'
import { extractArneyWakeCommand, shouldOfferArneyTextFallback } from '../src/arneyWakePhrase.ts'

test('wake words accept the three requested phrases', () => {
  assert.equal(extractArneyWakeCommand('Hey Arney, what is tomorrow?'), 'what is tomorrow?')
  assert.equal(extractArneyWakeCommand('arney'), '')
  assert.equal(extractArneyWakeCommand('Computer, cancel my meeting'), 'cancel my meeting')
})
test('wake words do not trigger on incidental mentions', () => {
  assert.equal(extractArneyWakeCommand('I met Arney yesterday'), null)
  assert.equal(extractArneyWakeCommand('computerize this'), null)
  assert.equal(extractArneyWakeCommand('hey Barney'), null)
})
test('text fallback appears on the third failure', () => {
  assert.equal(shouldOfferArneyTextFallback(0), false)
  assert.equal(shouldOfferArneyTextFallback(2), false)
  assert.equal(shouldOfferArneyTextFallback(3), true)
})
