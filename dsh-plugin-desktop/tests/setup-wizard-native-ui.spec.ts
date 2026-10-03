import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopSetupWizardInput,
  DesktopSetupWizardNetworkExposure,
  DesktopSetupWizardSelection,
} from '../src/setup-wizard-contract.ts'
import {
  confirmDesktopSetupWizardBrowserCompatibility,
  decodeDesktopSetupWizardInput,
  DESKTOP_SETUP_WIZARD_STEPS,
  desktopSetupWizardSkipRequiresLanAcknowledgement,
  nextDesktopSetupWizardStep,
  previousDesktopSetupWizardStep,
  resolveDesktopSetupWizardBrowserAccessRequest,
  SetupWizardBrowserCompatibilityConfirmation,
  SetupWizardLanConfirmation,
  SetupWizardNavigation,
  SetupWizardStepPage,
  SetupWizardSuccess,
  SetupWizardWelcome,
} from '../src/native-ui/setup-wizard/App.tsx'
import { Button } from '../src/native-ui/components/ui/button.tsx'
import { DialogClose } from '../src/native-ui/components/ui/dialog.tsx'
import { desktopSetupWizardCopy } from '../src/setup-wizard-copy.ts'

const input: DesktopSetupWizardInput = {
  appVersion: '2.0.6-beta.1',
  profileName: 'work',
  platform: 'darwin',
  mode: 'extended',
  macosMaterial: 'transparent',
  windowsMaterial: 'off',
  openBrowser: false,
  networkExposure: 'loopback',
  aaEnabled: false,
  market: 'community-market',
  notifications: {
    enabled: true,
    notifyOnTurnCompletion: true,
    notifyOnTurnFailure: true,
    notifyOnJobCompletion: false,
    notifyOnJobFailure: true,
    notifyOnScheduleCompletion: true,
    notifyOnScheduleFailure: true,
  },
}

const selection: DesktopSetupWizardSelection = {
  mode: input.mode,
  macosMaterial: input.macosMaterial,
  windowsMaterial: input.windowsMaterial,
  openBrowser: input.openBrowser,
  networkExposure: input.networkExposure,
  aaEnabled: false,
  market: input.market,
  notifications: input.notifications,
}

const copy = desktopSetupWizardCopy('zh')

function renderStep(
  step: Exclude<(typeof DESKTOP_SETUP_WIZARD_STEPS)[number], 'welcome' | 'success'>,
  current: DesktopSetupWizardSelection = selection,
): string {
  return renderToStaticMarkup(createElement(SetupWizardStepPage, {
    copy,
    input,
    requestBrowserAccess: (_enabled: boolean) => {},
    requestExposure: (_exposure: DesktopSetupWizardNetworkExposure) => {},
    selection: current,
    step,
    update: (_next: DesktopSetupWizardSelection) => {},
  }))
}

function occurrences(markup: string, fragment: string): number {
  return markup.split(fragment).length - 1
}

function elementText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!isValidElement(node)) return Children.toArray(node).map(elementText).join(' ')
  return elementText((node.props as { readonly children?: ReactNode }).children)
}

function elementTree(node: ReactNode): readonly ReactElement[] {
  const elements: ReactElement[] = []
  Children.forEach(node, child => {
    if (!isValidElement(child)) return
    elements.push(child)
    elements.push(...elementTree((child.props as { readonly children?: ReactNode }).children))
  })
  return elements
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Setup Wizard step flow', () => {
  it('starts with an introduction and keeps browser access as the final setting page', () => {
    expect(DESKTOP_SETUP_WIZARD_STEPS).toEqual([
      'welcome',
      'mode',
      'material',
      'market',
      'aa',
      'notifications',
      'browser',
      'success',
    ])
  })

  it('moves only between adjacent pages and stops at both boundaries', () => {
    expect(DESKTOP_SETUP_WIZARD_STEPS.map(step => previousDesktopSetupWizardStep(step))).toEqual([
      undefined,
      'welcome',
      'mode',
      'material',
      'market',
      'aa',
      'notifications',
      'browser',
    ])
    expect(DESKTOP_SETUP_WIZARD_STEPS.map(step => nextDesktopSetupWizardStep(step))).toEqual([
      'mode',
      'material',
      'market',
      'aa',
      'notifications',
      'browser',
      'success',
      undefined,
    ])
  })
})

