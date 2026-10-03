/** Run the original Stable/Beta wizard in the actual composed official client. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'

// Execute the exact native watchdog probe against the real body portal.
const probe = readFileSync(new URL('../dsh-plugin-desktop-beta/src/renderer-surface-watchdog.ts', import.meta.url), 'utf8')
  .match(/export const RENDERER_SURFACE_PROBE = String.raw`([^`]+)`/u)?.[1]
assert.ok(probe)

export async function verifyDesktopOnboardingBrowser({ url, cookie, headers }) {
  const { chromium } = createRequire(new URL('../dsh-desktop-next/package.json', import.meta.url))('playwright')
  const browser = await chromium.launch({ headless: true, ...(process.env.DSH_NEXT_TEST_BROWSER_CHANNEL ? { channel: process.env.DSH_NEXT_TEST_BROWSER_CHANNEL } : {}) })
  let page
  const errors = []
  let required = true, accountPending = false, restartPending = false, rejectSave = true, restartRequests = 0
  const submissions = []
  const input = {
    profileName: 'desktop', appVersion: '2.0.14', platform: 'darwin',
    mode: 'compatibility', macosMaterial: 'off', windowsMaterial: 'off',
    openBrowser: false, networkExposure: 'loopback', market: 'community-market', aaEnabled: false,
    notifications: { enabled: true, notifyOnTurnCompletion: true, notifyOnTurnFailure: true, notifyOnJobCompletion: false, notifyOnJobFailure: false },
  }
  try {
    const context = await browser.newContext({ viewport: { width: 1040, height: 720 }, locale: 'zh-CN', colorScheme: 'dark', extraHTTPHeaders: headers })
    const target = new URL(url)
    const separator = cookie.indexOf('=')
    await context.addCookies([{ url: target.origin, name: cookie.slice(0, separator), value: cookie.slice(separator + 1) }])
    await context.exposeFunction('__readSetup', () => ({ required, accountPending, restartPending, edition: 'desktop', profile: 'desktop', input }))
    await context.exposeFunction('__finishSetup', (profile, selection) => {
      if (rejectSave) { rejectSave = false; throw new Error('Fixture: save failed') }
      submissions.push({ profile, selection }); required = false; accountPending = selection !== undefined
      restartPending = selection !== undefined
    })
    await context.exposeFunction('__dismissAccount', profile => { assert.equal(profile, 'desktop'); accountPending = false })
    await context.exposeFunction('__applyPending', profile => { assert.equal(profile, 'desktop'); assert.equal(accountPending, false); restartRequests++; restartPending = false })
    await context.addInitScript(() => {
      globalThis.dshDesktop = { protocolVersion: 1 }
      globalThis.dshDesktopSetup = { read: () => globalThis.__readSetup(), finish: (profile, selection) => globalThis.__finishSetup(profile, selection), dismissAccount: profile => globalThis.__dismissAccount(profile), applyPending: profile => globalThis.__applyPending(profile) }
    })
    page = await context.newPage(); page.setDefaultTimeout(20_000)
    page.on('pageerror', error => errors.push(error.message))
    const surface = page.locator('.dshDesktopOnboardingContent')
    const click = name => surface.getByRole('button', { name, exact: true }).click()
    const next = () => click('下一步')
    const dialog = name => page.getByRole('alertdialog', { name, exact: true })
    await page.goto(target.href)
    await surface.waitFor()
    await page.evaluate(() => { document.documentElement.dataset.platform = 'darwin' })
    assert.equal(await page.locator('#root').evaluate(node => getComputedStyle(node).opacity), '0')
    assert.equal(await page.evaluate(probe), true, 'Visible onboarding must keep the renderer watchdog healthy')
    await page.screenshot({ path: join(tmpdir(), 'dsh-official-desktop-welcome.png') })
    await click('开始设置')
    const progress = await surface.locator('.dshSetupProgress').boundingBox()
    const main = await surface.locator('main').boundingBox()
    const back = await surface.getByRole('button', { name: '上一步', exact: true }).boundingBox()
    assert.ok(progress.y >= 36 && progress.y + progress.height <= main.y)
    assert.ok(back.y >= main.y + main.height)
    assert.equal(await page.evaluate(probe), true)
    await page.screenshot({ path: join(tmpdir(), 'dsh-official-desktop-mode.png') })
    assert.equal(await surface.locator('.dshDesktopSetupContent').evaluate(node => getComputedStyle(node).paddingTop), '36px')
    for (const element of await surface.locator('label, [role="radio"]').all()) {
      assert.equal(await element.evaluate(node => getComputedStyle(node).getPropertyValue('-webkit-app-region')), 'no-drag')
      assert.equal(await element.evaluate(node => getComputedStyle(node).cursor), 'pointer')
    }
    await surface.getByText('增强模式', { exact: true }).click()
    await next(); await next()
    await surface.getByText('dsh-market', { exact: true }).click()
    await page.screenshot({ path: join(tmpdir(), 'dsh-official-desktop-market.png') })
    await next()
    await surface.getByText('开启手机连接', { exact: true }).click()
    await click('上一步')
    assert.equal(await surface.getByRole('radio', { name: /dsh-market/ }).isChecked(), true)
    await next()
    assert.equal(await surface.getByRole('radio', { name: /开启手机连接/ }).isChecked(), true)
    await next()
    assert.equal(await surface.getByRole('switch').count(), 5)
    assert.equal(await surface.getByRole('switch').first().evaluate(node => getComputedStyle(node).cursor), 'pointer')
    await surface.getByRole('switch').first().click()
    assert.equal(await surface.getByRole('switch').nth(1).isDisabled(), true)
    assert.equal(await surface.getByRole('switch').nth(1).evaluate(node => getComputedStyle(node).cursor), 'not-allowed')
    assert.equal(await surface.locator('label[for="setup-turn-completion"]').evaluate(node => getComputedStyle(node).cursor), 'not-allowed')
    await surface.getByRole('switch').first().click()
    await page.setViewportSize({ width: 680, height: 560 })
    assert.equal(await page.evaluate(probe), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: join(tmpdir(), 'dsh-original-desktop-notifications.png') })
    await next()
    await surface.getByRole('switch').click()
    await dialog('切换到兼容模式？').getByRole('button', { name: '切换并开启', exact: true }).click()
    await surface.getByText('局域网', { exact: true }).click()
    await dialog('开启局域网访问？').getByRole('button', { name: '保持仅本机访问', exact: true }).click()
    await surface.getByText('局域网', { exact: true }).click()
    await dialog('开启局域网访问？').getByRole('button', { name: '开启局域网访问', exact: true }).click()
    await next()
    await click('开始使用')
    await surface.getByRole('alert').filter({ hasText: 'save failed' }).waitFor()
    await click('开始使用')
    await surface.getByRole('heading', { name: '桌面设置已完成', exact: true }).waitFor()
    const { appVersion, profileName, platform, ...selection } = input
    assert.deepEqual(submissions, [{ profile: 'desktop', selection: { ...selection, mode: 'compatibility', market: 'dsh-market', aaEnabled: true, openBrowser: true, networkExposure: 'lan' } }])
    assert.equal(restartRequests, 0)
    await click('登录 DeepSeek')
    const login = page.getByRole('dialog', { name: '开始使用', exact: true })
    await login.waitFor()
    assert.equal(restartRequests, 0)
    await login.getByRole('button', { name: '关闭', exact: true }).click()
    await login.waitFor({ state: 'hidden' })
    assert.equal(accountPending, false)
    accountPending = true
    await page.reload()
    await click('登录 DeepSeek')
    await login.getByRole('button', { name: '添加 API Key', exact: true }).click()
    const credential = page.getByRole('dialog').filter({ hasText: 'API Key' })
    await credential.waitFor()
    assert.equal(restartRequests, 0)
    assert.equal(await page.locator('#root').evaluate(element => element.inert), true)
    await credential.getByRole('button', { name: '稍后配置', exact: true }).click()
    await credential.waitFor({ state: 'hidden' })
    await page.setViewportSize({ width: 1040, height: 720 })
    await page.reload()
    await page.getByRole('button', { name: /^(插件|Plugins)$/ }).waitFor()
    assert.equal(await surface.count(), 0)
    const restartToast = page.getByRole('alert').filter({ hasText: '桌面设置已保存，下次重启后生效。' })
    await restartToast.waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll('[role="alert"]')].some(element =>
      element.textContent?.includes('桌面设置已保存，下次重启后生效。') && Number(getComputedStyle(element).opacity) > 0.99))
    const placement = await restartToast.evaluate(element => {
      const box = element.getBoundingClientRect()
      return { position: getComputedStyle(element).position, center: box.x + box.width / 2, width: innerWidth, top: box.y,
        bodyPortal: element.parentElement === document.body }
    })
    assert.equal(placement.position, 'fixed')
    assert.equal(placement.bodyPortal, true)
    assert.ok(Math.abs(placement.center - placement.width / 2) < 2)
    await page.screenshot({ path: join(tmpdir(), 'dsh-desktop-setup-official-toast.png') })
    await restartToast.waitFor({ state: 'hidden' })
    assert.equal(restartRequests, 0)
    // Reloading re-reads the native pending state; an explicit action still works.
    await page.reload()
    await page.getByRole('button', { name: '立即重启', exact: true }).click()
    await restartToast.waitFor({ state: 'hidden' })
    assert.equal(restartRequests, 1)
    required = true
    await page.reload()
    await click('跳过')
    await dialog('跳过设置？').getByRole('button', { name: '继续设置', exact: true }).click()
    assert.equal(submissions.length, 1)
    await click('跳过')
    await dialog('跳过设置？').getByRole('button', { name: '跳过设置', exact: true }).click()
    await surface.waitFor({ state: 'hidden' })
    assert.equal(submissions.at(-1).selection, undefined)
    assert.equal(restartRequests, 1)
    assert.equal(await page.locator('#root').evaluate(element => element.inert), false)
    assert.deepEqual(errors, [])
    console.log('Original Desktop wizard passed: eight pages, retained choices, original browser/LAN/skip confirmations, save retry, completion, and no repeat.')
  } catch (error) {
    console.error(errors)
    if (page) {
      console.error(await page.locator('body').innerText())
      await page.screenshot({ path: join(tmpdir(), 'dsh-original-desktop-failure.png') }).catch(() => {})
    }
    throw error
  } finally { await browser.close() }
}
