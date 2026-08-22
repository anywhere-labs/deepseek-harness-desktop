// src/repair-self-check.ts
export interface RepairSelfCheckItem {
  readonly name: string
  readonly run: () => Promise<{ readonly ok: boolean; readonly detail: string }>
}
export interface RepairSelfCheckReport {
  readonly ok: boolean
  readonly checks: readonly { readonly name: string; readonly passed: boolean; readonly detail: string }[]
  readonly recommendation: string
}

export async function runRepairSelfCheck(
  items: readonly RepairSelfCheckItem[],
): Promise<RepairSelfCheckReport> {
  const checks = await Promise.all(items.map(async item => {
    const result = await item.run()
    return { name: item.name, passed: result.ok, detail: result.detail }
  }))
  const ok = checks.every(check => check.passed)
  return {
    ok,
    checks,
    recommendation: ok
      ? '✅ 修复成功，点击【重新启动 DSH Desktop】生效。'
      : '❌ 修复失败，请尝试其他方案。',
  }
}
