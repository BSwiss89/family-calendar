export const CURRENT_RELEASE: Readonly<{
  id: string
  title: string
  intro: string
  highlights: readonly string[]
}>
export function releaseAcknowledgementKey(
  accountKey: string | null,
  personId: number | null,
  releaseId?: string,
): string | null
export function isReleaseAcknowledged(
  store: Pick<Storage, 'getItem'>,
  key: string | null,
): boolean
export function acknowledgeRelease(
  store: Pick<Storage, 'setItem'>,
  key: string | null,
): boolean
