/* Family Calendar informational push worker.
 * No action buttons or automatic RSVP. Never caches authenticated calendar data.
 * The push payload is encrypted by the application server. */
self.addEventListener('push', event => {
  let info = null
  try { info = event.data ? event.data.json() : null } catch { /* fallback below */ }
  const allowed = new Set([
    'An event involving you was added. Open your calendar to review it.',
    'An event involving you was updated. Open your calendar for details.',
    'An event assignment changed. Open your calendar for details.',
    'An event involving you was cancelled. Open your calendar for details.',
  ])
  const body = allowed.has(info?.body)
    ? info.body : 'You have a calendar update. Open Family Calendar to review it.'
  event.waitUntil(self.registration.showNotification('Family Calendar', {
    body, icon:'/calendar-icon-192.png', badge:'/calendar-icon-192.png',
    tag:(typeof info?.tag === 'string' && /^family-event-[1-9][0-9]*$/.test(info.tag))
      ? info.tag : 'family-event-update',
    data:{url:'/'},
  }))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  event.waitUntil((async()=>{
    const url = new URL('/', self.location.origin).href
    const windows = await self.clients.matchAll({type:'window',includeUncontrolled:true})
    const existing = windows.find(client => {
      try { return new URL(client.url).origin === self.location.origin } catch { return false }
    })
    if (existing) {
      await existing.focus()
      if ('navigate' in existing) await existing.navigate(url)
    } else {
      await self.clients.openWindow(url)
    }
  })())
})
