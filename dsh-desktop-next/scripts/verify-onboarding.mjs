/** Exercise Desktop continuation in the actual official frontend and Loader, in a temporary home. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { DesktopHostProcess } from '../lib/host-process.js'
import { NextProfiles } from '../lib/profiles.js'
import { authenticateWebHost, serveWebDocument } from '../lib/web-document.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const webRoot = dirname(require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html'))
const home = mkdtempSync(join(tmpdir(), 'dsh-official-onboarding-'))
const profiles = new NextProfiles(home)
profiles.ensure('desktop')
profiles.setFeatures('desktop', { market: false, remoteControl: false })
// Exercise both fresh official progress and an already completed official flow.
// Desktop eligibility must not depend on either condition.
const officialPending = process.argv.includes('--official-pending')
writeFileSync(join(profiles.directory('desktop'), 'cordis.patch.yml'), JSON.stringify([
  { id: 'ui-settings-account', config: { step: officialPending ? 'welcome' : 'done', completion: officialPending ? null : 'skipped' } },
]), { mode: 0o600 })
const host = new DesktopHostProcess(process.execPath, root, profiles.directory('desktop'), undefined,
  { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, undefined, undefined, undefined, join(root, 'lib/host.js'))
const screenshots = join(root, '.desktop-next/verification')
mkdirSync(screenshots, { recursive: true })
let browser, page
let required = true, accountPending = false, rejectDismiss = true, rejectSave = false, rejectRead = true
const finishes = [], errors = []
const selection = { mode: 'compatibility', macosMaterial: 'off', windowsMaterial: 'off', openBrowser: false,
  networkExposure: 'loopback', market: 'community-market', aaEnabled: false,
  notifications: { enabled: true, notifyOnTurnCompletion: true, notifyOnTurnFailure: true, notifyOnJobCompletion: false, notifyOnJobFailure: false } }
try {
  const ready = await host.start()
  const origin = new URL(ready.url).origin
  const cookie = await authenticateWebHost(ready.url), separator = cookie.indexOf('=')
  const document = await (await serveWebDocument(new Request('dsh-app://app/'), webRoot)).text()
  browser = await chromium.launch({ headless: true, ...(process.env.DSH_NEXT_TEST_BROWSER_CHANNEL ? { channel: process.env.DSH_NEXT_TEST_BROWSER_CHANNEL } : {}) })
  const context = await browser.newContext({ viewport: { width: 1040, height: 720 }, locale: 'zh-CN', colorScheme: 'dark' })
  await context.grantPermissions(['local-network-access'], { origin })
  await context.addCookies([{ url: origin, name: cookie.slice(0, separator), value: cookie.slice(separator + 1) }])
  await context.route(origin + '/', route => route.fulfill({ contentType: 'text/html', body: document }))
  await context.exposeFunction('__boot', async () => ({ injections: await host.collectInjections(), streamBaseUrl: origin }))
  await context.exposeFunction('__bootFailed', message => { errors.push(message) })
  await context.exposeFunction('__readSetup', () => {
    if (rejectRead) { rejectRead = false; throw new Error('Fixture: setup state unavailable') }
    return { required, accountPending, edition: 'next', profile: 'desktop', computerUse: false,
      input: { ...selection, appVersion: '2.0.14-next', platform: 'darwin', profileName: 'desktop' } }
  })
  await context.exposeFunction('__finishSetup', (profile, value) => {
    if (rejectSave) { rejectSave = false; throw new Error('Fixture: could not save Profile') }
    finishes.push({ profile, selection: value }); required = false; accountPending = value !== undefined
  })
  await context.exposeFunction('__dismissAccount', profile => {
    assert.equal(profile, 'desktop')
    if (rejectDismiss) { rejectDismiss = false; throw new Error('Fixture: account choice save failed') }
    accountPending = false
  })
  await context.addInitScript(() => {
    globalThis.dshDesktop = { protocolVersion: 1 }
    globalThis.dshDesktopBoot = { ready: () => globalThis.__boot(), failed: message => globalThis.__bootFailed(message) }
    globalThis.dshDesktopSetup = { read: () => globalThis.__readSetup(), finish: (profile, value) => globalThis.__finishSetup(profile, value), dismissAccount: profile => globalThis.__dismissAccount(profile) }
  })
  page = await context.newPage(); page.setDefaultTimeout(20_000)
  page.on('pageerror', error => errors.push(error.stack ?? error.message))
  const surface = page.locator('[data-desktop-onboarding="desktop-extension"]')
  const captureAccount = async name => {
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => {})))
    })
    await page.screenshot({ path: join(screenshots, name) })
  }
  const navigate = async (name, delta) => {
    const current = Number(await surface.locator('[data-page]').getAttribute('data-page'))
    await surface.getByRole('button', { name }).click()
    await surface.locator(`[data-page="${current + delta}"]`).waitFor()
  }
  const next = () => navigate(/^(下一步|Continue)$/, 1)
  const finish = () => surface.getByRole('button', { name: /^(完成并开始|Finish and start)$/ }).click()
  const skip = () => surface.getByRole('button', { name: /^(跳过|Skip)$/ }).click()
  const back = () => navigate(/^(上一步|Back)$/, -1)
  const open = async () => {
    await page.goto(origin); await surface.waitFor()
    // Activate native macOS CSS after the browser-only Host boot (which has no
    // native shortcut service). Click tests alone do not cover app drag regions.
    await page.evaluate(() => { document.documentElement.dataset.platform = 'darwin' })
  }
  await open()
  await surface.getByRole('alert').filter({ hasText: 'setup state unavailable' }).waitFor()
  await surface.getByRole('button', { name: /^(重试|Retry)$/ }).first().click()
  await surface.locator('[data-page="0"]').waitFor()
  assert.notEqual(await surface.evaluate(element => getComputedStyle(element).getPropertyValue('--spacing').trim()), '')
  assert.match(await surface.locator('h1').innerText(), /DSH NEXT/)
  assert.equal(await page.locator('#root').evaluate(element => element.inert), true)
  await page.screenshot({ path: join(screenshots, 'onboarding-official-welcome.png') })
  await next()
  const backBounds = await surface.getByRole('button', { name: /^(上一步|Back)$/ }).boundingBox()
  const progressBounds = await surface.locator('.next-onboarding-progress').boundingBox()
  const mainBounds = await surface.locator('main').boundingBox()
  assert.ok(progressBounds.y >= 36 && progressBounds.y + progressBounds.height <= mainBounds.y, 'Progress belongs above the content, clear of traffic lights')
  assert.ok(backBounds.y >= mainBounds.y + mainBounds.height, 'Official Back navigation belongs below the content')
  for (const element of await surface.locator('.next-onboarding-choice, [role="radio"]').all()) {
    assert.equal(await element.evaluate(node => getComputedStyle(node).getPropertyValue('-webkit-app-region')), 'no-drag', 'Choice cards and radio controls must subtract the official drag region')
  }
  await surface.getByText('dsh-market', { exact: true }).click()
  await page.screenshot({ path: join(screenshots, 'onboarding-official-market-macos.png') })
  await next()
  await surface.getByRole('switch').check()
  assert.equal(await surface.getByRole('switch').evaluate(node => getComputedStyle(node).getPropertyValue('-webkit-app-region')), 'no-drag')
  assert.equal(await surface.locator('img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), true)
  await back()
  assert.equal(await surface.getByRole('radio', { name: 'dsh-market', exact: true }).isChecked(), true)
  await next()
  assert.equal(await surface.getByRole('switch').isChecked(), true)
  await next()
  await surface.getByRole('switch').check()
  await surface.getByRole('button', { name: /^(权限设置|Permission settings)$/ }).click()
  const permissions = page.getByRole('dialog', { name: /^(系统权限|System permissions)$/ })
  await permissions.waitFor()
  await permissions.getByRole('button', { name: /^(关闭|Close)$/ }).click()
  await permissions.waitFor({ state: 'hidden' })
  await page.screenshot({ path: join(screenshots, 'onboarding-official-computer-use.png') })
  await next()
  rejectSave = true
  await finish()
  await surface.getByRole('alert').filter({ hasText: 'could not save Profile' }).waitFor()
  await finish()
  await surface.waitFor({ state: 'hidden' })
  assert.equal(finishes.length, 1)
  assert.deepEqual(finishes[0], { profile: 'desktop', selection: { ...selection, market: 'dsh-market', aaEnabled: true, computerUse: true } })
  // The native app restarts after saving. No authorization should start in the old renderer.
  await page.reload()
  await surface.getByRole('heading', { name: '桌面设置已完成' }).waitFor()
  await captureAccount('onboarding-official-account-choice.png')
  await surface.getByRole('button', { name: '登录 DeepSeek' }).click()
  await surface.getByRole('alert').filter({ hasText: 'account choice save failed' }).waitFor()
  await surface.getByRole('button', { name: '重试', exact: true }).click()
  await surface.getByRole('button', { name: '登录 DeepSeek' }).click()
  const login = page.getByRole('dialog', { name: '开始使用', exact: true })
  await login.waitFor()
  await surface.waitFor({ state: 'hidden' })
  assert.equal(await surface.count(), 0)
  await captureAccount('onboarding-official-account-login.png')
  await login.getByRole('button', { name: '添加 API Key', exact: true }).click()
  await login.waitFor({ state: 'hidden' })
  await page.getByRole('dialog').filter({ hasText: 'API Key' }).waitFor()
  await page.reload()
  await page.getByRole('button', { name: /^(插件|Plugins)$/ }).waitFor()
  assert.equal(await surface.count(), 0)
  accountPending = true
  await page.reload()
  await surface.getByRole('button', { name: '暂时跳过', exact: true }).click()
  await surface.waitFor({ state: 'hidden' })
  assert.equal(accountPending, false)
  assert.equal(await page.locator('#root').evaluate(element => element.inert), false)
  required = true
  await open(); await next()
  await page.setViewportSize({ width: 680, height: 560 })
  const headingBounds = await surface.locator('h1').boundingBox()
  const footerBounds = await surface.locator('footer').boundingBox()
  assert.ok(headingBounds.y >= 0 && footerBounds.y + footerBounds.height <= 560)
  assert.equal(await surface.locator('h1').evaluate(heading => heading === document.activeElement), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: join(screenshots, 'onboarding-official-next-small.png') })
  await next(); await surface.getByRole('switch').check(); await skip()
  await surface.waitFor({ state: 'hidden' })
  assert.equal(finishes.at(-1).selection, undefined)
  assert.deepEqual(errors, [])
  console.log(`Original Next onboarding passed inside the official surface: independent native eligibility, official progress ${officialPending ? 'unfinished' : 'completed'}, state-read and save retries, five original pages, artwork, back navigation, choices, skip, completion, inert cleanup, and no repeat.`)
} catch (error) {
  console.error(errors)
  if (page) { console.error(await page.locator('body').innerText()); await page.screenshot({ path: join(screenshots, 'onboarding-failure.png') }).catch(() => {}) }
  throw error
} finally {
  await browser?.close()
  await host.stop()
  rmSync(home, { recursive: true, force: true })
}
