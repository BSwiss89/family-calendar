import type { SVGProps } from 'react'

// Same identifiers as the backend's allowlist. These are local SVG icons,
// not downloaded images, emoji fonts or paid icon service resources.
export const LIST_ICON_OPTIONS = [
  { id: 'shopping-cart', label: 'Shopping', tone: '#2879ed' },
  { id: 'garage', label: 'Garage', tone: '#32a85d' },
  { id: 'briefcase', label: 'Work', tone: '#8c42d1' },
  { id: 'checklist', label: 'Checklist', tone: '#f58b3b' },
  { id: 'star', label: 'Favorites', tone: '#e9a825' },
  { id: 'balloons', label: 'Balloons', tone: '#e65b91' },
  { id: 'paw-print', label: 'Pets', tone: '#e86465' },
  { id: 'plane', label: 'Travel', tone: '#399ac6' },
  { id: 'gift', label: 'Gifts', tone: '#e7639a' },
  { id: 'wrench', label: 'Tools', tone: '#78838b' },
  { id: 'calendar', label: 'Plans', tone: '#448fea' },
  { id: 'folder', label: 'Folder', tone: '#7264db' },
  { id: 'utensils', label: 'Food', tone: '#ee9653' },
  { id: 'car', label: 'Car', tone: '#e49b36' },
  { id: 'gamepad', label: 'Games', tone: '#7783bb' },
  { id: 'graduation-cap', label: 'School', tone: '#657ac9' },
  { id: 'package', label: 'Packages', tone: '#bb8548' },
  { id: 'file-text', label: 'Documents', tone: '#628fd5' },
  { id: 'pill', label: 'Health', tone: '#e17977' },
  { id: 'shirt', label: 'Clothes', tone: '#cb68a4' },
  { id: 'book', label: 'Books', tone: '#7a8a56' },
  { id: 'music', label: 'Music', tone: '#bf74cd' },
  { id: 'camera', label: 'Photos', tone: '#7499ae' },
  { id: 'plant', label: 'Garden', tone: '#45a17a' },
] as const

export type ListIconId = (typeof LIST_ICON_OPTIONS)[number]['id']

export function getListIconOption(value: string | null | undefined) {
  return LIST_ICON_OPTIONS.find(option => option.id === value) ?? null
}

