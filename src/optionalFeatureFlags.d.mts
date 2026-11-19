export declare const OPTIONAL_FEATURES: Readonly<{
  socialVideoRecipeImport: 'socialVideoRecipeImport'
  householdSharingPreview: 'householdSharingPreview'
  addEventPersonLabels: 'addEventPersonLabels'
}>
export type OptionalFeatureName = keyof typeof OPTIONAL_FEATURES
export type OptionalFeatureConfiguration = Readonly<Record<OptionalFeatureName, boolean>>
export declare function isOptionalFeatureEnabled(feature: string, overrides?: unknown): boolean
export declare function resolveOptionalFeatures(overrides?: unknown): OptionalFeatureConfiguration
export declare function resolveDeploymentOptionalFeatures(deployment: unknown, overrides?: unknown): OptionalFeatureConfiguration