describe('Setup Wizard welcome page', () => {
  it('identifies the Profile and explains why first-run Desktop setup is shown', () => {
    const markup = renderToStaticMarkup(createElement(SetupWizardWelcome, {
      appVersion: input.appVersion,
      copy,
      onSkip: () => {},
      onStart: () => {},
      profileName: input.profileName,
    }))
    expect(markup).toContain('data-setup-step="welcome"')
    expect(markup).toContain(copy.welcomeTitle)
    expect(markup).toContain(copy.beta)
    expect(markup).toContain(`v${input.appVersion}`)
    expect(markup).toContain('data-slot="badge"')
    expect(markup).toContain('data-beta-placement="title-bottom-right"')
    expect(markup).toContain('items-end')
    expect(markup).toContain('text-[10px]')
    expect(markup).toContain(copy.welcomeBody)
    expect(markup).toContain(copy.firstProfileSetup)
    expect(markup).toContain(copy.profile)
    expect(markup).toContain(input.profileName)
    expect(markup).toContain('text-left')
    expect(markup).not.toContain('text-center')
  })

  it('offers Start setup and confirmed Skip without ordinary arrow navigation', () => {
    const markup = renderToStaticMarkup(createElement(SetupWizardWelcome, {
      appVersion: input.appVersion,
      copy,
      onSkip: () => {},
      onStart: () => {},
      profileName: input.profileName,
    }))
    const navigation = renderToStaticMarkup(createElement(SetupWizardNavigation, {
      copy,
      onBack: () => {},
      onNext: () => {},
      onSkip: () => {},
      step: 'welcome',
    }))
    expect(markup).toContain(copy.startSetup)
    expect(markup).toContain(copy.skip)
    expect(markup).toContain('data-slot="dialog-trigger"')
    expect(markup).toContain('aria-haspopup="dialog"')
    expect(markup).not.toContain(`aria-label="${copy.back}"`)
    expect(markup).not.toContain(`aria-label="${copy.next}"`)
    expect(markup).not.toContain('lucide-arrow-left')
    expect(markup).not.toContain('lucide-arrow-right')
    expect(navigation).toBe('')
  })
})

describe('Setup Wizard setting pages', () => {
  it.each([
    ['mode', 'presentationTitle', 'presentationBody'],
    ['material', 'windowMaterial', 'windowMaterialBody'],
    ['market', 'marketTitle', 'marketBody'],
    ['notifications', 'notificationsTitle', 'notificationsBody'],
    ['browser', 'browserTitle', 'browserBody'],
  ] as const)('renders the %s page with its own title and subtitle', (step, title, body) => {
    const markup = renderStep(step)
    expect(markup).toContain(`data-setup-step="${step}"`)
    expect(markup).toContain(copy[title])
    expect(markup).toContain(copy[body])
    expect(occurrences(markup, 'data-setup-step=')).toBe(1)
  })

  it.each(['mode', 'material', 'market', 'notifications', 'browser'] as const)(
    'lays out the %s page options vertically',
    (step) => {
      expect(renderStep(step)).toContain('data-orientation="vertical"')
    },
  )

  it.each([
    ['mode', copy.presentationTitle],
    ['material', copy.windowMaterial],
    ['market', copy.marketTitle],
    ['browser', copy.networkExposure],
  ] as const)('uses a named shadcn RadioGroup for the %s choices', (step, accessibleName) => {
    const markup = renderStep(step)
    expect(markup).toContain('data-slot="radio-group"')
    expect(markup).toContain(`aria-label="${accessibleName}"`)
    expect(markup).toContain('data-slot="radio-group-item"')
  })

  it('does not combine the plugin market and browser settings', () => {
    const market = renderStep('market')
    const browser = renderStep('browser')
    expect(market).toContain(copy.marketTitle)
    expect(market).not.toContain(copy.browserTitle)
    expect(market).not.toContain(copy.openBrowser)
    expect(browser).toContain(copy.browserTitle)
    expect(browser).not.toContain(copy.marketTitle)
    expect(browser).not.toContain(copy.communityMarket)
    expect(browser).not.toContain(copy.dshMarket)
  })

  it('marks Community Market and LAN access as Beta features', () => {
    const market = renderStep('market')
    const browser = renderStep('browser')
    const enabledBrowser = renderStep('browser', {
      ...selection,
      mode: 'compatibility',
      openBrowser: true,
      networkExposure: 'lan',
    })
    const communityOption = market.indexOf('for="setup-plugin-market-community-market"')
    const nextMarketOption = market.indexOf('for="setup-plugin-market-dsh-market"')
    const marketBadge = market.indexOf('data-slot="badge"')
    const lanOption = browser.indexOf('for="setup-network-exposure-lan"')
    const lanBadge = browser.indexOf('data-slot="badge"')
    const enabledLanOption = enabledBrowser.indexOf('for="setup-network-exposure-lan"')
    const enabledLanChoice = enabledBrowser.slice(
      enabledLanOption,
      enabledBrowser.indexOf('</label>', enabledLanOption),
    )

    expect(occurrences(market, 'data-slot="badge"')).toBe(1)
    expect(occurrences(browser, 'data-slot="badge"')).toBe(1)
    expect(market).toContain(copy.beta)
    expect(browser).toContain(copy.beta)
    expect(marketBadge).toBeGreaterThan(communityOption)
    expect(marketBadge).toBeLessThan(nextMarketOption)
    expect(lanBadge).toBeGreaterThan(lanOption)
    expect(browser.slice(lanOption)).toContain('disabled=""')
    expect(enabledLanChoice).not.toContain('disabled=""')
    expect(enabledLanChoice).toContain('aria-checked="true"')
    expect(browser).toContain('HTTPS')
  })

  it('describes browser access as an opt-in capability limited to compatibility mode', () => {
    const browser = renderStep('browser')
    expect(browser).toContain(copy.openBrowser)
    expect(browser).toContain(copy.browserCompatibilityNotice)
    expect(copy.openBrowser).toBe('允许在浏览器中打开')
    expect(copy.openBrowser).not.toContain('启动后')
    expect(copy.openBrowser).not.toContain('自动')
    expect(copy.browserCompatibilityNotice).toContain('兼容模式')
    expect(copy.browserCompatibilityNotice).toContain('仅在')
    expect(browser).not.toMatch(/<button[^>]*disabled=""[^>]*aria-label="允许在浏览器中打开"/u)
  })

  it('uses the shadcn Switch component for every wizard toggle', () => {
    const notifications = renderStep('notifications')
    const browser = renderStep('browser')
    expect(occurrences(notifications, 'data-slot="switch"')).toBe(7)
    expect(occurrences(notifications, 'role="switch"')).toBe(7)
    expect(occurrences(browser, 'data-slot="switch"')).toBe(1)
    expect(occurrences(browser, 'role="switch"')).toBe(1)
  })
})

