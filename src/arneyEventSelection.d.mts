export declare function selectionPreviewRequest(
  result: {
    status: string; readOnly: boolean; requiresSelection: boolean
    action: 'cancel' | 'reschedule'
    options: Array<{eventId: number; supported: boolean}>
    previewRequest: {action: 'cancel' | 'reschedule'; newDate?: string; newTime?: string | null}
  },
  chosenId: number,
): {action:'cancel'|'reschedule';eventId:number;newDate?:string;newTime?:string|null} | null
