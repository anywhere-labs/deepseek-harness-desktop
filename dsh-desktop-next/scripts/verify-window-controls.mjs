/** Official Desktop boot in headless Chromium; simulated IPC/platform, no native window or user profile. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { DesktopHostProcess } from '../lib/host-process.js'
import { desktopKeybindings } from '../lib/keybindings.js'
import { NextProfiles } from '../lib/profiles.js'
import { authenticateWebHost, serveWebDocument } from '../lib/web-document.js'
import { browserFixture, verifySidebarBrowser, verifyWebBrowserFallback } from './verify-sidebar-browser-ui.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const webRoot = dirname(require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html'))
const home = mkdtempSync(join(tmpdir(), 'dsh-next-window-controls-'))
const workspace = join(home, 'workspace')
mkdirSync(workspace)
const screenshots = join(root, '.desktop-next', 'verification')
const manager = new NextProfiles(home)
manager.ensure('desktop')
manager.setFeatures('desktop', { market: true, remoteControl: false })
// The renderer below simulates darwin, so the Host must mount the matching
// `native` directory flow for the preload-backed picker to be the surface under
// test. Upstream's chooser resolves `browse` on a Linux host with no
// zenity/kdialog on PATH, which is every headless CI runner: hand it a display
// and an executable chooser stub so one platform does not silently verify a
// different flow. Nothing ever runs the stub — the client short-circuits to the
// injected `__DSH_DIRECTORY_PICKER__` before the Host backend is consulted.
const chooserEnv = {}
if (process.platform === 'linux') {
  const chooserDir = join(home, 'chooser-bin')
  mkdirSync(chooserDir)
  writeFileSync(join(chooserDir, 'zenity'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  chooserEnv.PATH = `${chooserDir}${delimiter}${process.env.PATH ?? ''}`
  chooserEnv.DISPLAY = process.env.DISPLAY ?? ':0'
}
const host = new DesktopHostProcess(process.execPath, root, manager.directory('desktop'), undefined,
  { ...process.env, ...chooserEnv, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, undefined, undefined, undefined,
  join(root, 'lib', 'host.js'))
const shortcutPreferences = desktopKeybindings(home, 'macos', () => {})
let browser
let page
let recoveryPage
const diagnostics = []
try {
  const ready = await host.start()
  const streamBaseUrl = new URL(ready.url).origin
  const cookie = await authenticateWebHost(ready.url)
  const cookieSeparator = cookie.indexOf('=')
  const documentResponse = await serveWebDocument(new Request('dsh-app://app/'), webRoot)
  assert.equal(documentResponse.status, 200)
  const desktopDocument = await documentResponse.text()
  browser = await chromium.launch({ headless: true,
    ...(process.env.DSH_NEXT_TEST_BROWSER_CHANNEL ? { channel: process.env.DSH_NEXT_TEST_BROWSER_CHANNEL } : {}),
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 840 }, locale: 'zh-CN', colorScheme: 'dark' })
  const nativeBrowser = await browserFixture(context)
  await context.addInitScript(path => { globalThis.__DSH_DIRECTORY_PICKER__ = { pick: async () => path } }, workspace)
  // Chromium classifies the intercepted document separately from its loopback Host.
  await context.grantPermissions(['local-network-access'], { origin: streamBaseUrl })
  await context.addCookies([{ url: streamBaseUrl, name: cookie.slice(0, cookieSeparator), value: cookie.slice(cookieSeparator + 1) }])
  const controlCommands = []
  const loginToken = 'L'.repeat(43)
  let rejectPreference = false
  const controlState = {
    selected: 'desktop', profiles: ['desktop', 'work', 'broken'], unavailableProfiles: ['broken'], features: { market: true, remoteControl: false },
    preferences: { closeToTray: true, macosMaterial: 'transparent', windowsMaterial: 'off', browserAccess: false,
      networkExposure: 'loopback', port: 0, lanPort: 0, logLevel: 'info', notifications: true,
      turnCompleted: true, turnFailed: true, jobCompleted: false, jobFailed: false },
    phase: 'ready', busy: false, failure: '', safeMode: false, home: '[temporary test home]', platform: 'darwin',
    version: '2.0.14-next', updates: { phase: 'idle', installable: true }, trayAvailable: true, notificationsAvailable: true, browserUrl: null, lan: null,
    recovery: { bundles: [{ bundleId: 'fixture-plugin', packageName: 'fixture-plugin', owner: 'profile', status: 'active', action: 'uninstall' }],
      checkpoints: [{ id: 'fixture-checkpoint', created: new Date().toISOString(), fileCount: 3, totalBytes: 128 }],
      profileDirectory: '[temporary profile]', usingDefaultDirectory: true },
    checkpoint: { created: new Date().toISOString() }, logs: 'Headless UI fixture; native actions are recorded only.',
  }
  await context.exposeFunction('__nextTestState', () => structuredClone(controlState))
  const browserLinks = () => ({
    localUrl: controlState.browserUrl ? controlState.browserUrl + '?token=' + loginToken : null,
    lanUrls: controlState.browserUrl && controlState.lan?.state === 'ready'
      ? controlState.lan.addresses.map(address => `https://${address}:${controlState.lan.actualPort}/?token=${loginToken}`) : [],
  })
  await context.exposeFunction('__nextTestBrowserLinks', browserLinks)
  const permissionActions = []
  const permissionStates = { microphone: 'not-determined', screen: 'denied', accessibility: 'unknown' }
  await context.exposeFunction('__nextTestPermission', (action, permission) => {
    permissionActions.push({ action, permission })
    if (action === 'request') permissionStates[permission] = 'granted'
    const status = permissionStates[permission]
    return { permission, status, canRequest: status === 'not-determined' || status === 'unknown', canOpenSettings: true }
  })
  await context.exposeFunction('__nextTestCommand', command => {
    if (command.type === 'preferences' && rejectPreference) { rejectPreference = false; throw new Error('Fixture: preference save rejected') }
    controlCommands.push(command)
    if (command.type === 'recovery-action' && command.action === 'preview-checkpoint') {
      controlState.recovery.notice = { tone: 'success', title: '检查点已恢复', body: '配置和所需插件依赖已恢复。请点击“退出并重启”使恢复生效。' }
    }
    if (command.type === 'preferences') {
      controlState.preferences = command.preferences
      controlState.browserUrl = command.preferences.browserAccess ? streamBaseUrl + '/' : null
      controlState.lan = command.preferences.networkExposure === 'lan'
        ? { state: 'ready', actualPort: 43121, addresses: ['192.168.1.20', '10.0.0.20'], caFingerprint: 'a'.repeat(64), errorCode: null }
        : null
    }
    if (command.type === 'switch') controlState.selected = command.name
    if (command.type === 'features') controlState.features = command.features
    if (command.type === 'create') controlState.profiles.push(command.name)
  })
  await context.addInitScript(() => {
    window.desktopNext = { state: () => window.__nextTestState(), browserLinks: () => window.__nextTestBrowserLinks(), command: command => window.__nextTestCommand(command) }
    window.desktopNext.onOpenSettings = listener => {
      window.__nextTestOpenSettings = listener
      return () => { delete window.__nextTestOpenSettings }
    }
    window.desktopNext.permissions = {
      query: permission => window.__nextTestPermission('query', permission),
      request: permission => window.__nextTestPermission('request', permission),
      openSettings: permission => window.__nextTestPermission('openSettings', permission),
    }
  })
  // Serve the Desktop document without the browser Host's inline injections.
  // The published entry must request them through its Desktop boot contract.
  await context.route(streamBaseUrl + '/', route => route.fulfill({ contentType: 'text/html', body: desktopDocument }))
  // Desktop answers this contract from the running Host, not from the table captured at startup:
  // dsh 0.1.7 addresses boot bundles by revision and republishes the table whenever a plugin
  // registers, so a reload that replays the startup table requests bundles that no longer exist.
  await context.exposeFunction('__nextTestBootPayload', async () => ({ injections: await host.collectInjections(), streamBaseUrl }))
  await context.exposeFunction('__nextTestShortcutsGet', async definitions => {
    shortcutPreferences.setDefinitions(definitions)
    return shortcutPreferences.readCurrent()
  })
  await context.exposeFunction('__nextTestShortcutsEdit', (edit, revision) => shortcutPreferences.edit(edit, revision))
  await context.addInitScript(() => {
    globalThis.__NEXT_TEST_BOOT__ = { calls: 0, failures: [] }
    // dsh 0.1.7 reads the native browser transport off this carrier; the bridge comes from
    // `browserFixture`, whose init script already ran.
    const inputListeners = new Set()
    globalThis.__nextTestShortcut = input => { for (const listener of inputListeners) listener({ ...input, revision: globalThis.__nextShortcutRevision }) }
    globalThis.dshDesktop = {
      protocolVersion: 1, browser: globalThis.__nextBrowserBridge,
      keyboard: { subscribe: listener => { inputListeners.add(listener); return () => inputListeners.delete(listener) }, closeWindow: async () => {} },
      shortcuts: {
        get: async definitions => {
          const snapshot = await globalThis.__nextTestShortcutsGet(definitions)
          globalThis.__nextShortcutRevision = snapshot.revision
          return snapshot
        },
        edit: (edit, revision) => globalThis.__nextTestShortcutsEdit(edit, revision),
        subscribe: () => () => {}, recording: async () => {},
      },
    }
    globalThis.dshDesktopBoot = {
      ready: async () => { globalThis.__NEXT_TEST_BOOT__.calls++; return window.__nextTestBootPayload() },
      failed: async message => { globalThis.__NEXT_TEST_BOOT__.failures.push(message) },
    }
    const mark = () => { document.documentElement.dataset.platform = 'darwin' }
    if (document.documentElement) mark()
    else document.addEventListener('DOMContentLoaded', mark, { once: true })
  })
  page = await context.newPage()
  page.setDefaultTimeout(15_000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) diagnostics.push(message.text()) })
  page.on('response', response => { if (response.status() >= 400) diagnostics.push(`${response.status()} ${new URL(response.url()).pathname}`) })
  await page.goto(streamBaseUrl)
  const collapse = page.getByRole('button', { name: /^(收起侧边栏|Collapse sidebar)$/ })
  const reopen = page.locator('[data-sidebar-header-controls]').getByRole('button', { name: /^(打开侧边栏|Open sidebar)$/ })
  const drag = page.locator('[data-conversation-title-row], :has(> [data-shell-overlay]) > :has([data-plugin-panel])')
  const dragRegion = () => drag.evaluate(element => getComputedStyle(element,
    element.hasAttribute('data-conversation-title-row') ? null : '::before').getPropertyValue('-webkit-app-region'))
  await collapse.waitFor({ state: 'visible' })
  assert.deepEqual(await page.evaluate(() => globalThis.__DSH_TRANSPORT__), { ownsHost: true, streamBaseUrl },
    'The official entry must execute its Desktop boot branch')
  assert.equal(await page.evaluate(() => globalThis.__NEXT_TEST_BOOT__.calls), 1)
  // rc.2 moves official Desktop onboarding into its native shell. Older Web
  // notices may still appear when a persisted profile requests them.
  const welcome = page.getByRole('button', { name: /^(继续|Continue)$/ })
  if (await welcome.isVisible()) {
    assert.equal(await dragRegion(), 'no-drag', 'Modal surfaces must not expose window drag regions')
    await welcome.click()
  }
  // Dismiss the optional Web credential dialog when present.
  const later = page.getByRole('button', { name: /^(稍后配置|Configure later|添加 API Key|Add API key)$/ })
  await later.click({ timeout: 2_000 }).catch(() => {})
  await page.locator('[aria-modal=true]').waitFor({ state: 'hidden' })
  await drag.waitFor({ state: 'visible' })
  await page.evaluate(() => globalThis.__nextTestShortcut({ kind: 'keyboard', frameName: '', code: 'KeyB', control: false, alt: false, shift: false, meta: true, repeat: false }))
  await reopen.waitFor({ state: 'visible' })
  await page.evaluate(() => globalThis.__nextTestShortcut({ kind: 'keyboard', frameName: '', code: 'KeyB', control: false, alt: false, shift: false, meta: true, repeat: false }))
  await collapse.waitFor({ state: 'visible' })
  // Simulate multiple extension entries in the official footer seat and check real geometry.
  const footer = page.locator('[data-slot="sidebar.footer.action"]')
  await footer.evaluate(element => {
    for (const label of ['手机连接', '插件市场', '扩展入口']) {
      const button = document.createElement('button')
      button.dataset.nextFooterFixture = ''
      button.textContent = label
      button.style.cssText = 'width:calc(100% + 4px);margin:-2px;padding:12px;text-align:left;border-radius:12px'
      element.appendChild(button)
    }
  })
  const footerEntries = footer.locator('[data-next-footer-fixture]')
  const footerBoxes = await footerEntries.evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  }))
  assert.equal(footerBoxes.length, 3)
  for (let i = 1; i < footerBoxes.length; i++) {
    assert.ok(footerBoxes[i].y >= footerBoxes[i - 1].y + footerBoxes[i - 1].height)
    assert.equal(footerBoxes[i].x, footerBoxes[0].x)
    assert.equal(footerBoxes[i].width, footerBoxes[0].width)
  }
  mkdirSync(screenshots, { recursive: true })
  await page.screenshot({ path: join(screenshots, 'sidebar-footer.png'), animations: 'disabled' })
  await footerEntries.evaluateAll(elements => elements.forEach(element => element.remove()))

  const checkDrag = async () => {
    const geometry = await drag.evaluate(element => {
      const frame = document.querySelector('[data-shell-overlay]').parentElement
      const columns = getComputedStyle(frame).gridTemplateColumns.split(' ').map(Number.parseFloat)
      const box = element.getBoundingClientRect()
      const pseudo = element.hasAttribute('data-conversation-title-row') ? null : '::before'
      const style = getComputedStyle(element, pseudo)
      return { left: box.left, width: box.width, height: pseudo ? Number.parseFloat(style.height) : box.height, columns,
        region: style.getPropertyValue('-webkit-app-region') }
    })
    assert.equal(geometry.region, 'drag')
    assert.ok(geometry.left >= geometry.columns[0], JSON.stringify(geometry))
    assert.ok(geometry.left + geometry.width <= geometry.columns[0] + geometry.columns[1] + 1, JSON.stringify(geometry))
    assert.ok(geometry.width > 300 && geometry.height >= 30, JSON.stringify(geometry))
    assert.equal(await page.locator('[data-next-window-controls]').count(), 0, 'No extra visible titlebar or overlay component')
  }
  const expand = async () => {
    await reopen.waitFor({ state: 'visible' })
    assert.equal(await reopen.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region')), 'no-drag')
    await reopen.click()
    await reopen.waitFor({ state: 'hidden' })
    await collapse.waitFor({ state: 'visible' })
  }
  // 0.1.7 added `settings.launcher`, and the account plugin takes that seat, which suppresses
  // the labelled `settings.trigger` fallback button. Settings then lives in the launcher menu,
  // always as its first entry, so the entry is reached positionally rather than by label.
  const openSettingsPanel = async (root = page) => {
    const labelled = root.getByRole('button', { name: /^(设置|Settings)$/ })
    if (await labelled.count() > 0) { await labelled.click(); return }
    await root.locator('[data-slot="settings.launcher"] button').first().click()
    await root.getByRole('menu').getByRole('menuitem').first().click()
  }
  // No Workspace picked yet: reuse the official header frame and both native controls.
  // 0.1.7 always mounts the persistent header and opens on a blank Session, so the frame is
  // identified by its own marker instead of the removed unbound-only empty-header marker.
  assert.equal(await page.locator('[data-conversation-header]').count(), 1)
  assert.equal(await page.locator('[data-conversation-header-leading]').count(), 1)
  await checkDrag()
  await collapse.click()
  await reopen.waitFor({ state: 'visible' })
  assert.equal(await page.locator('[data-sidebar-header-controls] button').count(), 2,
    'Conversation headers keep both official sidebar and new-session controls')
  mkdirSync(screenshots, { recursive: true })
  await page.screenshot({ path: join(screenshots, 'new-session-collapsed.png'), animations: 'disabled' })
  // A tray/shortcut request activates the official Settings trigger even with the sidebar collapsed.
  await page.evaluate(() => window.__nextTestOpenSettings('general'))
  await page.getByRole('dialog', { name: /^(设置|Settings)$/ }).waitFor()
  assert.equal(await context.pages().length, 1, 'Settings must stay inside the existing app window')
  await page.evaluate(() => window.__nextTestOpenSettings('general'))
  assert.equal(await page.getByRole('dialog', { name: /^(设置|Settings)$/ }).count(), 1)
  await page.getByRole('button', { name: /^(关闭|Close)$/ }).click()
  await expand()

  // A transparent caption belongs to the frame, not the scrolling Plugins header.
  await page.getByRole('button', { name: /^(插件|Plugins)$/ }).click()
  await page.locator('[data-plugin-panel]').waitFor({ state: 'visible' })
  const controls = page.locator('[data-next-plugin-controls]')
  await controls.waitFor({ state: 'visible' })
  for (const name of ['dsh-community-market', 'dshmarket', '@agents-anywhere/dsh-bridge-next']) {
    assert.equal(await page.locator(`[data-plugin-package="${name}"]`).count(), 0)
  }
  assert.equal(await page.locator('[data-plugin-item="desktop-next-computer-use"]').count(), 0)
  const markets = controls.getByRole('radiogroup', { name: /插件市场|Plugin market/ })
  assert.equal(await markets.getByRole('radio').count(), 2)
  const communityChoice = markets.getByRole('radio', { name: /dsh-community-market/ })
  const dshChoice = markets.getByRole('radio', { name: /dsh-market/ })
  const assertMarketStyles = async stage => {
    assert.equal(await page.locator('#dsh-desktop-settings-styles').getAttribute('data-plugin'), 'dsh-desktop-next',
      `Shared settings CSS belongs to Next ${stage}, never to whichever optional plugin loads next`)
    const styles = await markets.getByRole('radio').evaluateAll(choices => choices.map(choice => ({
      display: getComputedStyle(choice).display,
      padding: getComputedStyle(choice).padding,
      borderRadius: getComputedStyle(choice).borderRadius,
    })))
    assert.deepEqual(styles, Array(2).fill({ display: 'flex', padding: '13px 14px', borderRadius: '10px' }),
      `Market choices retain their stylesheet ${stage}`)
  }
  await assertMarketStyles('on initial load')
  await communityChoice.getByText('DSH Desktop 内置的开放插件市场，支持添加和选择自定义插件数据源。').waitFor()
  assert.equal(await dshChoice.getByRole('link', { name: 'awesome-dsh-plugin', exact: true }).count(), 1)
  const waitSelected = async choice => {
    await page.waitForFunction(selector => {
      const choice = document.querySelector(selector)
      return choice?.getAttribute('aria-checked') === 'true' && choice.getAttribute('aria-disabled') !== 'true'
    }, choice)
  }
  await communityChoice.click({ position: { x: 10, y: 10 } })
  await waitSelected('[data-next-markets] [role="radio"]:first-child')
  await assertMarketStyles('after enabling Community Market')
  const marketFooter = footer.getByRole('button', { name: /插件市场|Plugin market/ })
  await marketFooter.waitFor()
  // Exercise pointer selection and optional-plugin teardown before AA can load
  // and accidentally claim an untagged settings sheet for its own lifetime.
  await dshChoice.click({ position: { x: 10, y: 10 } })
  await waitSelected('[data-next-markets] [role="radio"]:last-child')
  await assertMarketStyles('after the first pointer switch')
  await communityChoice.click({ position: { x: 10, y: 10 } })
  await waitSelected('[data-next-markets] [role="radio"]:first-child')
  await assertMarketStyles('after unloading the first dsh-market instance')
  await marketFooter.waitFor()
  const remote = controls.getByRole('switch', { name: /启用远程控制|Enable remote control/ })
  const remoteGear = controls.locator('[data-next-remote-control]').getByRole('button', { name: /^(打开面板|Open panel)$/ })
  assert.equal(await remote.isChecked(), false)
  assert.equal(await remoteGear.isDisabled(), true)
  await remote.click()
  await waitSelected('[data-next-remote-control] [role="switch"]')
  await footer.getByRole('button', { name: /^(远程控制|Remote Control|手机连接|Mobile connection)$/ }).waitFor()
  await remoteGear.click()
  const remoteDialog = page.getByRole('dialog', { name: /^(远程控制|Remote Control|手机连接|Mobile connection|Agents Anywhere)$/ })
  await remoteDialog.waitFor()
  assert.equal(await remoteDialog.getByRole('tablist', { name: '连接管理' }).count(), 1)
  assert.equal(await context.pages().length, 1)
  await remoteDialog.getByRole('button', { name: /^(关闭远程控制|Close Remote Control|关闭手机连接)$/ }).click()
  await remoteDialog.waitFor({ state: 'hidden' })
  await dshChoice.focus()
  await page.waitForFunction(() => document.activeElement === document.querySelector('[data-next-markets] [role="radio"]:last-child'))
  await dshChoice.press('Space')
  await waitSelected('[data-next-markets] [role="radio"]:last-child')
  await assertMarketStyles('after switching to dsh-market')
  assert.equal(await communityChoice.getAttribute('aria-checked'), 'false')
  assert.equal(await remote.isChecked(), true)
  await marketFooter.waitFor({ state: 'hidden' })
  await openSettingsPanel()
  await page.getByRole('dialog').getByRole('button', { name: /^(插件市场|Plugin Market)$/ }).click()
  // Exercise the real third-party page, not just its registration or toggle. Older
  // dshmarket bundles reference removed icon exports and crash only when rendered.
  await page.locator('[data-dsh-market-root]').waitFor({ state: 'visible' })
  assert.ok(await page.locator('[data-dsh-market-root] svg').count() > 0)
  assert.deepEqual(errors, [])
  await page.getByRole('button', { name: /^(关闭|Close)$/ }).click()
  await assertMarketStyles('after opening and closing dsh-market')
  await communityChoice.click({ position: { x: 10, y: 10 } })
  await waitSelected('[data-next-markets] [role="radio"]:first-child')
  await assertMarketStyles('after switching back to Community Market')
  assert.equal(await dshChoice.getAttribute('aria-checked'), 'false')
  assert.equal(await remote.isChecked(), true)
  await marketFooter.waitFor()
  // A failed Host mutation must leave the current market visibly selected.
  await context.route('**/api/pluginManager/setBundleEnabled', async route => {
    const request = route.request().postDataJSON()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'server-response', rpcId: request.rpcId,
      result: { ok: true, value: { changed: false, application: 'failed', stage: 'enable', target: 'dshmarket',
        error: { code: 'operation-error', diagnostic: 'Fixture: market change rejected' } } },
    }) })
  }, { times: 1 })
  await dshChoice.click({ position: { x: 10, y: 10 } })
  await controls.getByRole('alert').getByText('Fixture: market change rejected', { exact: false }).waitFor()
  assert.equal(await communityChoice.getAttribute('aria-checked'), 'true')
  await controls.getByRole('button', { name: /^(重试|Retry)$/ }).click()
  await controls.getByRole('alert').waitFor({ state: 'hidden' })
  const cuaSettings = controls.locator('[data-next-computer-use]')
  // The overview now uses compact plugin rows; runtime status lives on the detail page.
  const checkCuaStatus = async status => {
    await controls.getByRole('button', { name: /^Computer Use — / }).click()
    await page.locator('[data-next-computer-use]').getByRole('status').getByText(status).waitFor()
    await page.getByRole('button', { name: /^(返回插件列表|Back to plugins)$/ }).click()
    await controls.waitFor({ state: 'visible' })
    await page.waitForFunction(() => {
      const toggle = document.querySelector('[data-next-plugin-controls] [data-next-computer-use] [role="switch"]')
      return toggle instanceof HTMLButtonElement && !toggle.disabled && toggle.getAttribute('aria-disabled') !== 'true'
    })
  }
  await checkCuaStatus(/^(已停用|Disabled)$/)
  const cuaSwitch = cuaSettings.getByRole('switch', { name: /启用 Computer Use|Enable Computer Use/ })
  assert.equal(await cuaSwitch.isChecked(), false)
  assert.equal(await cuaSwitch.isDisabled(), false)
  const firstGroup = page.locator('[data-plugin-group]').first()
  const topBox = await controls.boundingBox()
  const groupBox = await firstGroup.boundingBox()
  assert.ok(topBox.y + topBox.height <= groupBox.y, 'Special controls belong above ordinary plugin groups')
  assert.ok(Math.abs(topBox.x - groupBox.x) < 1 && Math.abs(topBox.width - groupBox.width) < 1,
    'Overview controls must fill the same content width as the official plugin list')
  const remoteBox = await controls.locator('[data-next-remote-control]').boundingBox()
  const cuaBox = await cuaSettings.boundingBox()
  assert.ok(cuaBox.y >= remoteBox.y + remoteBox.height, 'Remote control and Computer Use must be stacked vertically')
  assert.equal(cuaBox.x, remoteBox.x)
  const permissionGear = cuaSettings.getByRole('button', { name: /^(权限设置|Permission settings)$/ })
  assert.match((await permissionGear.textContent()).trim(), /^(权限设置|Permission settings)$/, 'Permissions uses a visible, accessible action label')
  const switchBox = await cuaSwitch.boundingBox()
  const gearBox = await permissionGear.boundingBox()
  assert.ok(Math.abs(gearBox.y + gearBox.height / 2 - switchBox.y - switchBox.height / 2) < 1)
  assert.ok(switchBox.x >= gearBox.x + gearBox.width && switchBox.x - gearBox.x - gearBox.width <= 12,
    'The permission action must sit immediately to the left of the Computer Use switch')
  await page.locator('[data-plugin-panel]').evaluate(element => { for (let node = element; node; node = node.parentElement) node.scrollTop = 0 })
  await page.screenshot({ path: join(screenshots, 'plugin-controls.png'), animations: 'disabled' })
  await permissionGear.click()
  const permissionDialog = page.getByRole('dialog', { name: /^(系统权限|System permissions)$/ })
  await permissionDialog.getByRole('group', { name: /屏幕录制|Screen recording/ }).getByText(/已拒绝|Denied/).waitFor()
  assert.equal(await permissionDialog.getByRole('group').count(), 3)
  assert.ok(permissionActions.every(item => item.action === 'query'), 'Opening the dialog must never prompt for permissions')
  assert.equal(await dragRegion(), 'no-drag')
  await page.screenshot({ path: join(screenshots, 'plugin-permissions.png'), animations: 'disabled' })
  await permissionDialog.press('Escape')
  await permissionDialog.waitFor({ state: 'hidden' })
  await page.evaluate(() => window.__nextTestOpenSettings('permissions'))
  await permissionDialog.getByRole('group', { name: /屏幕录制|Screen recording/ }).getByText(/已拒绝|Denied/).waitFor()
  await page.evaluate(() => window.__nextTestOpenSettings('permissions'))
  assert.equal(await permissionDialog.count(), 1)
  assert.equal(await context.pages().length, 1)
  assert.ok(permissionActions.every(item => item.action === 'query'))
  await permissionDialog.press('Escape')
  await permissionDialog.waitFor({ state: 'hidden' })
  if (process.argv.includes('--computer-use')) {
    // Explicit native SDK activation in a temporary Profile; no driver tool is called.
    await cuaSwitch.click()
    await checkCuaStatus(/^(运行中|Running)$/)
    assert.equal(await cuaSwitch.isChecked(), true)
    await page.getByRole('button', { name: /^(新建会话|New session)$/i }).last().click()
    await page.getByRole('button', { name: /^(插件|Plugins)$/ }).click()
    await checkCuaStatus(/^(运行中|Running)$/)
    assert.equal(await remote.isChecked(), true)
    assert.equal(await communityChoice.getAttribute('aria-checked'), 'true')
    await cuaSwitch.click()
    await checkCuaStatus(/^(已停用|Disabled)$/)
    assert.equal(await cuaSwitch.isChecked(), false)
    console.log('Cua native provider independently enabled and disabled from the Plugins overview; no input, screenshots or OS permission requests sent.')
  }
  await checkDrag()
  const refresh = page.getByRole('button', { name: /^(刷新|Refresh)$/ })
  assert.equal(await refresh.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region')), 'no-drag')
  await refresh.click()
  const pluginPanel = page.locator('[data-plugin-panel]')
  const pluginHeader = page.locator('[data-plugin-page-header="list"]')
  const checkPluginReopen = async () => {
    await reopen.waitFor({ state: 'visible' })
    await page.waitForFunction(() => Number.parseFloat(getComputedStyle(document.querySelector('[data-shell-overlay]').parentElement).gridTemplateColumns) === 0)
    // dsh 0.1.7 moved the occupant out of the per-page `plugins.header.leading` seat into the
    // frame's `shell.leading` seat, which renders both controls whatever page is showing.
    assert.equal(await page.locator('[data-sidebar-header-controls] button').count(), 2,
      'Plugins reuses the frame window-chrome seat with both sidebar and new-session controls')
    const geometry = await reopen.evaluate(button => {
      const box = button.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height,
        inPageHeader: !!button.closest('[data-plugin-page-header]'),
        clickable: button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)),
        region: getComputedStyle(button).getPropertyValue('-webkit-app-region') }
    })
    // 0.1.7 positions that seat itself (`.leadingSeat` at top 11px / left 88px), so the seat's own
    // offset now decides the placement instead of Desktop's `[data-plugin-sidebar-control]` rule.
    assert.deepEqual(geometry, { x: 88, y: 11, width: 28, height: 28,
      inPageHeader: false, clickable: true, region: 'no-drag' },
    'The official toggle stays beside the native traffic lights, independently of the centered content and scrolling')
  }
  const checkPluginCaption = async () => {
    const geometry = await drag.evaluate(column => {
      const panel = column.querySelector('[data-plugin-panel]')
      const header = panel.querySelector('[data-plugin-page-header]')
      const box = column.getBoundingClientRect()
      const pageBox = panel.getBoundingClientRect()
      const style = getComputedStyle(column, '::before')
      return { left: box.left, top: box.top, width: Number.parseFloat(style.width), height: Number.parseFloat(style.height),
        pageLeft: pageBox.left, pageTop: pageBox.top, pageWidth: panel.clientWidth,
        insetTop: style.top, insetLeft: style.left, insetRight: style.right,
        region: style.getPropertyValue('-webkit-app-region'), pointerEvents: style.pointerEvents,
        background: style.backgroundColor, headerPosition: getComputedStyle(header).position,
        headerRegion: getComputedStyle(header).getPropertyValue('-webkit-app-region') }
    })
    assert.equal(geometry.region, 'drag')
    assert.ok(Math.abs(geometry.left - geometry.pageLeft) <= 1, JSON.stringify(geometry))
    assert.ok(Math.abs(geometry.top - geometry.pageTop) < 1, JSON.stringify(geometry))
    assert.ok(Math.abs(geometry.width - geometry.pageWidth) < 1, JSON.stringify(geometry))
    assert.equal(geometry.height, 52)
    assert.deepEqual([geometry.insetTop, geometry.insetLeft, geometry.insetRight], ['0px', '0px', '0px'])
    assert.equal(geometry.pointerEvents, 'none', 'The caption must not intercept DOM clicks')
    assert.equal(geometry.background, 'rgba(0, 0, 0, 0)', 'The caption must not paint over page content')
    assert.equal(geometry.headerPosition, 'static', 'Keep the official header in normal document flow')
    assert.equal(geometry.headerRegion, 'drag', 'rc.2 keeps the official plugin header as a data-window-drag row')
  }
  await checkPluginCaption()
  const titleBox = await pluginHeader.getByRole('heading', { level: 1 }).boundingBox()
  const contentBox = await controls.boundingBox()
  assert.ok(Math.abs(titleBox.x - contentBox.x) < 1, 'The official plugin title stays aligned with its content')
  // 0.1.7 pads the official plugin page head by `--dsh-frame-top-clearance` (48px on darwin),
  // so the title now clears the caption band instead of scrolling underneath it.
  const frameClearance = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-top-clearance')) || 0)
  assert.equal(titleBox.y, 28 + frameClearance, 'The caption must preserve the official title position')
  await page.setViewportSize({ width: 1800, height: 840 })
  await checkPluginCaption()
  assert.ok(Math.abs((await pluginHeader.getByRole('heading', { level: 1 }).boundingBox()).x - (await controls.boundingBox()).x) < 1,
    'A wide window keeps the title aligned with the centered content column')
  const addPlugin = page.getByRole('button', { name: /^(添加插件|Add plugin)$/ })
  assert.equal(await addPlugin.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region')), 'no-drag')
  await addPlugin.click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('dialog').press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.setViewportSize({ width: 1280, height: 480 })
  const beforeScroll = await pluginHeader.boundingBox()
  await pluginPanel.evaluate(element => { element.scrollTop = 220 })
  const scrollTop = await pluginPanel.evaluate(element => element.scrollTop)
  assert.ok(scrollTop > 0)
  assert.ok(Math.abs((await pluginHeader.boundingBox()).y - beforeScroll.y + scrollTop) < 1,
    'The official plugin header keeps its original scrolling behavior')
  await checkPluginCaption()
  // Scroll a real control into the fixed caption, then exercise its dialog.
  const remoteGearY = (await remoteGear.boundingBox()).y
  await pluginPanel.evaluate((element, delta) => { element.scrollTop += delta }, remoteGearY - 16)
  assert.ok((await remoteGear.boundingBox()).y < 52)
  assert.equal(await remoteGear.evaluate(element => getComputedStyle(element).getPropertyValue('-webkit-app-region')), 'no-drag')
  await remoteGear.click()
  await remoteDialog.waitFor()
  await remoteDialog.getByRole('button', { name: /^(关闭远程控制|Close Remote Control|关闭手机连接)$/ }).click()
  await page.screenshot({ path: join(screenshots, 'plugins-scrolled.png'), animations: 'disabled' })
  await pluginPanel.evaluate(element => { element.scrollTop = 0 })
  await page.setViewportSize({ width: 1280, height: 840 })
  await page.locator('[data-plugin-item]').first().getByRole('button').first().click()
  const detailHeader = page.locator('[data-plugin-page-header="detail"]')
  await detailHeader.waitFor()
  await checkPluginCaption()
  await collapse.click()
  await checkPluginCaption()
  await checkPluginReopen()
  await expand()
  await detailHeader.click()
  await controls.waitFor({ state: 'visible' })
  await collapse.click()
  for (const width of [1800, 800, 1280]) {
    await page.setViewportSize({ width, height: 840 })
    await checkPluginCaption()
    await checkPluginReopen()
    assert.ok(await pluginPanel.evaluate(panel => Math.abs(panel.querySelector('h1').getBoundingClientRect().x
      - panel.querySelector('[data-next-plugin-controls]').getBoundingClientRect().x) < 1),
      'Collapsing the sidebar must not shift the official title away from its content')
    if (width === 800) await page.screenshot({ path: join(screenshots, 'plugins-collapsed-narrow.png'), animations: 'disabled' })
  }
  await addPlugin.click()
  await page.getByRole('dialog').waitFor()
  assert.equal(await dragRegion(), 'no-drag')
  assert.equal(await page.evaluate(() => !!document.elementFromPoint(102, 26)?.closest('[data-plugin-sidebar-control]')), false,
    'The fixed sidebar toggle must not sit above a modal')
  await page.getByRole('dialog').press('Escape')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await page.screenshot({ path: join(screenshots, 'plugins-collapsed.png'), animations: 'disabled' })
  await page.setViewportSize({ width: 1280, height: 480 })
  await pluginPanel.evaluate(element => { element.scrollTop = 220 })
  assert.ok(await pluginPanel.evaluate(element => element.scrollTop) > 0)
  await checkPluginReopen()
  await expand()
  await page.setViewportSize({ width: 1280, height: 840 })
  // Re-entering the homepage must retain a working sidebar action after navigation.
  await page.getByRole('button', { name: /^(新建会话|New session)$/i }).last().click()
  await collapse.click()
  await expand()
  // Selecting a real temporary Workspace mounts the normal strict-Session header.
  const emptyHeaderClass = await page.locator('[data-conversation-header]').getAttribute('class')
  await page.getByRole('button', { name: /^(选择工作区|Select workspace)$/ }).click()
  await page.locator('[data-conversation-header]').waitFor()
  assert.equal(await page.locator('[data-conversation-header]').getAttribute('class'), emptyHeaderClass,
    'The unbound and blank Session states share the exact official header frame')
  assert.equal(await page.locator('[data-conversation-header]').count(), 1)
  await checkDrag()
  await collapse.click()
  await reopen.waitFor({ state: 'visible' })
  await page.screenshot({ path: join(screenshots, 'blank-session-collapsed.png'), animations: 'disabled' })
  await expand()
  await verifySidebarBrowser(page, nativeBrowser, screenshots)

  // Other platforms retain their own native chrome; no macOS drag region leaks through.
  for (const platform of ['win32', 'linux']) {
    await page.evaluate(value => { document.documentElement.dataset.platform = value }, platform)
    assert.notEqual(await dragRegion(), 'drag')
    await reopen.waitFor({ state: 'hidden' })
  }
  await page.evaluate(() => { document.documentElement.dataset.platform = 'darwin' })
  await openSettingsPanel()
  // Native shortcuts appear on every official Settings section, like the original Desktop.
  const actions = page.locator('.dshDesktopNativeActions[data-placement="settings"]')
  await actions.getByRole('button', { name: /^(打开 DSH 终端|Open DSH Terminal)$/ }).click()
  assert.equal(controlCommands.at(-1).type, 'terminal')
  const restartOptions = actions.getByRole('button', { name: /^(重启|Restart)$/ })
  await restartOptions.click()
  await actions.getByRole('menu').press('Escape')
  assert.equal(await actions.getByRole('menu').count(), 0)
  assert.equal(await restartOptions.evaluate(element => element === document.activeElement), true)
  await restartOptions.press('ArrowDown')
  await actions.getByRole('menuitem', { name: /^(重启到恢复模式|Restart in Recovery Mode)$/ }).click()
  assert.equal(controlCommands.at(-1).type, 'restart-recovery')
  await page.getByRole('button', { name: /^(桌面设置|Desktop settings)$/ }).click()
  const settings = page.locator('[data-next-desktop-settings]')
  await settings.getByRole('heading', { name: /^(DSH Desktop 设置|DSH Desktop Settings)$/ }).waitFor()
  const pluginNotice = settings.locator('[data-next-plugin-settings-notice]')
  await pluginNotice.getByText('插件市场和远程控制设置已移至插件页面。', { exact: true }).waitFor()
  await page.screenshot({ path: join(screenshots, 'desktop-plugin-settings-notice.png'), animations: 'disabled' })
  await pluginNotice.getByRole('button', { name: /^(前往插件页面|Go to Plugins)$/ }).click()
  await page.getByRole('dialog', { name: /^(设置|Settings)$/ }).waitFor({ state: 'hidden' })
  await page.locator('[data-plugin-panel]').waitFor({ state: 'visible' })
  await controls.waitFor({ state: 'visible' })
  assert.equal(await context.pages().length, 1, 'Leaving Settings for Plugins must reuse the main window')
  await openSettingsPanel()
  await page.getByRole('button', { name: /^(桌面设置|Desktop settings)$/ }).click()
  await settings.getByRole('heading', { name: /^(DSH Desktop 设置|DSH Desktop Settings)$/ }).waitFor()
  assert.equal(await settings.locator('nav').count(), 0)
  const updateSection = settings.locator('[data-next-updates]')
  await updateSection.getByRole('button', { name: /检查更新|Check for updates/ }).click()
  assert.equal(controlCommands.at(-1).type, 'check-updates')
  controlState.updates = { phase: 'downloading', version: '2.0.17-next.1', installable: true, received: 50, total: 100 }
  await updateSection.getByText(/正在下载更新 50%|Downloading update 50%/).waitFor()
  assert.equal(await updateSection.locator('progress').getAttribute('value'), '50')
  await updateSection.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(screenshots, 'desktop-update-progress.png'), animations: 'disabled' })
  controlState.updates = { phase: 'ready', version: '2.0.17-next.1', installable: true }
  await updateSection.getByRole('button', { name: /安装并重启|Install and restart/ }).click()
  assert.equal(controlCommands.at(-1).type, 'install-update')
  controlState.updates = { phase: 'idle', installable: true }
  const setupWizard = settings.getByRole('button', { name: /^(设置向导|Setup wizard)$/ })
  await setupWizard.click()
  assert.equal(controlCommands.at(-1).type, 'restart-onboarding')
  assert.equal(await setupWizard.evaluate(button => button === button.parentElement.firstElementChild), true)
  await page.waitForFunction(() => [...document.querySelectorAll('[data-next-desktop-settings] button')].some(button => /^(设置向导|Setup wizard)$/.test(button.textContent) && !button.disabled))
  controlState.safeMode = true
  await page.waitForFunction(() => [...document.querySelectorAll('[data-next-desktop-settings] button')].some(button => /^(设置向导|Setup wizard)$/.test(button.textContent) && button.disabled))
  controlState.safeMode = false
  await page.waitForFunction(() => [...document.querySelectorAll('[data-next-desktop-settings] button')].some(button => /^(设置向导|Setup wizard)$/.test(button.textContent) && !button.disabled))
  await settings.locator('.dshDesktopSettingsGroup').filter({ has: page.getByRole('heading', { name: /^(桌面工具|Desktop tools)$/ }) }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(screenshots, 'desktop-setup-wizard-entry.png'), animations: 'disabled' })
  assert.equal(await settings.getByRole('radio', { name: /^broken/ }).getAttribute('aria-disabled'), 'true')
  assert.equal(await settings.getByRole('radio', { name: /增强模式|扩展模式|Advanced mode|Extended mode/ }).count(), 0)
  assert.equal(await settings.locator('#dsh-desktop-market-title, #dsh-desktop-aa-title').count(), 0)
  const closeToTray = settings.getByRole('switch', { name: /关闭窗口后保持后台运行|Keep running after closing the window/ })
  assert.equal(await closeToTray.isChecked(), true)
  await closeToTray.click()
  await page.waitForFunction(() => !document.querySelector('.dshDesktopSettingsGroup:last-child button')?.disabled)
  assert.ok(controlCommands.some(command => command.type === 'preferences' && !command.preferences.closeToTray))
  assert.equal(await settings.getByRole('heading', { name: /^(端口设置|Port settings)$/ }).count(), 0)
  assert.equal(await settings.getByRole('spinbutton').count(), 0)
  const notifications = settings.getByRole('switch', { name: /启用桌面通知|Enable Desktop notifications/ })
  assert.equal(await settings.getByRole('switch', { name: /后台任务|Background job/ }).count(), 0)
  const permissions = settings.getByRole('region', { name: /系统权限|System permissions/ })
  await permissions.getByRole('button', { name: /^(授权设置|Permissions)$/ }).click()
  const permissionSettings = page.getByRole('dialog', { name: /^(系统权限|System permissions)$/ })
  const microphone = permissionSettings.getByRole('group', { name: /麦克风|Microphone/ })
  await microphone.getByRole('button', { name: /请求授权|Request access/ }).waitFor()
  await page.screenshot({ path: join(screenshots, 'desktop-permissions.png'), animations: 'disabled' })
  assert.ok(permissionActions.every(item => item.action === 'query'), 'Rendering settings must never prompt for permissions')
  await microphone.getByRole('button', { name: /请求授权|Request access/ }).click()
  await microphone.getByText(/已允许|Allowed/).waitFor()
  const screen = permissionSettings.getByRole('group', { name: /屏幕录制|Screen recording/ })
  await screen.getByRole('button', { name: /打开系统设置|Open system settings/ }).click()
  assert.ok(permissionActions.some(item => item.action === 'openSettings' && item.permission === 'screen'))
  await screen.getByText(/已拒绝|Denied/).waitFor()
  await permissionSettings.getByRole('button', { name: /^(关闭|Close)$/ }).click()
  await notifications.click()
  await page.waitForFunction(() => document.querySelector('[aria-labelledby="dsh-desktop-notifications-title"] [role="switch"]')?.getAttribute('aria-checked') === 'false')
  assert.equal(await settings.getByRole('switch', { name: /本轮任务完成|Current turn completed/ }).isDisabled(), true)
  assert.ok(controlCommands.some(command => command.type === 'preferences' && !command.preferences.notifications && !command.preferences.closeToTray))
  rejectPreference = true
  await closeToTray.click()
  await settings.getByText('Fixture: preference save rejected').waitFor()
  assert.equal(await closeToTray.isChecked(), false)
  controlState.platform = 'win32'
  await settings.locator('.dshDesktopSettingsMaterialField select').first().locator('option[value="transparent"]').waitFor({ state: 'detached' })
  // Windows offers no window material, so the material selector disappears entirely.
  assert.equal(await settings.locator('option[value="transparent"]').count(), 0)
  controlState.platform = 'linux'
  await actions.getByRole('button', { name: /打开 DSH 终端|Open DSH Terminal/ }).waitFor({ state: 'hidden' })
  controlState.platform = 'darwin'
  await actions.getByRole('button', { name: /打开 DSH 终端|Open DSH Terminal/ }).waitFor({ state: 'visible' })
  // Each local/LAN login link has its own row and native open/copy target.
  const webSettings = settings.locator('section[aria-labelledby="dsh-desktop-web-title"]')
  const browserAccess = webSettings.getByRole('switch', { name: /允许在浏览器中打开|Allow opening this Profile in a browser/ })
  const lanAccess = webSettings.getByRole('switch', { name: /局域网访问|Local-network access/ })
  const loginRows = webSettings.locator('.dshDesktopSettingsUrlRow')
  const exportCa = webSettings.getByRole('button', { name: /导出 CA 证书|Export CA certificate/ })
  assert.equal(await loginRows.count(), 0)
  assert.equal(await settings.getByRole('button', { name: /复制本机登录链接|Copy local login link|复制局域网登录链接|Copy LAN login link/ }).count(), 0)
  await browserAccess.click()
  await loginRows.first().waitFor()
  assert.equal(await loginRows.count(), 1)
  assert.equal(await exportCa.count(), 0)
  await lanAccess.click()
  await loginRows.nth(2).waitFor()
  assert.equal(await loginRows.count(), 3)
  for (const [index, url] of [browserLinks().localUrl, ...browserLinks().lanUrls].entries()) {
    const row = loginRows.nth(index)
    const link = row.getByRole('link')
    assert.equal(await link.textContent(), url)
    assert.equal(await link.getAttribute('href'), url)
    await row.getByRole('button', { name: /复制地址|Copy address/ }).click()
    await row.locator('button[title="已复制"], button[title="Copied"]').waitFor()
    assert.deepEqual(controlCommands.at(-1), { type: 'copy-browser-url', url })
    await link.click()
    assert.deepEqual(controlCommands.at(-1), { type: 'open-browser-url', url })
  }
  await exportCa.click()
  assert.deepEqual(controlCommands.at(-1), { type: 'export-ca' })
  await page.waitForFunction(() => !document.querySelector('.dshDesktopSettingsUrlCopy[title="已复制"], .dshDesktopSettingsUrlCopy[title="Copied"]'))
  await settings.getByRole('heading').first().scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(screenshots, 'desktop-settings.png'), animations: 'disabled' })
  await webSettings.evaluate(element => element.scrollIntoView({ block: 'start' }))
  await page.screenshot({ path: join(screenshots, 'desktop-access-settings.png'), animations: 'disabled' })
  await lanAccess.click()
  await loginRows.nth(1).waitFor({ state: 'hidden' })
  assert.equal(await exportCa.count(), 0)
  assert.equal(await loginRows.count(), 1)
  await browserAccess.click()
  await loginRows.first().waitFor({ state: 'hidden' })
  await settings.locator('#dsh-desktop-notifications-title').scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(screenshots, 'desktop-notification-settings.png'), animations: 'disabled' })
  await settings.getByRole('radio', { name: /^work/ }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('[role="radio"]')].some(el => el.textContent.startsWith('work') && el.getAttribute('aria-checked') === 'true'))
  assert.deepEqual(controlCommands.at(-1), { type: 'switch', name: 'work' })

  // Render the existing Desktop Recovery/Profile pages without a Host.
  recoveryPage = await context.newPage()
  const recoveryErrors = []
  recoveryPage.on('pageerror', error => { recoveryErrors.push(error.message); diagnostics.push('Recovery: ' + error.message) })
  recoveryPage.on('console', message => { if (message.type() === 'error') diagnostics.push('Recovery: ' + message.text()) })
  controlState.phase = 'error'; controlState.failure = 'Fixture: invalid Profile manifest <script>unsafe()</script>'
  await recoveryPage.route('http://next-recovery.test/**', async route => {
    const response = await serveWebDocument(new Request(route.request().url()), join(root, 'lib/native-ui'), false)
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) })
  })
  await recoveryPage.goto('http://next-recovery.test/?locale=zh&platform=darwin&frame=true#recovery')
  await recoveryPage.getByRole('tab', { name: '快速恢复' }).waitFor()
  assert.equal(await recoveryPage.getByText(controlState.failure, { exact: true }).textContent(), controlState.failure)
  assert.equal(await recoveryPage.locator('pre script').count(), 0)
  assert.equal(await recoveryPage.getByRole('tab').count(), 6)
  await recoveryPage.getByRole('link', { name: '退出并重启', exact: true }).click()
  assert.deepEqual(controlCommands.at(-1), { type: 'recovery-action', action: 'restart' })
  await recoveryPage.getByRole('link', { name: '进入安全模式', exact: true }).click()
  assert.equal(controlCommands.at(-1).type, 'safe-mode')
  await recoveryPage.screenshot({ path: join(screenshots, 'recovery-assistant.png'), animations: 'disabled', fullPage: true })
  await recoveryPage.getByRole('tab', { name: /插件/ }).click()
  await recoveryPage.locator('a[href*="preview-uninstall"]').click()
  assert.deepEqual(controlCommands.at(-1), { type: 'recovery-action', action: 'preview-uninstall', id: 'fixture-plugin' })
  await recoveryPage.getByRole('tab', { name: /回滚/ }).click()
  await recoveryPage.locator('a[href*="preview-checkpoint"]').click()
  assert.deepEqual(controlCommands.at(-1), { type: 'recovery-action', action: 'preview-checkpoint', id: 'fixture-checkpoint' })
  await recoveryPage.locator('[data-sonner-toast]').getByText('检查点已恢复', { exact: true }).waitFor()
  await recoveryPage.getByText('配置和所需插件依赖已恢复。请点击“退出并重启”使恢复生效。', { exact: true }).waitFor()
  await recoveryPage.getByRole('tab', { name: /数据/ }).click()
  await recoveryPage.locator('a[href*="begin-change-data-directory"]').click()
  assert.deepEqual(controlCommands.at(-1), { type: 'recovery-action', action: 'begin-change-data-directory' })
  await recoveryPage.getByRole('tab', { name: /诊断/ }).click()
  await recoveryPage.locator('a[href*="open-profile-manifest"]').click()
  assert.deepEqual(controlCommands.at(-1), { type: 'recovery-action', action: 'open-profile-manifest' })
  await recoveryPage.getByRole('link', { name: /保存诊断|导出诊断/ }).click()
  assert.equal(controlCommands.at(-1).type, 'diagnostics')
  assert.deepEqual(recoveryErrors, [])
  await recoveryPage.goto('http://next-recovery.test/?locale=zh&platform=darwin&frame=true#create-profile')
  await recoveryPage.locator('#profile-name').waitFor()
  assert.equal(await recoveryPage.locator('#profile-name').evaluate(element => element === document.activeElement), true)
  await recoveryPage.locator('#profile-name').fill('from-tray')
  await recoveryPage.getByRole('button', { name: /创建/ }).click()
  await recoveryPage.waitForFunction(() => document.querySelector('#profile-name')?.disabled === false)
  assert.deepEqual(controlCommands.slice(-3), [{ type: 'create', name: 'from-tray' }, { type: 'switch', name: 'from-tray' }, { type: 'close-controls' }])
  await recoveryPage.goto('http://next-recovery.test/?locale=zh&platform=darwin&frame=true#profiles')
  await recoveryPage.getByRole('heading', { name: '可用 Profile', exact: true }).first().waitFor()
  await recoveryPage.screenshot({ path: join(screenshots, 'profile-selector.png'), animations: 'disabled' })
  assert.deepEqual(recoveryErrors, [])
  await recoveryPage.close()
  controlState.safeMode = true
  // A reload re-runs the Desktop boot contract, which must pick up the Host's current boot table.
  await page.reload()
  await page.locator('.dshNextSafeModeNotice').waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => globalThis.__NEXT_TEST_BOOT__.calls), 1)
  // 0.1.7 ships a default model and remembers the dismissal, so the reloaded document usually has
  // no credential step left; older cores show one again and it has to be cleared before the notice.
  await page.getByRole('button', { name: /^(稍后配置|Configure later)$/ }).click({ timeout: 2_000 }).catch(() => {})
  await page.locator('.dshNextSafeModeNotice').getByRole('button', { name: /打开恢复助手|Open recovery assistant/ }).click()
  assert.deepEqual(controlCommands.at(-1), { type: 'controls', page: 'recovery' })
  await page.locator('.dshNextSafeModeNotice').getByRole('button', { name: /关闭提示|Dismiss notice/ }).click()
  await page.locator('.dshNextSafeModeNotice').waitFor({ state: 'detached' })
  // The marker-free Web frontend must not inherit any native Settings actions.
  const webContext = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 840 } })
  await webContext.addCookies([{ url: streamBaseUrl, name: cookie.slice(0, cookieSeparator), value: cookie.slice(cookieSeparator + 1) }])
  const webPage = await webContext.newPage()
  webPage.setDefaultTimeout(15_000)
  await webPage.goto(streamBaseUrl)
  const webWelcome = webPage.getByRole('button', { name: /^(继续|Continue)$/ })
  await webWelcome.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {})
  if (await webWelcome.isVisible()) await webWelcome.click()
  // The rc.2 Web entry can open directly when the default model is available.
  await webPage.getByRole('button', { name: /^(稍后配置|Configure later)$/ }).click({ timeout: 2_000 }).catch(() => {})
  await webPage.locator('[aria-modal=true]').waitFor({ state: 'hidden' })
  await openSettingsPanel(webPage)
  assert.equal(await webPage.locator('.dshDesktopNativeActions').count(), 0)
  assert.equal(await webPage.getByRole('button', { name: /^(桌面设置|Desktop settings)$/ }).count(), 0)
  assert.equal(await webPage.evaluate(() => window.desktopNext === undefined), true)
  assert.equal(await webPage.evaluate(() => globalThis.__DSH_TRANSPORT__?.ownsHost === true), false)
  assert.equal(await webPage.evaluate(() => window.dshDesktop === undefined), true)
  assert.equal(await webPage.locator('#dsh-desktop-sidebar-footer-styles').count(), 0)
  await webPage.getByRole('button', { name: /^(关闭|Close)$/ }).click()
  await webPage.getByRole('button', { name: /^(插件|Plugins)$/ }).click()
  await webPage.locator('[data-next-plugin-controls]').waitFor()
  await webPage.locator('[data-next-computer-use]').getByRole('button', { name: /^(权限设置|Permission settings)$/ }).click()
  await webPage.getByRole('dialog', { name: /^(系统权限|System permissions)$/ }).getByText(/请在运行 DSH 的桌面应用中管理系统权限/).waitFor()
  await webPage.getByRole('dialog', { name: /^(系统权限|System permissions)$/ }).press('Escape')
  await verifyWebBrowserFallback(webPage)
  await webContext.close()
  assert.deepEqual(errors, [])
  assert.deepEqual(await page.evaluate(() => globalThis.__NEXT_TEST_BOOT__.failures), [])
  console.log('Next window controls passed through the official 0.2.0-rc.2 Desktop boot branch: stacked sidebar extension entries, homepage/plugin collapse and reopen, navigation, caption geometry, clickable actions, existing-header and platform isolation, official Settings header shortcuts and keyboard navigation, grouped Desktop Settings and immediate saves, per-address login URL rows with exact open/copy targets, Profile cards and tray creation, the Host-independent recovery artifact, and native Browser toolbar, navigation, pane geometry, overlay isolation, tab lifetime and Web iframe fallback. Chromium simulates the preload contract; native Electron window movement and page loading are not tested here.')
  console.log(`Screenshots: ${screenshots}`)
} catch (error) {
  console.error(error)
  if (recoveryPage && !recoveryPage.isClosed()) {
    await recoveryPage.screenshot({ path: join(screenshots, 'recovery-failure.png') }).catch(capture => console.error(capture.message))
    console.error(await recoveryPage.locator('body').innerText())
  }
  if (page && !page.isClosed()) {
    console.error(diagnostics)
    mkdirSync(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, 'failure.png') }).catch(capture => console.error(capture.message))
    console.error(await page.evaluate(() => {
      const controls = document.querySelector('[data-conversation-title-row], [data-plugin-page-header]')
      const parents = []
      for (let node = controls; node && parents.length < 5; node = node.parentElement) {
        parents.push({ tag: node.tagName, class: node.className, display: getComputedStyle(node).display,
          columns: getComputedStyle(node).gridTemplateColumns, attributes: [...node.attributes].map(a => [a.name, a.value]) })
      }
      return { platform: document.documentElement.dataset.platform,
        headers: document.querySelectorAll('[data-conversation-header-leading]').length,
        dialogs: document.querySelectorAll('[aria-modal=true]').length, parents }
    }))
  }
  throw error
} finally {
  shortcutPreferences.dispose()
  await browser?.close()
  await host.stop()
  rmSync(home, { recursive: true, force: true })
}