describe('Setup Wizard navigation and completion', () => {
  it('shows Skip on the left and back/forward arrow buttons on every setting page', () => {
    for (const step of DESKTOP_SETUP_WIZARD_STEPS.slice(1, -1)) {
      const markup = renderToStaticMarkup(createElement(SetupWizardNavigation, {
        copy,
        onBack: () => {},
        onNext: () => {},
        onSkip: () => {},
        step,
      }))
      expect(markup).toContain(copy.skip)
      expect(markup).toContain(`aria-label="${copy.back}"`)
      expect(markup).toContain(`aria-label="${copy.next}"`)
      expect(markup).toContain('lucide-arrow-left')
      expect(markup).toContain('lucide-arrow-right')
      expect(markup.indexOf(copy.skip)).toBeLessThan(markup.indexOf(`aria-label="${copy.back}"`))
    }
  })

  it('lets the first setting page return to the welcome page', () => {
    const markup = renderToStaticMarkup(createElement(SetupWizardNavigation, {
      copy,
      onBack: () => {},
      onNext: () => {},
      onSkip: () => {},
      step: 'mode',
    }))
    expect(markup).toContain(`aria-label="${copy.back}"`)
    expect(markup).not.toMatch(new RegExp(`<button[^>]+aria-label="${copy.back}"[^>]+disabled=""`, 'u'))
  })

  it('uses a dialog trigger for Skip and explains where setup remains available', () => {
    const markup = renderToStaticMarkup(createElement(SetupWizardNavigation, {
      copy,
      onBack: () => {},
      onNext: () => {},
      onSkip: () => {},
      step: 'market',
    }))
    expect(markup).toContain('data-slot="dialog-trigger"')
    expect(markup).toContain('aria-haspopup="dialog"')
    expect(copy.skipDialogBody).toContain('设置')
    expect(copy.skipDialogBody).toContain('桌面设置')
  })

  it('renders only centered success and Start using controls on the final page', () => {
    const success = renderToStaticMarkup(createElement(SetupWizardSuccess, {
      copy,
      onStart: () => {},
    }))
    const navigation = renderToStaticMarkup(createElement(SetupWizardNavigation, {
      copy,
      onBack: () => {},
      onNext: () => {},
      onSkip: () => {},
      step: 'success',
    }))
    expect(success).toContain('data-setup-step="success"')
    expect(success).toContain('data-align="center"')
    expect(success).toContain(copy.successTitle)
    expect(success).toContain(copy.successBody)
    expect(success).toContain(copy.startUsing)
    expect(success).not.toContain(copy.skip)
    expect(success).not.toContain(`aria-label="${copy.back}"`)
    expect(success).not.toContain(`aria-label="${copy.next}"`)
    expect(navigation).toBe('')
  })
})

