/** Explicit native protocol checks with hidden windows and disposable user data. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, protocol, session } from 'electron'
import { NextDesktopRuntime } from '../lib/desktop-runtime.js'
import { appRequestHeaders, forwardWebRequest } from '../lib/web-document.js'
import { installAppDownloads } from '../lib/app-downloads.js'

if (process.argv.includes('--plugin-frames') && (process.platform === 'win32' || (process.platform === 'linux' && process.env.DISPLAY))) {
  void verifyPluginFrames()
} else if (process.platform !== 'linux' || !process.env.DISPLAY) {
  console.error('Run this native protocol check on Linux under xvfb-run; use check:next for portable headless checks.')
  app.exit(1)
} else {
  // Electron emits ready after evaluating its ESM entry; do not await it at module scope.
  void verify()
}

/** Exercise real child-frame navigation without starting a Host or reading a user's Profile. */
async function verifyPluginFrames() {
  const home = process.argv[process.argv.indexOf('--plugin-frames-home') + 1]
  assert.ok(home && dirname(resolve(home)) === resolve(tmpdir()) && basename(home).startsWith('dsh-next-plugin-frames-'),
    'Run yarn verify:plugin-frames so its launcher owns a disposable userData directory')
  app.setPath('userData', home)
  app.setPath('sessionData', home)
  protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true,
  } }])
  const token = 'plugin-frame-fixture-token'
  const cookie = 'session=plugin-frame-fixture'
  const forwarded = []
  const observed = []
  const frames = []
  const redirected = []
  const server = createServer((request, response) => {
    if (request.url === '/redirect-target') {
      redirected.push(request.headers)
      response.setHeader('access-control-allow-origin', 'dsh-app://app')
      response.end('redirected')
      return
    }
    assert.equal(request.headers['x-dsh-desktop-renderer'], token)
    assert.equal(request.headers.cookie, cookie)
    assert.equal(request.headers.origin, host)
    forwarded.push(request.url)
    if (request.url === '/studio/') {
      response.setHeader('content-type', 'text/html')
      response.end('<!doctype html><link rel="stylesheet" href="/studio/style.css"><h1 id="frame-proof">Plugin frame loaded</h1><script src="/studio/frame.js"></script>')
    } else if (request.url === '/studio/frame.js') {
      response.setHeader('content-type', 'text/javascript')
      response.end('globalThis.frameProof = fetch("/studio/data").then(async response => ({ status: response.status, body: await response.text() }))')
    } else if (request.url === '/studio/style.css') {
      response.setHeader('content-type', 'text/css')
      response.end('#frame-proof { color: rgb(1, 2, 3) }')
    } else if (request.url === '/redirect') {
      response.writeHead(302, { location: `${host}/redirect-target` })
      response.end()
    } else {
      response.end('authenticated fixture')
    }
  })
  let window
  let other
  let host
  let code = 0
  let stage = 'Electron ready'
  const deadline = setTimeout(() => { console.error(`Plugin frame check timed out: ${stage}`); app.exit(1) }, 45_000)
  try {
    await app.whenReady()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    host = `http://127.0.0.1:${server.address().port}`
    protocol.handle('dsh-app', async request => {
      const url = new URL(request.url)
      if (url.pathname === '/') return new Response('<!doctype html><title>Plugin frame fixture</title>', { headers: { 'content-type': 'text/html' } })
      if (url.host === 'shell' && url.pathname === '/foreign/') return new Response('<!doctype html><script>globalThis.foreignProof = fetch("dsh-app://app/foreign-check", { mode: "no-cors" }).then(() => true).catch(() => true)</script>', { headers: { 'content-type': 'text/html' } })
      const response = await forwardWebRequest(request, host, cookie, token)
      observed.push({ path: url.pathname, marked: request.headers.get('x-dsh-desktop-renderer') === token, status: response.status })
      return response
    })
    session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['<all_urls>'] }, (details, callback) => {
      if (new URL(details.url).protocol === 'dsh-app:') frames.push({ path: new URL(details.url).pathname,
        type: details.resourceType, mainFrame: details.frame === window?.webContents.mainFrame,
        origin: details.frame && !details.frame.detached ? details.frame.origin : null })
      callback({ requestHeaders: appRequestHeaders(details, window?.webContents, token) })
    })
    const options = { show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }
    window = new BrowserWindow(options)
    stage = 'owned main frame'
    await window.loadURL('dsh-app://app/')
    assert.equal(await window.webContents.executeJavaScript('fetch("/main-check").then(response => response.status)'), 200)
    stage = 'same-origin iframe navigation and resources'
    await window.webContents.executeJavaScript(`new Promise(resolve => {
      const frame = document.createElement('iframe'); frame.id = 'plugin-frame';
      frame.sandbox = 'allow-scripts allow-same-origin'; frame.src = '/studio/';
      frame.addEventListener('load', resolve, { once: true }); document.body.append(frame)
    }).then(() => true)`)
    const child = await window.webContents.executeJavaScript(`(async () => {
      const frame = document.getElementById('plugin-frame');
      return { title: frame.contentDocument.querySelector('#frame-proof')?.textContent,
        color: frame.contentWindow.getComputedStyle(frame.contentDocument.querySelector('#frame-proof')).color,
        data: await frame.contentWindow.frameProof }
    })()`)
    assert.deepEqual(child, { title: 'Plugin frame loaded', color: 'rgb(1, 2, 3)', data: { status: 200, body: 'authenticated fixture' } })
    assert.ok(frames.some(frame => frame.path === '/studio/' && frame.type === 'subFrame' && !frame.mainFrame && frame.origin === 'dsh-app://app'),
      'The initial document must use a real same-origin child frame')
    assert.ok(frames.some(frame => frame.path === '/studio/data' && frame.type === 'xhr' && !frame.mainFrame && frame.origin === 'dsh-app://app'),
      'The fetch must originate inside the real child frame')
    for (const path of ['/main-check', '/studio/', '/studio/frame.js', '/studio/style.css', '/studio/data']) {
      assert.ok(forwarded.includes(path), `Host did not receive ${path}`)
      assert.ok(observed.some(request => request.path === path && request.marked && request.status === 200), `Unauthenticated ${path}`)
    }
    stage = 'foreign iframe rejection'
    await window.webContents.executeJavaScript(`new Promise(resolve => {
      const frame = document.createElement('iframe'); frame.id = 'foreign-frame'; frame.src = 'dsh-app://shell/foreign/';
      frame.addEventListener('load', resolve, { once: true }); document.body.append(frame)
    }).then(() => true)`)
    const foreign = window.webContents.mainFrame.frames.find(frame => frame.url === 'dsh-app://shell/foreign/')
    assert.ok(foreign, 'Foreign frame was not loaded')
    await foreign.executeJavaScript('globalThis.foreignProof')
    assert.ok(observed.some(request => request.path === '/foreign-check' && !request.marked && request.status === 403))
    assert.ok(!forwarded.includes('/foreign-check'))
    stage = 'other window rejection'
    other = new BrowserWindow(options)
    await other.loadURL('dsh-app://app/')
    assert.equal(await other.webContents.executeJavaScript('fetch("/other-window-check").then(response => response.status)'), 403)
    assert.ok(!forwarded.includes('/other-window-check'))
    stage = 'redirect marker stripping'
    assert.equal(await window.webContents.executeJavaScript('fetch("/redirect").then(response => response.text())'), 'redirected')
    assert.equal(redirected.length, 1)
    assert.equal(redirected[0]['x-dsh-desktop-renderer'], undefined)
    assert.equal(redirected[0].cookie, undefined)
    console.log('Plugin frame navigation metadata:', JSON.stringify(observed))
    console.log('Plugin frame request metadata:', JSON.stringify(frames))
    console.log('Next plugin frames passed: owned main frame, initial same-origin iframe navigation, child script/style/fetch, foreign iframe and other-window 403, redirected credentials stripped.')
  } catch (error) {
    console.error(`Plugin frame check failed at ${stage}:`, error)
    code = 1
  } finally {
    clearTimeout(deadline)
    other?.destroy()
    window?.destroy()
    await new Promise(resolve => server.close(resolve))
    app.exit(code)
  }
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
