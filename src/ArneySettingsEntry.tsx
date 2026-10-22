import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import ArneySettings from './ArneySettings'
import './ArneySettingsEntry.css'

export default function ArneySettingsEntry() {
  const [open, setOpen] = useState(false)
  const [targets, setTargets] = useState<{ sidebar: Element | null }>({ sidebar: null })

  useEffect(() => {
    const updateTargets = () => {
      const sidebar = document.querySelector('.app-sidebar')
      setTargets(current =>
        current.sidebar === sidebar
          ? current
          : { sidebar },
      )
    }
    updateTargets()
    const observer = new MutationObserver(updateTargets)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open])

  // The phone entry is inside Home > Settings; retain desktop sidebar access.
  useEffect(() => {
    const openFromSettings = () => setOpen(true)
    window.addEventListener('family-calendar:open-arney-settings', openFromSettings)
    return () => window.removeEventListener('family-calendar:open-arney-settings', openFromSettings)
  }, [])

  const button = () => (
    <button
      type="button"
      className="sidebar-nav-button arney-settings-nav"
      aria-label="Open Arney voice settings"
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen(true)}
    >
      <span aria-hidden="true">⚙</span>
      <span>Arney settings</span>
    </button>
  )

  return (
    <>
      {targets.sidebar && createPortal(button(), targets.sidebar)}
      {open && createPortal(
        <div className="arney-settings-backdrop" onMouseDown={event => {
          if (event.target === event.currentTarget) setOpen(false)
        }}>
          <div className="arney-settings-dialog" role="dialog" aria-modal="true" aria-label="Arney voice settings">
            <button className="arney-settings-close" type="button" aria-label="Close Arney settings" onClick={() => setOpen(false)}>✕</button>
            <ArneySettings />
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
