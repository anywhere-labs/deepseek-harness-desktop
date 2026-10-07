/** Desktop-only large-text paste; the existing composer owns attachment lifetime. */
export const PASTED_TEXT_CHARACTER_LIMIT = 1000
export const PASTED_TEXT_LINE_LIMIT = 15

export interface PastedTextFileWindow {
  __DSH_DESKTOP_PASTED_TEXT_FILE__?: (
    text: string,
    addFiles: (files: readonly File[]) => string | null,
  ) => boolean
}

/** Count Unicode code points and logical lines without changing the original bytes. */
export function shouldAttachPastedText(text: string): boolean {
  if (!/\S/u.test(text)) return false
  let characters = 0
  let lines = 1
  let previous = ''
  for (const character of text) {
    characters++
    if (character === '\r' || (character === '\n' && previous !== '\r')) lines++
    if (characters >= PASTED_TEXT_CHARACTER_LIMIT || lines >= PASTED_TEXT_LINE_LIMIT) return true
    previous = character
  }
  return false
}

/** A File without a native path uses the same upload/card pipeline as other files. */
export function createPastedTextFile(text: string): File {
  const now = new Date()
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map(value => String(value).padStart(2, '0')).join('')
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(value => String(value).padStart(2, '0')).join('')
  return new File([text], `粘贴文本-${date}-${time}-${crypto.randomUUID().slice(0, 8)}.txt`, {
    type: 'text/plain', endings: 'transparent', lastModified: now.getTime(),
  })
}

/** Return true only after synchronous acceptance; otherwise the editor pastes normally. */
export function acceptPastedTextFile(
  text: string,
  addFiles: (files: readonly File[]) => string | null,
): boolean {
  if (!shouldAttachPastedText(text)) return false
  try {
    return addFiles([createPastedTextFile(text)]) === null
  } catch {
    return false
  }
}

/** Install a scoped optional hook consumed by the pinned conversation UI patches. */
export function installPastedTextFileBridge(page: PastedTextFileWindow = window as PastedTextFileWindow): () => void {
  const previous = page.__DSH_DESKTOP_PASTED_TEXT_FILE__
  page.__DSH_DESKTOP_PASTED_TEXT_FILE__ = acceptPastedTextFile
  return () => {
    if (page.__DSH_DESKTOP_PASTED_TEXT_FILE__ !== acceptPastedTextFile) return
    if (previous === undefined) delete page.__DSH_DESKTOP_PASTED_TEXT_FILE__
    else page.__DSH_DESKTOP_PASTED_TEXT_FILE__ = previous
  }
}
