import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CURRENT_RELEASE, acknowledgeRelease, isReleaseAcknowledged, releaseAcknowledgementKey } from './releaseHighlights.mjs'
import './ReleaseHighlights.css'

type Props = {
  accountKey: string | null
  personId: number | null
  suppress?: boolean
}

/**
 * A friendly, non-actionable release note. Only a deliberate "Got it" tap
 * remembers the announcement. Never changes event assignment or invitations.
 * Event notices and the profile picker have priority over this dialog.
 */
export default function ReleaseHighlights({ accountKey, personId, suppress = false }: Props) {
  const acknowledgementKey = releaseAcknowledgementKey(accountKey, personId)
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setOpen(false)
    if (!acknowledgementKey || isReleaseAcknowledged(window.localStorage, acknowledgementKey)) return
    // Give the existing invitations/assignments a chance to hydrate first.
    const timer = window.setTimeout(() => setOpen(true), 850)
    return () => window.clearTimeout(timer)
  }, [acknowledgementKey])

  const visible = open && !suppress

  useEffect(() => {
    if (!visible) return
    const previousOverflow = document.body.style.overflow
    const previousFocus = document.activeElement
    document.body.style.overflow = 'hidden'
    dialog.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false) // "Later" is not an acknowledgement.
        return
      }
      if (event.key !== 'Tab' || !dialog.current) return
      const buttons = [...dialog.current.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
      if (!buttons.length) return
      const first = buttons[0]
      const last = buttons[buttons.length - 1]
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.body.style.overflow = previousOverflow
      if (previousFocus instanceof HTMLElement) previousFocus.focus()
    }
  }, [visible])

  if (!visible) return null

  function acknowledge() {
    // Even if a private browser blocks storage, let the user proceed;
    // the notice may appear again after a new login in that browser.
    if (acknowledgementKey) acknowledgeRelease(window.localStorage, acknowledgementKey)
    setOpen(false)
  }

  return createPortal(
    <div className="release-highlights-layer">
      <div className="release-highlights-backdrop" aria-hidden="true" />
      <section className="release-highlights-dialog" role="dialog" aria-modal="true"
        aria-labelledby="release-highlights-title" aria-describedby="release-highlights-description"
        tabIndex={-1} ref={dialog}>
        <span className="release-highlights-eyebrow">Family Calendar updates</span>
        <h2 id="release-highlights-title">{CURRENT_RELEASE.title}</h2>
        <p id="release-highlights-description">{CURRENT_RELEASE.intro}</p>
        <ul className="release-highlights-list">
          {CURRENT_RELEASE.highlights.map(item => <li key={item}>{item}</li>)}
        </ul>
        <div className="release-highlights-actions">
          <button className="release-highlights-later" type="button"
            onClick={() => setOpen(false)}>Maybe later</button>
          <button className="release-highlights-acknowledge" type="button"
            onClick={acknowledge}>Got it</button>
        </div>
        <p className="release-highlights-footnote">
          You'll see this once per person on this device when a new update is announced.
        </p>
      </section>
    </div>,
    document.body,
  )
}