export function ListIcon({ id, ...props }: SVGProps<SVGSVGElement> & { id: string | null | undefined }) {
  let drawing
  switch (id) {
    case 'shopping-cart':
      drawing = <><circle cx="9" cy="20" r="1"/><circle cx="19" cy="20" r="1"/><path d="M2 3h2l2.6 12.2a2 2 0 0 0 2 1.6H20l2-10H5"/></>
      break
    case 'garage':
      drawing = <><path d="m2 11 10-8 10 8M4 10v11h16V10"/><path d="M7 21v-7h10v7M7.5 18h9M9 14l1-2h4l1 2"/></>
      break
    case 'briefcase':
      drawing = <><rect x="3" y="7" width="18" height="14" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12l9 3 9-3M12 14v3"/></>
      break
    case 'checklist':
      drawing = <><path d="m3 5 2 2 4-4M12 5h9M3 13l2 2 4-4M12 13h9M3 21l2 2 4-4M12 21h9"/></>
      break
    case 'star':
      drawing = <path d="m12 2 3.3 6.8 7.5 1.1-5.4 5.3 1.3 7.4-6.7-3.5-6.7 3.5 1.3-7.4L1.2 9.9l7.5-1.1Z"/>
      break
    case 'balloons':
      drawing = <><ellipse cx="8" cy="8" rx="5" ry="7"/><ellipse cx="17" cy="9" rx="4" ry="6"/><path d="m7 15 1 2-1 2m10-4-1 2 2 2M8 17q4 3 1 6M16 17q-4 3-2 6"/></>
      break
    case 'paw-print':
      drawing = <><path d="M5 16c-2 4 0 6 3 5l4-2 4 2c4 1 5-2 3-5l-4-4a5 5 0 0 0-6 0z"/><ellipse cx="4" cy="10" rx="1.3" ry="2"/><ellipse cx="9" cy="6" rx="1.3" ry="2"/><ellipse cx="16" cy="6" rx="1.3" ry="2"/><ellipse cx="21" cy="10" rx="1.3" ry="2"/></>
      break
    case 'plane':
      drawing = <path d="M22 2 2 10l8 3 3 9 9-20ZM10 13l12-11"/>
      break
    case 'gift':
      drawing = <><rect x="3" y="10" width="18" height="12" rx="1"/><path d="M2 7h20v4H2zM12 7v15"/><path d="M12 7C7-1 2 5 7 7Zm0 0c5-8 10-2 5 0z"/></>
      break
    case 'wrench':
      drawing = <><path d="M14 6a6 6 0 0 0-8 8L2 18a3 3 0 0 0 4 4l4-4a6 6 0 0 0 8-8l-4 4-4-4z"/></>
      break
    case 'calendar':
      drawing = <><rect x="3" y="5" width="18" height="17" rx="2"/><path d="M7 2v6M17 2v6M3 10h18M8 15h3M15 15h1M8 19h3"/></>
      break
    case 'folder':
      drawing = <path d="M2 6a2 2 0 0 1 2-2h6l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z"/>
      break
    case 'utensils':
      drawing = <path d="M3 2v9a4 4 0 0 0 8 0V2M7 2v20M16 2c4 0 5 5 5 10h-5v10M16 2v10"/>
      break
    case 'car':
      drawing = <><path d="m5 16-1 3v2h3v-2h10v2h3v-2l-1-3-2-8H7zM3 16h18M7 8l2-4h6l2 4M7 16h2M15 16h2"/></>
      break
    case 'gamepad':
      drawing = <><path d="M6 7h12a4 4 0 0 1 4 3l1 7c0 5-4 5-7 1H8c-3 4-7 4-7-1l1-7a4 4 0 0 1 4-3z"/><path d="M7 11v6M4 14h6M17 12h.1M20 15h.1"/></>
      break
    case 'graduation-cap':
      drawing = <><path d="m2 9 10-5 10 5-10 5zM6 12v6q6 4 12 0v-6M22 9v9"/></>
      break
    case 'package':
      drawing = <><path d="m12 2 10 5v11l-10 5-10-5V7zM2 7l10 5 10-5M12 12v11M7 4.5l10 5"/></>
      break
    case 'file-text':
      drawing = <><path d="M6 2h8l5 5v15H6zM14 2v6h5M9 12h7M9 16h7M9 20h5"/></>
      break
    case 'pill':
      drawing = <><rect x="3" y="3" width="18" height="18" rx="9" transform="rotate(45 12 12)"/><path d="m7 17 10-10"/></>
      break
    case 'shirt':
      drawing = <path d="m8 3 4 2 4-2 6 4-3 6-3-2v11H8V11l-3 2-3-6z"/>
      break
    case 'book':
      drawing = <><path d="M12 6q-5-4-10-2v15q5-2 10 2 5-4 10-2V4q-5-2-10 2zM12 6v15"/></>
      break
    case 'music':
      drawing = <><path d="M9 17V4l12-2v13M9 9l12-2"/><ellipse cx="6" cy="19" rx="3" ry="2"/><ellipse cx="18" cy="17" rx="3" ry="2"/></>
      break
    case 'camera':
      drawing = <><rect x="2" y="6" width="20" height="15" rx="2"/><circle cx="12" cy="13" r="4"/><path d="m7 6 2-3h6l2 3"/></>
      break
    case 'plant':
      drawing = <><path d="M12 22V11M12 15C7 15 4 12 4 7c5 0 8 3 8 8M12 11c0-5 3-8 8-8 0 5-3 8-8 8M7 22h10"/></>
      break
    default:
      drawing = <><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M7 10h10M7 15h7"/></>
  }
  return <svg {...props} viewBox="0 0 24 24" width={props.width ?? 24} height={props.height ?? 24}
    fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true">{drawing}</svg>
}
