export type HouseholdProfileSelection =
  | { kind: 'home' }
  | { kind: 'person'; personId: number }
export type ProfilePerson = { id: number }
export const HOME_SELECTION: 'home'
export function profileStorageKey(username: unknown, householdId?: unknown): string | null
export function parseProfileSelection(raw: unknown): HouseholdProfileSelection | null
export function serializeProfileSelection(selection: HouseholdProfileSelection | null): string | null
export function resolveProfileSelection(
  raw: string | null, people: readonly ProfilePerson[], defaultHome?: boolean,
): HouseholdProfileSelection | null
