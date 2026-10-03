/** Real Chromium -> Electron protocol -> native-only Host, run under Linux Xvfb in CI. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, protocol, session } from 'electron'
import { NextDesktopRuntime } from '../lib/desktop-runtime.js'
import { appRequestHeaders, forwardWebRequest } from '../lib/web-document.js'
import { installAppDownloads } from '../lib/app-downloads.js'

if (process.platform !== 'linux' || !process.env.DISPLAY) {
  console.error('Run this native protocol check on Linux under xvfb-run; use check:next for portable headless checks.')
  app.exit(1)
} else {
  // Electron emits ready after evaluating its ESM entry; do not await it at module scope.
  void verify()
}

async function verify() {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const home = mkdtempSync(join(tmpdir(), 'dsh-next-protocol-'))
  app.setPath('userData', home)
  protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
  } }])
  const runtime = new NextDesktopRuntime({ root, home, executable: process.execPath, addresses: () => [],
    certificate: async () => { throw new Error('Protocol checks must not expose a LAN listener') },
    onFailure() {}, onChange() {}, onRestart() {}, onTerminal() {}, onNotification() {},
  })
  let window
  let exitCode = 0
  const observed = []
  let stage = 'Electron ready'
  const deadline = setTimeout(() => { console.error(`Native protocol check timed out: ${stage}`); app.exit(1) }, 60_000)
  try {
    await app.whenReady()
    stage = 'Host startup'
    runtime.initialize()
    runtime.profiles.ensure('desktop')
    runtime.profiles.setFeatures('desktop', { market: true, remoteControl: false })
    await runtime.start()
    const { url, cookie, token } = runtime.auth
    const browser = await fetch(new URL(url).origin, { headers: { cookie } })
    assert.equal(browser.status, 403, 'The test must keep ordinary browser access disabled')
    await browser.body?.cancel()
    protocol.handle('dsh-app', async request => {
      if (new URL(request.url).pathname === '/') return new Response('<!doctype html><title>Next protocol fixture</title>', {
        headers: { 'content-type': 'text/html' },
      })
      const response = await forwardWebRequest(request, url, cookie, token)
      observed.push({ origin: request.headers.get('origin'), marked: request.headers.get('x-dsh-desktop-renderer') === token, status: response.status })
      return response
    })
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ requestHeaders: appRequestHeaders(details, window?.webContents, token) })
    })
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
    stage = 'renderer load'
    await window.loadURL('dsh-app://app/')
    const call = async (path, body) => {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const response = await fetch(${JSON.stringify(`/api/community-market/${path}`)}, {
          method: ${JSON.stringify(body === undefined ? 'GET' : 'POST')}, referrerPolicy: 'no-referrer',
          headers: { 'content-type': 'application/json' },
          ${body === undefined ? '' : `body: ${JSON.stringify(JSON.stringify(body))},`}
        });
        return { status: response.status, body: await response.text() };
      })()`)
      assert.equal(result.status, 200, result.body)
      return JSON.parse(result.body)
    }
    stage = 'native Market requests'
    const state = await call('state')
    const key = state.builtIns[0].key
    const added = await call('sources', { action: 'add-builtin', key })
    const sourceRecordId = added.sources.find(source => source.builtInProviderKey === key).sourceRecordId
    const selected = await call('sources', { action: 'select', sourceRecordId })
    assert.equal(selected.sources.find(source => source.sourceRecordId === sourceRecordId)?.enabled, true)
    const removed = await call('sources', { action: 'remove', sourceRecordId })
    assert.equal(removed.sources.some(source => source.sourceRecordId === sourceRecordId), false)
    assert.ok(observed.every(request => request.marked))
    console.log('Native protocol request metadata:', JSON.stringify(observed))

    // `<a download>` bypasses webRequest, so Chromium's own item can only carry the gate's 403.
    // The main process must replace it with an authenticated request and save the Host body.
    stage = 'application route download'
    const downloads = join(home, 'downloads')
    mkdirSync(downloads)
    const failures = []
    const warnings = []
    dialog.showSaveDialog = async (_owner, options) => ({ canceled: false, filePath: options.defaultPath })
    dialog.showMessageBox = async (_owner, options) => { failures.push(options.detail); return { response: 0 } }
    installAppDownloads(session.defaultSession, {
      window: () => window, downloads: () => downloads, language: () => 'en', warn: error => { warnings.push(String(error)) },
      forward: target => forwardWebRequest(new Request(target, { headers: { 'x-dsh-desktop-renderer': token } }), url, cookie, token),
    })
    const click = (path, name) => window.webContents.executeJavaScript(`(() => {
      const anchor = document.createElement('a'); anchor.href = ${JSON.stringify(path)}; anchor.download = ${JSON.stringify(name)}; anchor.click()
    })()`)
    const until = async (ready, label) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const value = ready()
        if (value !== undefined) return value
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      throw new Error(`Timed out waiting for ${label}; failures: ${JSON.stringify(failures)}; warnings: ${JSON.stringify(warnings)}`)
    }
    await click('api/community-market/state', 'market-state.json')
    const saved = await until(() => {
      try { return JSON.parse(readFileSync(join(downloads, 'market-state.json'), 'utf8')) } catch { return undefined }
    }, 'the downloaded Market state')
    assert.equal(saved.builtIns[0].key, key)
    await click('api/session.export?sessionId=verify-protocol-missing', 'dsh-session.zip')
    const failure = await until(() => failures[0], 'the session export failure prompt')
    assert.match(failure, /^Host responded with HTTP 404: session not found/u)
    assert.equal(failures.length, 1)
    assert.deepEqual(warnings, [`Error: ${failure}`])
    assert.equal(readdirSync(downloads).length, 1)
    console.log('Native download metadata:', JSON.stringify(observed.slice(-2)))

    // Same protocol, different origin; an opaque response must not cause a mutation.
    stage = 'foreign page rejection'
    await window.loadURL('dsh-app://shell/')
    const before = observed.length
    await window.webContents.executeJavaScript(`fetch('dsh-app://app/api/community-market/sources', {
      method: 'POST', mode: 'no-cors', referrerPolicy: 'no-referrer',
      body: ${JSON.stringify(JSON.stringify({ action: 'add-builtin', key }))},
    }).catch(() => {})`)
    assert.equal(observed.length, before + 1)
    assert.equal(observed.at(-1).marked, false)
    assert.equal(observed.at(-1).status, 403)
    await window.loadURL('dsh-app://app/')
    assert.equal((await call('state')).sources.some(source => source.builtInProviderKey === key), false)
    console.log('Next native protocol check passed: renderer source mutations, owned-frame markers, application downloads and foreign-page rejection.')
  } catch (error) {
    console.error(error)
    exitCode = 1
  } finally {
    clearTimeout(deadline)
    window?.destroy()
    await runtime.close()
    rmSync(home, { recursive: true, force: true })
    app.exit(exitCode)
  }
}
