/** Run the real Host with a temporary OS user home so AA never reads live credentials. */
import os from 'node:os'
import { isAbsolute } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'

const home = process.env.DSH_HOME
if (!home || !isAbsolute(home)) throw new Error('Host smoke requires an absolute temporary DSH_HOME')
const originalUserInfo = os.userInfo
os.userInfo = options => ({ ...originalUserInfo(options),
  homedir: options?.encoding === 'buffer' ? Buffer.from(home) : home })
os.homedir = () => home
syncBuiltinESMExports()
// Preserve the production entry-point guard and its fatal-error/IPC handling.
process.argv[1] = fileURLToPath(new URL('../../lib/host.js', import.meta.url))
await import('../../lib/host.js')
