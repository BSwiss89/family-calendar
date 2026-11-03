import { useState } from 'react'

type Props = { initial: string; color: string; image: string | null }

/** The letter stays visible beside the optional photo inside the filter pill. */
export default function CalendarPersonFilterAvatar({ initial, color, image }: Props) {
  const [imageFailed, setImageFailed] = useState(false)
  const showPhoto = Boolean(image) && !imageFailed
  return (
    <span className={`calendar-mobile-avatar-face${showPhoto ? ' calendar-mobile-avatar-face-with-photo' : ''}`}
      style={{ background: color }}>
      {initial}
      {showPhoto && <img className="calendar-mobile-avatar-photo"
        src={'/uploads/' + encodeURIComponent(image!)} alt=""
        onError={() => setImageFailed(true)} />}
    </span>
  )
}
