export type ArneyVoiceResponseMode = 'always' | 'needed' | 'silent'

export type ArneyPreferences = {
  responseMode: ArneyVoiceResponseMode
  wakeWordsEnabled: boolean
  confirmBeforeChanges: boolean
}

export const ARNEY_PREFERENCES_KEY = 'family-calendar:arney-preferences:v1'

export const DEFAULT_ARNEY_PREFERENCES: ArneyPreferences = {
  responseMode: 'always',
  wakeWordsEnabled: false,
  confirmBeforeChanges: true,
}

const validResponseModes = new Set<ArneyVoiceResponseMode>([
  'always',
  'needed',
  'silent',
])

export function normalizeArneyPreferences(value: unknown): ArneyPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_ARNEY_PREFERENCES }
  }

  const input = value as Record<string, unknown>
  return {
    responseMode:
      typeof input.responseMode === 'string' &&
      validResponseModes.has(input.responseMode as ArneyVoiceResponseMode)
        ? (input.responseMode as ArneyVoiceResponseMode)
        : DEFAULT_ARNEY_PREFERENCES.responseMode,
    wakeWordsEnabled:
      typeof input.wakeWordsEnabled === 'boolean'
        ? input.wakeWordsEnabled
        : DEFAULT_ARNEY_PREFERENCES.wakeWordsEnabled,
    confirmBeforeChanges:
      typeof input.confirmBeforeChanges === 'boolean'
        ? input.confirmBeforeChanges
        : DEFAULT_ARNEY_PREFERENCES.confirmBeforeChanges,
  }
}

export function readArneyPreferences(): ArneyPreferences {
  if (typeof window === 'undefined') return { ...DEFAULT_ARNEY_PREFERENCES }
  try {
    const raw = window.localStorage.getItem(ARNEY_PREFERENCES_KEY)
    return raw ? normalizeArneyPreferences(JSON.parse(raw) as unknown) : { ...DEFAULT_ARNEY_PREFERENCES }
  } catch {
    return { ...DEFAULT_ARNEY_PREFERENCES }
  }
}

export function saveArneyPreferences(value: ArneyPreferences): boolean {
  if (typeof window === 'undefined') return false
  try {
    window.localStorage.setItem(
      ARNEY_PREFERENCES_KEY,
      JSON.stringify(normalizeArneyPreferences(value)),
    )
    return true
  } catch {
    return false
  }
}
