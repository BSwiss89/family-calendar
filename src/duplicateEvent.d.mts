export type DuplicateSourceEvent = {
  date: string; endDate: string | null; title: string
  time: string | null; endTime: string | null
  notes: string | null; location: string | null
  people: Array<{id:number}>
}
export declare function makeEventDuplicateDraft(
  event: DuplicateSourceEvent, occurrenceDate: string
): {
  title:string;date:string;endDate:string|null
  time:string;endTime:string;allDay:boolean
  notes:string;location:string;personIds:number[]
  repeatUnit:'none';repeatInterval:1;repeatEndType:'never'
  repeatEndDate:null;repeatCount:null
}
