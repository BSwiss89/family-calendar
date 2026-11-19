/**
 * Shared, fail-closed feature configuration.
 *
 * This module has no side effects and is intentionally NOT wired into either
 * calendar. Runtime deployment/authorization remains unchanged.
 *
 * A feature flag controls optional presentation/entry points only; it must
 * never substitute for server authorization, schema isolation, or backups.
 */
export const OPTIONAL_FEATURES = Object.freeze({
  socialVideoRecipeImport: 'socialVideoRecipeImport',
  householdSharingPreview: 'householdSharingPreview',
  addEventPersonLabels: 'addEventPersonLabels',
})

const DEFAULTS = Object.freeze({
  [OPTIONAL_FEATURES.socialVideoRecipeImport]: false,
  [OPTIONAL_FEATURES.householdSharingPreview]: false,
  [OPTIONAL_FEATURES.addEventPersonLabels]: false,
})

/**
 * Only explicit booleans are accepted. Unknown features and malformed
 * configurations fail closed. Environment names alone never enable features.
 */
export function isOptionalFeatureEnabled(feature, overrides = undefined) {
  if (!Object.hasOwn(DEFAULTS, feature)) return false
  if (overrides == null) return DEFAULTS[feature]
  if (typeof overrides !== 'object' || Array.isArray(overrides)) return false
  return overrides[feature] === true
}

/** Return a fresh, frozen resolved snapshot; unknown keys are ignored. */
export function resolveOptionalFeatures(overrides = undefined) {
  const result = {}
  for (const feature of Object.values(OPTIONAL_FEATURES)) {
    result[feature] = isOptionalFeatureEnabled(feature, overrides)
  }
  return Object.freeze(result)
}
