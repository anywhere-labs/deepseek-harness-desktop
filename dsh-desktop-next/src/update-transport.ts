/** Follow HTTPS artifact redirects without forwarding release telemetry to storage. */
import { assertSecureDownloadUrl, type UpdateArtifactRequest } from '../../dsh-plugin-desktop-beta/src/update-download.ts'
import type { UpdateRequest } from '../../dsh-plugin-desktop-beta/src/update-checker.ts'

export function artifactRequest(request: UpdateRequest): UpdateArtifactRequest {
  return async (url, init) => {
    let target = url
    for (let count = 0; count < 8; count++) {
      assertSecureDownloadUrl(target)
      const response = await request(target, { ...init, redirect: 'manual', credentials: 'omit',
        headers: count === 0 ? init.headers : { Accept: 'application/octet-stream' } })
      if (![301, 302, 303, 307, 308].includes(response.status)) return { response, finalUrl: target }
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location) throw new Error('Update redirect has no location')
      target = new URL(location, target).href
    }
    throw new Error('Too many update redirects')
  }
}
