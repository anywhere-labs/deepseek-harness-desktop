// src/repair-plans.ts
import type { DesktopStartupRecoveryRepairPlanId } from './startup-recovery-controller.ts'
import type { RestoreResult } from './profile-checkpoint.ts'
import { writeDegradedBundles } from './degraded-mode.ts'

export interface DesktopRepairOutcome {
  readonly status: 'acknowledged' | 'degraded' | 'restored' | 'already-attempted'
  readonly message: string
}
export interface RepairPlanDependencies {
  readonly degradedStatePath: string | undefined
  /** Analysis-identified faulting bundle threaded into plan A's degraded commit. */
  readonly degradedBundle: readonly string[]
  readonly restoreLatest: () => Promise<RestoreResult>
}
export interface DesktopRepairPlan {
  readonly id: DesktopStartupRecoveryRepairPlanId
  readonly title: string
  readonly description: string
  readonly risk: { readonly severity: 'low' | 'medium' | 'high'; readonly notes: string }
  readonly audience: 'end-user' | 'developer' | 'both'
  readonly apply: () => Promise<DesktopRepairOutcome>
}

export function repairPlans(deps: RepairPlanDependencies): ReadonlyArray<DesktopRepairPlan> {
  return [
    { id: 'A', title: '临时禁用故障插件',
      description: '把故障插件加入降级集合，重启后跳过它进入主页面。',
      risk: { severity: 'low', notes: '仅该插件不再加载，基础聊天/WebUI 可用。' },
      audience: 'both',
      apply: async () => {
        if (deps.degradedStatePath === undefined || deps.degradedStatePath.length === 0) {
          throw new Error('degraded state path is required for plan A')
        }
        writeDegradedBundles(deps.degradedStatePath, deps.degradedBundle)
        return { status: 'degraded', message: '已启用降级模式。请重新启动 Desktop。' }
      } },
    { id: 'B', title: '回滚子模块版本',
      description: '把上游子模块 pin 回退到上一有效 commit。',
      risk: { severity: 'high', notes: '违反"不编辑子模块"纪律，需显式告警。' },
      audience: 'developer',
      apply: async () => ({ status: 'acknowledged', message: '方案 B 需开发者二次确认，暂不自动执行。' }) },
    { id: 'C', title: '重置插件加载清单',
      description: '把 profile bundle 组合改写为默认/上次健康集。',
      risk: { severity: 'medium', notes: '可能丢失自定义插件组合。' },
      audience: 'both',
      apply: async () => ({ status: 'acknowledged', message: '方案 C 需默认健康集，暂不自动执行。' }) },
    { id: 'D', title: '恢复默认配置',
      description: '恢复上次健康配置快照。',
      risk: { severity: 'low', notes: '恢复上次健康快照。' },
      audience: 'both',
      apply: async () => {
        const result = await deps.restoreLatest()
        const changed = result.changedFiles.join(', ')
        return {
          status: result.status,
          message: changed === '' ? '已恢复上次健康快照。' : `已恢复上次健康快照（${changed}）。`,
        }
      } },
  ]
}
