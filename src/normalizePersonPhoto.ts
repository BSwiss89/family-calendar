export async function normalizePersonPhoto(file: File): Promise<File> {
  const sourceUrl = URL.createObjectURL(file)

  try {
    const image = new Image()
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('The selected photo could not be decoded.'))
    })
    image.src = sourceUrl
    await loaded

    const sourceWidth = image.naturalWidth
    const sourceHeight = image.naturalHeight
    if (sourceWidth < 1 || sourceHeight < 1) {
      throw new Error('The selected photo has no usable image dimensions.')
    }

    const maxDimension = 512
    const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(sourceWidth * scale))
    canvas.height = Math.max(1, Math.round(sourceHeight * scale))

    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Photo conversion is unavailable in this browser.')
    }
    context.drawImage(image, 0, 0, canvas.width, canvas.height)

    const encode = (type: string, quality: number) =>
      new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          blob => blob ? resolve(blob) : reject(new Error('Photo conversion failed.')),
          type,
          quality,
        )
      })

    let normalized = await encode('image/webp', 0.84)
    if (normalized.type.toLowerCase() !== 'image/webp') {
      normalized = await encode('image/jpeg', 0.88)
    }

    const mimeType = normalized.type.toLowerCase()
    if (mimeType !== 'image/webp' && mimeType !== 'image/jpeg') {
      throw new Error('This browser could not convert the photo to a supported format.')
    }

    const extension = mimeType === 'image/webp' ? 'webp' : 'jpg'
    return new File([normalized], `profile-photo.${extension}`, {
      type: mimeType,
      lastModified: Date.now(),
    })
  } finally {
    URL.revokeObjectURL(sourceUrl)
  }
}