describe('Setup Wizard native UI boundaries', () => {
  it('does not let Skip bypass the LAN danger acknowledgement', () => {
    const exposed = {
      ...selection,
      mode: 'compatibility' as const,
      openBrowser: true,
      networkExposure: 'lan' as const,
    }
    expect(desktopSetupWizardSkipRequiresLanAcknowledgement(exposed, false)).toBe(true)
    expect(desktopSetupWizardSkipRequiresLanAcknowledgement(exposed, true)).toBe(false)
    expect(desktopSetupWizardSkipRequiresLanAcknowledgement({
      ...exposed,
      networkExposure: 'loopback',
    }, false)).toBe(false)
  })

  it('asks before switching a custom mode to compatibility for browser access', () => {
    expect(resolveDesktopSetupWizardBrowserAccessRequest(selection, true)).toEqual({
      action: 'confirm-compatibility',
    })
    expect(resolveDesktopSetupWizardBrowserAccessRequest(selection, false)).toEqual({
      action: 'update',
      selection: { ...selection, openBrowser: false, networkExposure: 'loopback' },
    })
    expect(confirmDesktopSetupWizardBrowserCompatibility({
      ...selection,
      networkExposure: 'lan',
    })).toEqual({
      ...selection,
      mode: 'compatibility',
      openBrowser: true,
      networkExposure: 'loopback',
    })

    const dialog = SetupWizardBrowserCompatibilityConfirmation({
      copy,
      confirm: () => {},
      cancel: () => {},
    })
    const dialogProps = dialog.props as { readonly children?: ReactNode; readonly open?: boolean }
    const content = Children.toArray(dialogProps.children).find(isValidElement) as ReactElement | undefined
    expect(dialogProps.open).toBe(true)
    expect(content?.props).toMatchObject({
      'aria-describedby': 'browser-compatibility-body',
      'aria-labelledby': 'browser-compatibility-title',
      'aria-modal': 'true',
      role: 'alertdialog',
      showCloseButton: false,
    })
    const text = elementText(content)
    expect(text).toContain('在浏览器中打开只能使用兼容模式')
    expect(text).toContain(copy.confirmBrowserCompatibility)
    expect(text).toContain(copy.cancelBrowserCompatibility)
  })

  it('renders the LAN warning as an in-window alert dialog with explicit choices', () => {
    const dialog = SetupWizardLanConfirmation({
      copy,
      confirm: () => {},
      cancel: () => {},
    })
    const dialogProps = dialog.props as { readonly children?: ReactNode; readonly open?: boolean }
    const content = Children.toArray(dialogProps.children).find(isValidElement) as ReactElement | undefined
    expect(dialogProps.open).toBe(true)
    expect(content).toBeDefined()
    expect(content?.props).toMatchObject({
      'aria-describedby': 'lan-warning-body',
      'aria-labelledby': 'lan-warning-title',
      'aria-modal': 'true',
      role: 'alertdialog',
      showCloseButton: false,
    })
    const text = elementText(content)
    expect(text).toContain('持有访问链接')
    expect(text).toContain('操作这台电脑')
    expect(text).toContain('HTTPS')
    expect(text).toContain('安装并信任')
    expect(text).toContain('开启局域网访问')
    expect(text).toContain('保持仅本机访问')
    const descendants = elementTree(content)
    const close = descendants.find(element => element.type === DialogClose)
    const confirm = descendants.find(element => element.type === Button
      && elementText(element).includes(copy.confirmLan)
      && (element.props as { readonly variant?: string }).variant === 'destructive')
    expect(close).toBeDefined()
    expect((close?.props as { readonly render?: ReactElement }).render?.props).toMatchObject({ autoFocus: true })
    expect(confirm).toBeDefined()
    expect((confirm?.props as { readonly autoFocus?: boolean }).autoFocus).not.toBe(true)
  })

  it('decodes only the exact bounded state tuple emitted by the owner window', () => {
    vi.stubGlobal('window', { atob: globalThis.atob })
    const state = Buffer.from(JSON.stringify(input), 'utf8').toString('base64url')
    const valid = `?locale=zh&state=${state}&platform=darwin&frame=true`
    expect(decodeDesktopSetupWizardInput(valid)).toEqual(input)
    expect(decodeDesktopSetupWizardInput(`${valid}&unexpected=true`)).toBeUndefined()
    expect(decodeDesktopSetupWizardInput(valid.replace('platform=darwin', 'platform=win32'))).toBeUndefined()
    expect(decodeDesktopSetupWizardInput(valid.replace('locale=zh', 'locale=fr'))).toBeUndefined()
    expect(decodeDesktopSetupWizardInput(valid.replace('frame=true', 'frame=yes'))).toBeUndefined()
  })
})

it('offers AA opt-in with a Beta badge after the market page', () => {
  const html = renderStep('aa')
  expect(html).toContain('Agents-Anywhere')
  expect(html).toContain('Beta')
  expect(html).toContain('setup-aa-false')
  expect(html).toContain('setup-aa-true')
})
