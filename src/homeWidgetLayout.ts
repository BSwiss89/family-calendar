export const HOME_WIDGET_IDS = [
  'weather',
  'today',
  'upcoming',
  'notes',
  'meals',
  'lists',
] as const

export type HomeWidgetId = (typeof HOME_WIDGET_IDS)[number]
export type HomeWidgetSize = 'small' | 'medium' | 'large'

export type HomeWidgetLayout = {
  order: HomeWidgetId[]
  sizes: Record<HomeWidgetId, HomeWidgetSize>
}

const STORAGE_KEY = 'family-calendar-home-widget-layout-v1'
const DEFAULT_SIZES: Record<HomeWidgetId, HomeWidgetSize> = {
  weather: 'medium',
  today: 'medium',
  upcoming: 'small',
  notes: 'medium',
  meals: 'medium',
  lists: 'large',
}

export function normalizeHomeWidgetLayout(value: unknown): HomeWidgetLayout {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const proposedOrder = source.order
  const order = Array.isArray(proposedOrder) &&
    proposedOrder.length === HOME_WIDGET_IDS.length &&
    HOME_WIDGET_IDS.every((id) => proposedOrder.includes(id)) &&
    new Set(proposedOrder).size === HOME_WIDGET_IDS.length
      ? proposedOrder as HomeWidgetId[]
      : [...HOME_WIDGET_IDS]
  const storedSizes = source.sizes && typeof source.sizes === 'object' && !Array.isArray(source.sizes)
    ? source.sizes as Record<string, unknown>
    : {}

  const sizes = { ...DEFAULT_SIZES }
  for (const id of HOME_WIDGET_IDS) {
    const size = storedSizes[id]
    if (size === 'small' || size === 'medium' || size === 'large') {
      sizes[id] = size
    }
  }
  return { order: [...order], sizes }
}

export function readHomeWidgetLayout(): HomeWidgetLayout {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    return normalizeHomeWidgetLayout(stored ? JSON.parse(stored) : null)
  } catch {
    return normalizeHomeWidgetLayout(null)
  }
}

export function saveHomeWidgetLayout(layout: HomeWidgetLayout): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
  } catch {
    // Layout customization should remain usable when storage is unavailable.
  }
}
