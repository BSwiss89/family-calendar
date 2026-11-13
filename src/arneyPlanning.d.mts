export type ArneyPlannerAnswer = { kind: 'information'; text: string }

export declare function planArneyReadOnlyRequest<
  TEvent extends {
    id: number
    title: string
    time?: string | null
    endTime?: string | null
    people?: Array<{ id: number; name: string }>
  },
>(
  text: string,
  context: {
    now: Date
    events: TEvent[]
    recipes: Array<{ name: string; favorite?: boolean }>
    mealPlanItems: Array<{ date: string; mealType: string; title: string }>
    activePersonId: number | null
    occurrenceStartForDate: (event: TEvent, date: string) => string | null
  },
): ArneyPlannerAnswer | null
