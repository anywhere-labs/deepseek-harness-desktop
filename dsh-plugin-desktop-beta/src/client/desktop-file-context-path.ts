/** Compute a tree entry path relative to its file-browser root without Node path APIs. */
export function relativeTreePath(rootPath: string, targetPath: string): string | undefined {
  if (!isAbsoluteHostPath(rootPath) || !isAbsoluteHostPath(targetPath)) return undefined
  const rootWindows = isWindowsPath(rootPath)
  if (rootWindows !== isWindowsPath(targetPath)) return undefined
  const root = pathSegments(rootPath, rootWindows)
  const target = pathSegments(targetPath, rootWindows)
  if (root === undefined || target === undefined || target.length <= root.length) return undefined
  const fold = (part: string): string => rootWindows ? part.toLocaleLowerCase('en-US') : part
  if (!root.every((part, index) => fold(part) === fold(target[index] ?? ''))) return undefined
  return target.slice(root.length).join('/') || undefined
}

function isAbsoluteHostPath(path: string): boolean {
  return path.startsWith('/') || isWindowsPath(path)
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path)
    || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u.test(path)
}

function pathSegments(path: string, windows: boolean): string[] | undefined {
  const normalized = windows ? path.replace(/\\/gu, '/') : path
  const segments = normalized.split('/').filter(Boolean)
  if (segments.some(segment => segment === '.' || segment === '..')) return undefined
  return segments
}
