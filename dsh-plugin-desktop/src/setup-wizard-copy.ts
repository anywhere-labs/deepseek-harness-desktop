/** Bilingual copy for the pre-Host native Setup Wizard. */

import type { DesktopLocale } from './runtime.ts'

export interface DesktopSetupWizardCopy {
  readonly aaTitle: string
  readonly aaIntro: string
  readonly aaDisabled: string
  readonly aaDisabledBody: string
  readonly aaEnabled: string
  readonly aaEnabledBody: string
  readonly aaNextTitle: string
  readonly aaNextBody: string
  readonly aaNextDesktop: string
  readonly beta: string
  readonly title: string
  readonly profile: string
  readonly welcomeTitle: string
  readonly welcomeBody: string
  readonly firstProfileSetup: string
  readonly startSetup: string
  readonly presentationTitle: string
  readonly presentationBody: string
  readonly compatibilityMode: string
  readonly compatibilityModeBody: string
  readonly extendedMode: string
  readonly extendedModeBody: string
  readonly advancedMode: string
  readonly advancedModeBody: string
  readonly unavailableOnLinux: string
  readonly windowMaterial: string
  readonly windowMaterialBody: string
  readonly materialOff: string
  readonly materialOffBody: string
  readonly materialTransparent: string
  readonly materialTransparentBody: string
  readonly browserTitle: string
  readonly browserBody: string
  readonly openBrowser: string
  readonly browserCompatibilityNotice: string
  readonly browserCompatibilityDialogTitle: string
  readonly browserCompatibilityDialogBody: string
  readonly confirmBrowserCompatibility: string
  readonly cancelBrowserCompatibility: string
  readonly networkExposure: string
  readonly networkExposureBody: string
  readonly loopback: string
  readonly loopbackBody: string
  readonly lan: string
  readonly lanBody: string
  readonly lanWarningTitle: string
  readonly lanWarningBody: string
  readonly confirmLan: string
  readonly cancelLan: string
  readonly marketTitle: string
  readonly marketBody: string
  readonly marketDisabled: string
  readonly marketDisabledBody: string
  readonly communityMarket: string
  readonly communityMarketBody: string
  readonly dshMarket: string
  readonly dshMarketBody: string
  readonly notificationsTitle: string
  readonly notificationsBody: string
  readonly notificationsEnabled: string
  readonly turnCompletion: string
  readonly turnFailure: string
  readonly jobCompletion: string
  readonly jobFailure: string
  readonly scheduleCompletion: string
  readonly scheduleFailure: string
  readonly back: string
  readonly next: string
  readonly skip: string
  readonly skipDialogTitle: string
  readonly skipDialogBody: string
  readonly cancelSkip: string
  readonly confirmSkip: string
  readonly successTitle: string
  readonly successBody: string
  readonly startUsing: string
  readonly invalidState: string
}

