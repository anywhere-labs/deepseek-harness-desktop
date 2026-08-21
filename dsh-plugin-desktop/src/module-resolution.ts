/** Profile-relative package resolution for Electron's restricted Node runtime. */

import Module, { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { unpackedAsarPath } from './packaged-runtime-path.ts'
import {
  findOverlayPackage,
  packageNameFromSpecifier,
  resolveOverlayPackage,
} from './package-overlay.ts'

const LOADER_ENTRY_URL = import.meta.resolve('@deepseek-ai/cordis-plugin-loader')
const DESKTOP_ENTRY_URL = pathToFileURL(
  unpackedAsarPath(fileURLToPath(new URL('../lib/index.js', import.meta.url))),
).href
const DESKTOP_PACKAGE_URL = pathToFileURL(
  unpackedAsarPath(fileURLToPath(new URL('../package.json', import.meta.url))),
).href

interface CommonJsModuleResolver {
  _resolveFilename(
    request: string,
    parent: { filename?: string } | null | undefined,
    isMain: boolean | undefined,
    options?: unknown,
  ): string
}

function packageNameFromManifestSpecifier(specifier: string): string | undefined {
  const suffix = '/package.json'
  if (!specifier.endsWith(suffix)) return undefined
  const packageName = specifier.slice(0, -suffix.length)
  return packageNameFromSpecifier(packageName) === packageName ? packageName : undefined
}

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
  const profileManifestPath = fileURLToPath(profileBaseUrl)

  // ClientModuleRegistry intentionally uses createRequire(ctx.baseUrl) to
  // resolve each browser bundle from the config tree. Node's ESM resolve hook
  // does not observe that CommonJS manifest lookup, so without this narrow
  // bridge the Loader can activate the Desktop copy while the browser receives
  // an older Profile copy of the same package. Intercept only exact package
  // manifests requested from this Profile anchor; every other CJS resolution
  // remains untouched.
  const commonJsModule = Module as unknown as CommonJsModuleResolver
  const previousResolveFilename = commonJsModule._resolveFilename
  const overlayResolveFilename: CommonJsModuleResolver['_resolveFilename'] = function (
    this: CommonJsModuleResolver,
    request,
    parent,
    isMain,
    options,
  ) {
    const packageName = parent?.filename === profileManifestPath
      ? packageNameFromManifestSpecifier(request)
      : undefined
    if (packageName !== undefined) {
      const overlay = findOverlayPackage(packageName, {
        installPackageUrl: DESKTOP_PACKAGE_URL,
        profilePackageUrl: profileBaseUrl,
      })
      if (overlay !== undefined) return overlay.selected.manifestPath
    }
    return previousResolveFilename.call(this, request, parent, isMain, options)
  }
  commonJsModule._resolveFilename = overlayResolveFilename

  // Track the module graph rooted at every overlay-selected Loader package.
  const overlayModuleUrls = new Set<string>()
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const fromLoader = context.parentURL === LOADER_ENTRY_URL
      const packageName = fromLoader ? packageNameFromSpecifier(specifier) : undefined
      if (packageName !== undefined) {
        const overlay = resolveOverlayPackage(packageName, {
          installPackageUrl: DESKTOP_PACKAGE_URL,
          profilePackageUrl: profileBaseUrl,
        })
        const resolved = nextResolve(specifier, {
          ...context,
          parentURL: overlay.selected.source === 'profile' ? profileBaseUrl : DESKTOP_ENTRY_URL,
        })
        overlayModuleUrls.add(resolved.url)
        return resolved
      }
      if (context.parentURL === undefined || !overlayModuleUrls.has(context.parentURL)) {
        return nextResolve(specifier, context)
      }
      if (!isBareSpecifier(specifier)) {
        const resolved = nextResolve(specifier, context)
        if (specifier.startsWith('.')) overlayModuleUrls.add(resolved.url)
        return resolved
      }
      try {
        const resolved = nextResolve(specifier, context)
        overlayModuleUrls.add(resolved.url)
        return resolved
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw cause
        const resolved = nextResolve(specifier, { ...context, parentURL: profileBaseUrl })
        overlayModuleUrls.add(resolved.url)
        return resolved
      }
    },
  })
  let active = true
  return () => {
    if (!active) return
    active = false
    hooks.deregister()
    if (commonJsModule._resolveFilename === overlayResolveFilename) {
      commonJsModule._resolveFilename = previousResolveFilename
    }
  }
}
