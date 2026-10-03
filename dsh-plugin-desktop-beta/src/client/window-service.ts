/** Generation-stable Desktop native-window geometry service. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  ADVANCED_MACOS_DRAG_REGION_HEIGHT,
  ADVANCED_WINDOWS_TITLEBAR_HEIGHT,
  MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
  WINDOWS_CAPTION_CONTROLS_WIDTH,
} from '../window-chrome.ts'
import type { DesktopWindowService } from './contracts.ts'
import type { DesktopClientEnvironment } from './environment.ts'

function frozenInsets(top: number) {
  return Object.freeze({ top, right: 0, bottom: 0, left: 0 })
}

function frozenDragRegion(height: number, leftInset: number, rightInset: number) {
  return Object.freeze({ height, leftInset, rightInset })
}

/** Derive the public native-window geometry from the validated renderer marker. */
export function desktopWindowService(environment: DesktopClientEnvironment): DesktopWindowService {
  const availableMaterials = Object.freeze(environment.platform === 'darwin'
    ? ['off', 'transparent'] as const
    : ['off'] as const)
  if (environment.mode === 'compatibility' || environment.mode === 'extended') {
    return Object.freeze({
      ...environment,
      availableMaterials,
      safeAreaInsets: frozenInsets(0),
      dragRegion: frozenDragRegion(0, 0, 0),
    })
  }
  if (environment.platform === 'darwin') {
    return Object.freeze({
      ...environment,
      availableMaterials,
      safeAreaInsets: frozenInsets(ADVANCED_MACOS_DRAG_REGION_HEIGHT),
      dragRegion: frozenDragRegion(
        ADVANCED_MACOS_DRAG_REGION_HEIGHT,
        MACOS_TRAFFIC_LIGHT_SAFE_WIDTH,
        0,
      ),
    })
  }
  if (environment.platform === 'win32') {
    return Object.freeze({
      ...environment,
      availableMaterials,
      safeAreaInsets: frozenInsets(ADVANCED_WINDOWS_TITLEBAR_HEIGHT),
      dragRegion: frozenDragRegion(
        ADVANCED_WINDOWS_TITLEBAR_HEIGHT,
        0,
        WINDOWS_CAPTION_CONTROLS_WIDTH,
      ),
    })
  }
  return Object.freeze({
    ...environment,
    availableMaterials,
    safeAreaInsets: frozenInsets(0),
    dragRegion: frozenDragRegion(0, 0, 0),
  })
}

/** Provide the immutable service for one client plugin-fiber lifetime. */
export function provideDesktopWindow(
  ctx: ClientContext,
  service: DesktopWindowService,
): () => void {
  const dispose = ctx.reflect.provide('desktopWindow', service)
  return () => { void dispose() }
}
