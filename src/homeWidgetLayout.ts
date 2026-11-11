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
export type HomeWidgetWidth = 'half' | 'full'

export type HomeWidgetLayout = {
  order: HomeWidgetId[]
  sizes: Record<HomeWidgetId, HomeWidgetSize>
  widths: Record<HomeWidgetId, HomeWidgetWidth>
}

const STORAGE_KEY = 'family-calendar-home-widget-layout-v2'
const LEGACY_STORAGE_KEY = 'family-calendar-home-widget-layout-v1'
const DEFAULT_SIZES: Record<HomeWidgetId, HomeWidgetSize> = {
  weather: 'medium',
  today: 'medium',
  upcoming: 'small',
  notes: 'medium',
  meals: 'medium',
  lists: 'large',
}

// Preserve the established initial full-width / compact Home arrangement.
// Width can now be changed independently of the vertical height.
const DEFAULT_WIDTHS: Record<HomeWidgetId, HomeWidgetWidth> = {
  weather: 'full',
  today: 'full',
  upcoming: 'half',
  notes: 'full',
  meals: 'full',
  lists: 'full',
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
  const storedWidths = source.widths && typeof source.widths === 'object' && !Array.isArray(source.widths)
    ? source.widths as Record<string, unknown>
    : {}

  const sizes = { ...DEFAULT_SIZES }
  const widths = { ...DEFAULT_WIDTHS }
  for (const id of HOME_WIDGET_IDS) {
    const size = storedSizes[id]
    if (size === 'small' || size === 'medium' || size === 'large') {
      sizes[id] = size
    }
    const width = storedWidths[id]
    if (width === 'half' || width === 'full') {
      widths[id] = width
    } else if (source.sizes && !source.widths) {
      // A v1 size controlled horizontal span; maintain its prior mobile width.
      widths[id] = sizes[id] === 'small' ? 'half' : 'full'
    }
  }
  return { order: [...order], sizes, widths }
}

export function readHomeWidgetLayout(): HomeWidgetLayout {
  try {
    const latest = window.localStorage.getItem(STORAGE_KEY)
    const legacy = latest === null
      ? window.localStorage.getItem(LEGACY_STORAGE_KEY)
      : null
    return normalizeHomeWidgetLayout(latest || legacy ? JSON.parse(latest ?? legacy ?? '') : null)
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
