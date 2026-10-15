import { isCalendarDateKey } from './sharedEventOverlay.ts'

export type TrustedShareRecipient = {
  householdId: string
  displayName: string
}

export type IncomingEventInvitation = {
  shareId: number
  sharedBy: string
  title: string
  date: string
  time: string | null
}

export type OutgoingEventInvitation = {
  shareId: number
  sourceEventId: number
  recipientHouseholdId: string
  recipientDisplayName: string
  title: string
  date: string
  time: string | null
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'cancelled'
}

type DataRow = Record<string, unknown>

function record(value: unknown): value is DataRow {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function limitedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const clean = value.trim()
  return clean.length > 0 && clean.length <= max ? clean : null
}

function validIdentifier(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function validHouseholdId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(value)
}

function limitedTime(value: unknown): string | null | undefined {
  if (value == null) return null
  return typeof value === 'string' &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : undefined
}

export function parseTrustedShareRecipients(payload: unknown): TrustedShareRecipient[] {
  if (!record(payload) || !Array.isArray(payload.recipients)) return []
  const result: TrustedShareRecipient[] = []
  const seen = new Set<string>()
  for (const raw of payload.recipients) {
    if (!record(raw) || !validHouseholdId(raw.householdId) ||
      seen.has(raw.householdId)) continue
    const name = limitedText(raw.displayName, 90)
    if (!name) continue
    seen.add(raw.householdId)
    result.push({ householdId: raw.householdId, displayName: name })
    if (result.length >= 100) break
  }
  return result.sort((a, b) => a.displayName.localeCompare(b.displayName))
}

export function parseIncomingInvitations(payload: unknown): IncomingEventInvitation[] {
  if (!record(payload) || !Array.isArray(payload.invitations)) return []
  const result: IncomingEventInvitation[] = []
  const seen = new Set<number>()
  for (const raw of payload.invitations) {
    if (!record(raw) || !validIdentifier(raw.shareId) ||
      seen.has(raw.shareId) || !isCalendarDateKey(raw.date)) continue
    const title = limitedText(raw.title, 250)
    const sharedBy = limitedText(raw.sharedBy, 100)
    const time = limitedTime(raw.time)
    if (!title || !sharedBy || time === undefined) continue
    seen.add(raw.shareId)
    result.push({ shareId: raw.shareId, title, sharedBy, date: raw.date, time })
    if (result.length >= 250) break
  }
  return result.sort((a, b) =>
    a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') ||
    a.shareId - b.shareId)
}

export function parseOutgoingInvitations(payload: unknown): OutgoingEventInvitation[] {
  if (!record(payload) || !Array.isArray(payload.shares)) return []
  const result: OutgoingEventInvitation[] = []
  const seen = new Set<number>()
  for (const raw of payload.shares) {
    if (!record(raw) || !validIdentifier(raw.shareId) ||
      seen.has(raw.shareId) || !validIdentifier(raw.sourceEventId) ||
      !validHouseholdId(raw.recipientHouseholdId) ||
      !isCalendarDateKey(raw.date) ||
      !['accepted', 'pending', 'declined', 'revoked', 'cancelled'].includes(raw.status as string)) continue
    const title = limitedText(raw.title, 250)
    const recipientDisplayName = limitedText(raw.recipientDisplayName, 90)
    const time = limitedTime(raw.time)
    if (!title || !recipientDisplayName || time === undefined) continue
    seen.add(raw.shareId)
    result.push({
      shareId: raw.shareId,
      sourceEventId: raw.sourceEventId,
      recipientHouseholdId: raw.recipientHouseholdId,
      recipientDisplayName,
      title,
      date: raw.date,
      time,
      status: raw.status as OutgoingEventInvitation['status'],
    })
    if (result.length >= 250) break
  }
  return result.sort((a, b) =>
    a.shareId - b.shareId)
}
