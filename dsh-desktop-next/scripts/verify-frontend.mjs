/** Check the real official Web entry and sandboxed preload bundles without a GUI. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { APP_BOOT_SCRIPT, serveWebDocument } from '../lib/web-document.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const webRoot = dirname(require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html'))
const official = readFileSync(join(webRoot, 'index.html'), 'utf8')
const local = await serveWebDocument(new Request('dsh-app://app/'), webRoot)
const html = await local.text()
assert.equal(local.status, 200)
assert.ok(html.includes('<style id="dsh-next-loading-style">'), 'Next must style the document before the official boot page loads')
assert.equal(html.replace(/<style id="dsh-next-loading-style">[\s\S]*?<\/style>/u, '')
  .replace(APP_BOOT_SCRIPT, ''), official)
assert.ok(html.includes('/assets/'), 'Official production frontend must carry built assets')

// Electron hides custom-protocol Worker requests from webRequest, so the upload
// plugin's default Worker transport can never authenticate. The boot script
// installs its page-owned carrier; fail if the official client stops reading it.
const uploadClient = readFileSync(require.resolve('@deepseek-ai/dsh-client-file-upload/client'), 'utf8')
assert.ok(uploadClient.includes('globalThis.__DSH_FILE_UPLOAD__') && uploadClient.includes('hook.fetch'),
  'The file-upload client no longer reads the page-owned __DSH_FILE_UPLOAD__ fetch carrier')

// Market client bundles resolve primitives from the official Web at runtime. A
// removed export can blank the entire settings section without breaking build.
const marketClient = readFileSync(require.resolve('dshmarket/client'), 'utf8')
const primitivesSource = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-primitives'), 'utf8')
const exported = new Set(primitivesSource.match(/export \{([^}]+)\};/s)?.[1]?.split(',').map(name => name.trim()) ?? [])
assert.ok(exported.size > 0, 'Cannot inspect official UI primitive exports')
const directReferences = [...marketClient.matchAll(/_deepseek_ai_dsh_client_ui_primitives\.(\w+)/g)].map(match => match[1])
const iconAliases = [...marketClient.matchAll(/pickIcon\("(\w+)", "(\w+)"\)/g)]
assert.ok(directReferences.length > 0 && iconAliases.length > 0, 'Market bundle must resolve host primitives and icon aliases')
for (const name of directReferences) assert.ok(exported.has(name), `Market references missing UI primitive ${name}`)
for (const [, newer, older] of iconAliases) {
  assert.ok(exported.has(newer) || exported.has(older), `Market icon ${newer}/${older} is unavailable`)
}

for (const platform of ['darwin', 'win32', 'linux']) {
  const exposed = new Map()
  const dataset = {}
  const invocations = []
  const userActivation = { isActive: false }
  for (const [entry, hostname] of [['preload-app.cjs', 'app'], ['preload-shell.cjs', 'shell']]) {
    const listeners = new Map()
    // The shared map answers the per-platform assertions below; this one records a single entry,
    // so the shell can be held to what it exposes on its own rather than what the app left behind.
    const own = new Map()
    let requestedPage = 'general'
    runInNewContext(readFileSync(join(root, 'lib', entry), 'utf8'), {
      require: name => {
        assert.equal(name, 'electron', 'Sandboxed preloads may not require local chunks or Node modules')
        return { contextBridge: { exposeInMainWorld: (name, api) => { exposed.set(name, api); own.set(name, api) } }, ipcRenderer: {
          invoke: (...args) => {
            invocations.push(args)
            if (args[0] === 'dsh-next:settings-take') return Promise.resolve(requestedPage)
            if (args[0] === 'dsh-next:browser-acquire') return Promise.resolve({ lease: 'lease-1', partition: 'partition-1' })
            return Promise.resolve(undefined)
          }, send() {},
          on: (channel, listener) => listeners.set(channel, listener), removeListener: channel => listeners.delete(channel), off: channel => listeners.delete(channel),
        } }
      },
      process: { platform }, location: { protocol: 'dsh-app:', hostname },
      document: { readyState: 'loading', documentElement: { dataset, style: { setProperty() {} } } },
      window: { addEventListener() {} }, console,
      navigator: { userActivation },
    }, { filename: entry })
    if (hostname === 'app') {
      // dsh 0.1.7 drives the native Sidebar browser itself off this carrier.
      const { keyboard, shortcuts } = exposed.get('dshDesktop')
      assert.equal(typeof keyboard.closeWindow, 'function')
      for (const name of ['get', 'edit', 'recording', 'subscribe']) assert.equal(typeof shortcuts[name], 'function')
      const input = []
      const unsubscribe = keyboard.subscribe(value => input.push(value))
      listeners.get('dsh-next:shortcuts-input')({}, { kind: 'keyboard', code: 'KeyB', revision: 'fixture' })
      assert.equal(input[0].code, 'KeyB')
      unsubscribe()
      assert.equal(listeners.has('dsh-next:shortcuts-input'), false)
      const browser = exposed.get('dshDesktop').browser
      assert.deepEqual(await browser.acquire('/workspace/one'), { lease: 'lease-1', partition: 'partition-1' })
      assert.deepEqual([...invocations.at(-1)], ['dsh-next:browser-acquire', '/workspace/one'])
      const opened = []
      const stopBrowser = browser.onOpenRequested('lease-1', url => opened.push(url))
      const deliver = listeners.get('dsh-next:browser-open-requested')
      deliver({ privilegedEvent: true }, { lease: 'lease-1', url: 'https://example.com/' })
      assert.deepEqual(opened, ['https://example.com/'], 'An approved guest link reaches its own lease')
      deliver({ privilegedEvent: true }, { lease: 'lease-2', url: 'https://example.com/other' })
      deliver({ privilegedEvent: true }, { lease: 'lease-1', url: 42 })
      assert.deepEqual(opened, ['https://example.com/'], 'Foreign leases and malformed requests are ignored')
      stopBrowser()
      deliver({ privilegedEvent: true }, { lease: 'lease-1', url: 'https://example.com/after' })
      assert.deepEqual(opened, ['https://example.com/'], 'Unsubscribing stops delivery')
      await browser.release('lease-1')
      assert.deepEqual([...invocations.at(-1)], ['dsh-next:browser-release', 'lease-1'])
      const received = []
      const stop = exposed.get('desktopNext').onOpenSettings(page => received.push(page))
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.deepEqual(received, ['general'], 'A request made before the client mounts must be delivered')
      requestedPage = 'permissions'
      listeners.get('dsh-next:settings-open')()
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.deepEqual(received, ['general', 'permissions'])
      requestedPage = 'unsupported'
      listeners.get('dsh-next:settings-open')()
      await new Promise(resolve => setTimeout(resolve, 0))
      assert.deepEqual(received, ['general', 'permissions'])
      stop()
      assert.equal(listeners.has('dsh-next:settings-open'), false)
    } else {
      assert.equal(own.get('desktopNext').onOpenSettings, undefined)
      assert.equal(own.has('dshDesktop'), false, 'Only the application document may reach guest browsers')
    }
  }
  assert.equal(dataset.platform, platform)
  assert.equal(exposed.get('dshDesktop')?.protocolVersion, 1)
  assert.equal(typeof exposed.get('dshDesktopBoot')?.ready, 'function')
  assert.equal(typeof exposed.get('__DSH_DIRECTORY_PICKER__')?.pick, 'function')
  assert.equal(typeof exposed.get('desktopNext')?.command, 'function')
  assert.equal(typeof exposed.get('desktopNext')?.browserLinks, 'function')
  const permissions = exposed.get('desktopNext').permissions
  await permissions.query('microphone')
  assert.equal(invocations.at(-1)[0], 'dsh-next:permission-query')
  await assert.rejects(permissions.request('microphone'), /user gesture/)
  userActivation.isActive = true
  await permissions.request('microphone')
  assert.deepEqual([...invocations.at(-1)], ['dsh-next:permission-request', 'microphone'])
  await permissions.openSettings('screen')
  assert.deepEqual([...invocations.at(-1)], ['dsh-next:permission-settings', 'screen'])
}
console.log('Next frontend check passed: official 0.2.1-alpha.1 entry and independent sandboxed preloads for macOS, Windows and Linux.')
