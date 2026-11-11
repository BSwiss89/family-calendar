export function toggleCalendarPersonFilterIds(
  selectedPersonIds: readonly number[],
  personId: number,
): number[] {
  return selectedPersonIds.includes(personId)
    ? selectedPersonIds.filter((selectedId) => selectedId !== personId)
    : [...selectedPersonIds, personId]
}

export function eventMatchesCalendarPersonFilter(
  eventPersonIds: readonly number[],
  selectedPersonIds: readonly number[],
): boolean {
  return (
    selectedPersonIds.length === 0 ||
    eventPersonIds.some((personId) => selectedPersonIds.includes(personId))
  )
}
