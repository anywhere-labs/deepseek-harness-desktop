/**
 * Renderer permission policy for the desktop shell.
 *
 * The Web UI runs with every Electron permission denied by default, which is
 * the right posture for a loopback-only shell. The one deliberate exception
 * is the sanitized clipboard write: every copy control in the Web UI
 * (message copy, code blocks, diffs, JSON trees, …) writes through the async
 * Clipboard API, and Electron gates that write on the
 * `clipboard-sanitized-write` permission check. Denying it turns every copy
 * button into a silent no-op, so it is explicitly allow-listed here.
 */

/** Permission names the Web UI legitimately needs inside the desktop shell. */
export const ALLOWED_RENDERER_PERMISSIONS = new Set<string>([
  'clipboard-sanitized-write',
])

/**
 * Decide whether the renderer may use a permission.
 * @param permission - Electron permission name being checked or requested.
 * @returns true only for the explicitly allow-listed permissions.
 */
export function isAllowedPermission(permission: string): boolean {
  return ALLOWED_RENDERER_PERMISSIONS.has(permission)
}
