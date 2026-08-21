/** Profile-relative package resolution for Electron's restricted Node runtime. */

import { registerHooks } from 'node:module'

const LOADER_ENTRY_URL = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')
const DESKTOP_ENTRY_URL = new URL('../lib/index.js', import.meta.url).href
const DESKTOP_PACKAGE_NAME = 'dsh-plugin-desktop'

/** Return whether a Loader request needs Node package resolution. */
function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !URL.canParse(specifier)
}

/**
 * Resolve Cordis Loader bare imports from the selected persistent profile.
 * @param profileBaseUrl - file URL inside the profile that owns plugin dependencies.
 * @returns an idempotent hook disposer.
 */
export function installProfilePackageResolver(profileBaseUrl: string): () => void {
  // Track only the module graph rooted at packages selected by this profile.
  const profileModuleUrls = new Set<string>()
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const fromLoader = context.parentURL === LOADER_ENTRY_URL
      if (fromLoader && specifier === DESKTOP_PACKAGE_NAME) {
        return { shortCircuit: true, url: DESKTOP_ENTRY_URL }
      }
      if (fromLoader && isBareSpecifier(specifier)) {
        const resolved = nextResolve(specifier, { ...context, parentURL: profileBaseUrl })
        profileModuleUrls.add(resolved.url)
        return resolved
      }
      if (context.parentURL === undefined || !profileModuleUrls.has(context.parentURL)) {
        return nextResolve(specifier, context)
      }
      if (!isBareSpecifier(specifier)) {
        const resolved = nextResolve(specifier, context)
        if (specifier.startsWith('.')) profileModuleUrls.add(resolved.url)
        return resolved
      }
      try {
        const resolved = nextResolve(specifier, context)
        profileModuleUrls.add(resolved.url)
        return resolved
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw cause
        const resolved = nextResolve(specifier, { ...context, parentURL: profileBaseUrl })
        profileModuleUrls.add(resolved.url)
        return resolved
      }
    },
  })
  let active = true
  return () => {
    if (!active) return
    active = false
    hooks.deregister()
  }
}
