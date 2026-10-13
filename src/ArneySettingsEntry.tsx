import { useEffect, useState } from 'react'
import ArneySettings from './ArneySettings'
import './ArneySettingsEntry.css'

export default function ArneySettingsEntry() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  return (
    <>
      <button
        className="arney-settings-trigger"
        type="button"
        aria-label="Open Arney voice settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true">⚙</span> Arney
      </button>
      {open && (
        <div className="arney-settings-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false)
        }}>
          <div className="arney-settings-dialog" role="dialog" aria-modal="true" aria-label="Arney voice settings">
            <button className="arney-settings-close" type="button" aria-label="Close Arney settings" onClick={() => setOpen(false)}>✕</button>
            <ArneySettings />
          </div>
        </div>
      )}
    </>
  )
}