const COPY: Record<DesktopLocale, DesktopSetupWizardCopy> = {
  en: {
    aaTitle: 'Agents-Anywhere',
    aaIntro: 'Use Agents-Anywhere to access DSH on this computer from your phone or a browser.',
    aaDisabled: 'Turn off phone connection',
    aaDisabledBody: 'Do not use Agents-Anywhere to access this computer from a phone or browser.',
    aaEnabled: 'Turn on phone connection',
    aaEnabledBody: 'After enabling, open Phone connection in the sidebar to finish setup.',
    aaNextTitle: 'Connect a device',
    aaNextBody: 'After setup, open Phone connection in the sidebar to continue connecting your device.',
    aaNextDesktop: 'If the Agents-Anywhere desktop app is installed on this computer, manage the connection directly in that app.',

    beta: 'Beta',
    title: 'Set up DSH Desktop',
    profile: 'Profile',
    welcomeTitle: 'Welcome to DSH Desktop',
    welcomeBody: 'Set up window appearance, phone connection, and notifications for the current Profile.',
    firstProfileSetup: 'Complete Desktop setup before using this configuration environment (Profile) for the first time.',
    startSetup: 'Start setup',
    presentationTitle: 'Choose a window mode',
    presentationBody: 'Choose a window layout and desktop controls.',
    compatibilityMode: 'Compatibility mode',
    compatibilityModeBody: 'Use the official client layout with an independent Desktop control bar above it. This mode offers the best compatibility.',
    extendedMode: 'Extended mode',
    extendedModeBody: 'Add an independent titlebar and sidebar around the official content area, with optional glass effects.',
    advancedMode: 'Enhanced mode',
    advancedModeBody: 'Use a desktop layout with adjusted sidebars, content panels, and window controls.',
    unavailableOnLinux: 'This mode is currently available on macOS and Windows.',
    windowMaterial: 'Choose a window material',
    windowMaterialBody: 'Choose a window background effect.',
    materialOff: 'Solid background',
    materialOffBody: 'Use a solid, opaque window background.',
    materialTransparent: 'Glass background',
    materialTransparentBody: 'Show a blurred view of the content behind the window.',
    browserTitle: 'Set up browser access',
    browserBody: 'Allow browser access to the current Profile and choose which devices can reach it.',
    openBrowser: 'Allow opening this Profile in a browser',
    browserCompatibilityNotice: 'Browser access is only available in compatibility mode.',
    browserCompatibilityDialogTitle: 'Switch to compatibility mode?',
    browserCompatibilityDialogBody: 'Opening this Profile in a browser requires compatibility mode. Continue to switch the window mode and enable browser access.',
    confirmBrowserCompatibility: 'Switch and enable',
    cancelBrowserCompatibility: 'Cancel',
    networkExposure: 'Network access',
    networkExposureBody: 'Allow access from this computer only, or from other devices on the same local network over HTTPS.',
    loopback: 'This computer only',
    loopbackBody: 'Only browsers on this computer can connect.',
    lan: 'Local network',
    lanBody: 'Other devices on the same local network can connect using the access link. First install and trust the certificate provided by this computer on each device.',
    lanWarningTitle: 'Enable local-network access?',
    lanWarningBody: 'Anyone on the same local network who has the access link can use DSH to operate this computer. Share the link only with people you trust. Connections use HTTPS; each device must install and trust the certificate provided by this computer.',
    confirmLan: 'Enable local-network access',
    cancelLan: 'Keep this computer only',
    marketTitle: 'Choose a plugin market',
    marketBody: 'Choose a plugin market for the current Profile. Only one can be enabled at a time.',
    marketDisabled: 'Turn off plugin market',
    marketDisabledBody: 'Do not load a plugin market interface.',
    communityMarket: 'dsh-community-market',
    communityMarketBody: 'The open market built into DSH Desktop, including custom data sources.',
    dshMarket: 'dsh-market',
    dshMarketBody: 'The popular community market powered by awesome-dsh-plugin data.',
    notificationsTitle: 'Set up Desktop notifications',
    notificationsBody: 'Receive system notifications when tasks finish or fail. Notifications do not show conversation content.',
    notificationsEnabled: 'Enable Desktop notifications',
    turnCompletion: 'Current turn completed',
    turnFailure: 'Current turn failed',
    jobCompletion: 'Background job completed',
    jobFailure: 'Background job failed',
    scheduleCompletion: 'Automation task completed',
    scheduleFailure: 'Automation task failed',
    back: 'Previous',
    next: 'Next',
    skip: 'Skip setup',
    skipDialogTitle: 'Skip setup?',
    skipDialogBody: 'You can still configure all of these options later under Settings > Desktop settings.',
    cancelSkip: 'Continue setup',
    confirmSkip: 'Skip setup',
    successTitle: 'Setup complete',
    successBody: 'Desktop settings have been saved for the current Profile.',
    startUsing: 'Start using DSH Desktop',
    invalidState: 'Setup information could not be loaded. Close this window and try again.',
  },
  zh: {
    aaTitle: 'Agents-Anywhere',
    aaIntro: '通过 Agents-Anywhere，在手机或浏览器中访问这台电脑上的 DSH。',
    aaDisabled: '关闭手机连接',
    aaDisabledBody: '不在手机或浏览器中通过 Agents-Anywhere 访问这台电脑。',
    aaEnabled: '开启手机连接',
    aaEnabledBody: '开启后，打开侧边栏中的“手机连接”完成设置。',
    aaNextTitle: '连接设备',
    aaNextBody: '完成设置后，打开侧边栏中的“手机连接”，继续连接设备。',
    aaNextDesktop: '如果本机已安装 Agents-Anywhere 桌面端，直接在桌面端管理连接即可。',

    beta: 'Beta',
    title: '设置 DSH Desktop',
    profile: 'Profile',
    welcomeTitle: '欢迎使用 DSH Desktop',
    welcomeBody: '为当前 Profile 设置窗口外观、手机连接和桌面通知。',
    firstProfileSetup: '首次使用此配置环境（Profile），请先完成桌面设置。',
    startSetup: '开始设置',
    presentationTitle: '选择窗口模式',
    presentationBody: '选择窗口布局和桌面操作方式。',
    compatibilityMode: '兼容模式',
    compatibilityModeBody: '使用官方客户端布局，顶部提供独立的桌面控制栏。兼容性最好。',
    extendedMode: '扩展模式',
    extendedModeBody: '在官方内容区域外提供独立顶栏和侧边栏，可搭配玻璃背景。',
    advancedMode: '增强模式',
    advancedModeBody: '使用桌面专用布局，调整侧边栏、内容面板和窗口操作方式。',
    unavailableOnLinux: '此模式目前支持 macOS 和 Windows。',
    windowMaterial: '选择窗口材质',
    windowMaterialBody: '选择窗口背景效果。',
    materialOff: '纯色背景',
    materialOffBody: '使用不透明的纯色窗口背景。',
    materialTransparent: '玻璃背景',
    materialTransparentBody: '透出窗口背后的内容，并呈现模糊效果。',
    browserTitle: '设置浏览器访问',
    browserBody: '允许在浏览器中打开当前 Profile，并选择可访问的设备范围。',
    openBrowser: '允许在浏览器中打开',
    browserCompatibilityNotice: '浏览器访问仅在兼容模式下可用。',
    browserCompatibilityDialogTitle: '切换到兼容模式？',
    browserCompatibilityDialogBody: '在浏览器中打开只能使用兼容模式。继续将把这个 Profile 的窗口模式切换为兼容模式，并开启浏览器访问。',
    confirmBrowserCompatibility: '切换并开启',
    cancelBrowserCompatibility: '取消',
    networkExposure: '网络访问范围',
    networkExposureBody: '选择仅允许这台电脑访问，或允许同一局域网中的其他设备通过 HTTPS 访问。',
    loopback: '仅这台电脑',
    loopbackBody: '只有这台电脑上的浏览器可以访问。',
    lan: '局域网',
    lanBody: '同一局域网中的其他设备可通过访问链接连接。请先在访问设备上安装并信任本机提供的证书。',
    lanWarningTitle: '开启局域网访问？',
    lanWarningBody: '同一局域网中，持有访问链接的人可以通过 DSH 操作这台电脑。请仅与可信任的人共享链接。连接使用 HTTPS；访问设备需要安装并信任本机提供的证书。',
    confirmLan: '开启局域网访问',
    cancelLan: '保持仅本机访问',
    marketTitle: '选择插件市场',
    marketBody: '为当前 Profile 选择一个插件市场。一次只能启用一个。',
    marketDisabled: '关闭插件市场',
    marketDisabledBody: '不加载插件市场界面。',
    communityMarket: 'dsh-community-market',
    communityMarketBody: 'DSH Desktop 内置的开放市场，并支持自定义数据源。',
    dshMarket: 'dsh-market',
    dshMarketBody: '使用 awesome-dsh-plugin 数据的热门社区市场。',
    notificationsTitle: '设置桌面通知',
    notificationsBody: '在任务完成或失败时接收系统通知。通知不会显示会话内容。',
    notificationsEnabled: '启用桌面通知',
    turnCompletion: '本轮任务完成',
    turnFailure: '本轮任务失败',
    jobCompletion: '后台任务完成',
    jobFailure: '后台任务失败',
    scheduleCompletion: '自动化任务完成',
    scheduleFailure: '自动化任务失败',
    back: '上一步',
    next: '下一步',
    skip: '跳过设置',
    skipDialogTitle: '跳过设置？',
    skipDialogBody: '之后仍可在“设置” > “桌面设置”中配置这里的所有内容。',
    cancelSkip: '继续设置',
    confirmSkip: '跳过设置',
    successTitle: '设置完成',
    successBody: '当前 Profile 的桌面设置已保存。',
    startUsing: '开始使用',
    invalidState: '无法加载设置信息。请关闭此窗口后重试。',
  },
}

export function desktopSetupWizardCopy(locale: DesktopLocale): DesktopSetupWizardCopy {
  return COPY[locale]
}
