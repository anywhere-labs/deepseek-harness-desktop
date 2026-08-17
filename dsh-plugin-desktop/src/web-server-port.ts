/**
 * Resolve the loopback Web server port for the desktop launcher.
 *
 * The desktop shell binds the DSH Web UI to 127.0.0.1 with a random port
 * (port 0) by default so concurrent desktop instances never collide. Some
 * external tools (e.g. the DSH browser helper) discover a DSH instance by
 * scanning the fixed port range the CLI uses (3080 / 3081 / 3090) and
 * cannot follow a desktop instance that moves port on every launch.
 *
 * `DSH_DESKTOP_WEB_PORT` lets a user pin a port for that scenario. Unset
 * (or empty) keeps the default random-port behaviour, so existing installs
 * are unchanged. The host stays 127.0.0.1 — loopback binding is a launcher
 * security invariant and is not configurable here.
 *
 * Accepted values: a non-negative decimal integer (0..65535). `0` requests
 * an OS-assigned random port explicitly. Anything else (fractions, hex,
 * scientific notation, signs, text) falls back to `0` with a warning,
 * rather than failing startup over a bad port override.
 */

const ENV_NAME = 'DSH_DESKTOP_WEB_PORT'
const MAX_PORT = 65535
// Strict decimal integer: rejects signs, fractions, hex (0x..), and
// scientific notation (1e3) that Number()/parseInt() would otherwise accept.
const DECIMAL_INTEGER = /^\d+$/u

/** Resolve the Web server port from `DSH_DESKTOP_WEB_PORT`, defaulting to 0. */
export function resolveWebServerPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_NAME]
  if (raw === undefined || raw.trim() === '') return 0
  const trimmed = raw.trim()
  if (!DECIMAL_INTEGER.test(trimmed)) {
    console.warn(
      `[dsh-plugin-desktop] ${ENV_NAME}="${raw}" is not a decimal integer; falling back to a random port.`,
    )
    return 0
  }
  const parsed = Number.parseInt(trimmed, 10)
  if (parsed > MAX_PORT) {
    console.warn(
      `[dsh-plugin-desktop] ${ENV_NAME}="${raw}" exceeds ${MAX_PORT}; falling back to a random port.`,
    )
    return 0
  }
  return parsed
}
