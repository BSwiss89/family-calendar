export type EmojiMarkerData = {
  id: number
  date: string
  emoji: string
  label: string
  repeatUnit: 'day' | 'week' | 'month' | 'year' | null
  repeatInterval: number | null
  repeatWeekdays: number[] | null
  repeatMonthPattern: 'date' | 'nth-weekday' | 'last-weekday' | null
  repeatEndType: 'never' | 'date' | 'count' | null
  repeatEndDate: string | null
  repeatCount: number | null
  exceptions: string[]
}
export function validEmojiDate(value: unknown): boolean
export function normalizeEmojiMarkerPayload(body: unknown): Omit<EmojiMarkerData, 'id' | 'exceptions'> | null
export function emojiMarkerOccursOnDate(marker: EmojiMarkerData, dateKey: string): boolean
export function previousEmojiDate(dateKey: string): string | null
