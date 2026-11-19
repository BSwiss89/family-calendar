import assert from 'node:assert/strict'
import test from 'node:test'
import { OPTIONAL_FEATURES, isOptionalFeatureEnabled, resolveOptionalFeatures, resolveDeploymentOptionalFeatures } from './optionalFeatureFlags.mjs'

test('all optional features default off', () => {
  for (const feature of Object.values(OPTIONAL_FEATURES)) {
    assert.equal(isOptionalFeatureEnabled(feature), false)
  }
})

test('explicit true enables only the selected feature', () => {
  const flags = resolveOptionalFeatures({ addEventPersonLabels: true })
  assert.equal(flags.addEventPersonLabels, true)
  assert.equal(flags.socialVideoRecipeImport, false)
  assert.equal(flags.householdSharingPreview, false)
})

test('malformed overrides and unknown names fail closed', () => {
  for (const value of [null, false, 'true', 1, [], { addEventPersonLabels: 'true' }, { addEventPersonLabels: 1 }]) {
    assert.equal(isOptionalFeatureEnabled('addEventPersonLabels', value), false)
  }
  assert.equal(isOptionalFeatureEnabled('unknown', { unknown: true }), false)
  assert.equal(isOptionalFeatureEnabled('__proto__', { __proto__: true }), false)
})

test('resolved feature snapshot is immutable and excludes unknown keys', () => {
  const flags = resolveOptionalFeatures({ addEventPersonLabels: true, unknown: true })
  assert.equal(Object.isFrozen(flags), true)
  assert.deepEqual(Object.keys(flags).sort(), Object.values(OPTIONAL_FEATURES).sort())
  assert.equal('unknown' in flags, false)
})

test('LIVE and unknown deployments refuse optional features even when requested', () => {
  for (const deployment of ['live', 'production', '', null, undefined, 'TEST']) {
    const flags = resolveDeploymentOptionalFeatures(deployment, {
      socialVideoRecipeImport: true,
      householdSharingPreview: true,
      addEventPersonLabels: true,
    })
    assert.equal(Object.values(flags).every(value => value === false), true)
  }
})

test('TEST only enables features explicitly opted in', () => {
  const flags = resolveDeploymentOptionalFeatures('test', {
    addEventPersonLabels: true,
    householdSharingPreview: 'true',
  })
  assert.equal(flags.addEventPersonLabels, true)
  assert.equal(flags.householdSharingPreview, false)
  assert.equal(flags.socialVideoRecipeImport, false)
  assert.equal(Object.isFrozen(flags), true)
})

test('TEST with no overrides remains fully disabled', () => {
  assert.equal(Object.values(resolveDeploymentOptionalFeatures('test')).every(value => value === false), true)
})
