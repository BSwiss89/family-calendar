import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import './FamilyAccountEntry.css'

/** A device-management link, shown only when family authentication is enabled. */
export default function FamilyAccountEntry() {
  const [enabled, setEnabled] = useState(false)
  const [sidebar, setSidebar] = useState<Element | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetch('/api/auth/status', { cache: 'no-store', signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(status => { if (status?.enabled) setEnabled(true) })
      .catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (!enabled) return
    const find = () => {
      const next = document.querySelector('.app-sidebar')
      setSidebar(current => current === next ? current : next)
    }
    find()
    const observer = new MutationObserver(find)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [enabled])

  if (!enabled) return null

  return (
    <>
      {sidebar && createPortal(
        <a href="/account" className="sidebar-nav-button family-account-nav">
          <span aria-hidden="true">🔐</span> Family account
        </a>,
        sidebar,
      )}
      {createPortal(
        <a href="/account" className="family-account-mobile" aria-label="Family account and trusted devices">🔐</a>,
        document.body,
      )}
    </>
  )
}
