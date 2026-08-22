/** Rendered safe-degraded-mode banner content for the advanced frame. */
export interface DesktopDegradedNotice {
  /** Whether any degraded bundle is present and the banner should render. */
  readonly active: boolean
  /** Short banner heading. */
  readonly title: string
  /** Human-readable explanation of which bundles are degraded. */
  readonly body: string
  /** Label for the dismiss-without-restart action. */
  readonly dismissLabel: string
  /** Label for the restore-and-restart action. */
  readonly restoreLabel: string
}

/**
 * Compute the safe-degraded-mode banner copy for the advanced frame.
 * @param degradedBundles - bundles that failed to load and were left degraded.
 * @param locale - active client locale mapped to the shipped copy languages.
 * @returns the rendered banner content, inactive when nothing is degraded.
 */
export function desktopDegradedNotice(
  degradedBundles: readonly string[],
  locale: 'en' | 'zh',
): DesktopDegradedNotice {
  if (degradedBundles.length === 0) {
    return { active: false, title: '', body: '', dismissLabel: '', restoreLabel: '' }
  }
  return {
    active: true,
    title: locale === 'zh' ? '安全降级模式' : 'Safe degraded mode',
    body: locale === 'zh'
      ? `插件 ${degradedBundles.join(', ')} 未加载，基础聊天/WebUI 可用，部分功能受限。`
      : `Plugins ${degradedBundles.join(', ')} did not load. Core chat/WebUI is available; some features are limited.`,
    dismissLabel: locale === 'zh' ? '忽略' : 'Dismiss',
    restoreLabel: locale === 'zh' ? '立即恢复' : 'Restore',
  }
}
