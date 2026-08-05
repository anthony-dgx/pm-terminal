import type { Attachment } from '../../../shared/types.js'

/**
 * Anthropic's recommended maximum long edge. A retina screenshot is far larger
 * than this and would cost a lot of tokens for no extra detail, so downscale
 * before sending.
 */
const MAX_EDGE = 1568
/** Beyond this, re-encode as JPEG rather than shipping a huge PNG. */
const PNG_BUDGET = 1_200_000

/** Strip the `data:...;base64,` prefix the API does not want. */
function rawBase64(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}

export async function fileToAttachment(file: File): Promise<Attachment | null> {
  if (!file.type.startsWith('image/')) return null

  // createImageBitmap decodes the File directly. Going via a blob: URL and an
  // <img> would be blocked by the renderer CSP, which allows only self and
  // data: for img-src, and the failure is silent.
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return null
  }

  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const w = Math.max(1, Math.round(bitmap.width * scale))
    const h = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, w, h)

    // Screenshots stay lossless unless that gets expensive.
    let mediaType = 'image/png'
    let dataUrl = canvas.toDataURL('image/png')
    if (dataUrl.length > PNG_BUDGET) {
      mediaType = 'image/jpeg'
      dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    }

    return {
      id: crypto.randomUUID(),
      name: file.name || 'pasted image',
      mediaType,
      data: rawBase64(dataUrl),
      width: w,
      height: h,
    }
  } catch {
    return null
  } finally {
    bitmap.close()
  }
}

/** Image files from a paste or drop, ignoring everything else. */
export function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const out: File[] = []
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && file.type.startsWith('image/')) out.push(file)
  }
  if (!out.length) {
    for (const file of Array.from(dt.files ?? [])) {
      if (file.type.startsWith('image/')) out.push(file)
    }
  }
  return out
}
