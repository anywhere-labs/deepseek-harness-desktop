// src/diagnostic-analyzer.ts
export interface AiRepairOption {
  readonly id: 'A' | 'B' | 'C' | 'D'
  readonly title: string
  readonly risk: string
}
export interface AiDiagnosis {
  readonly rootCause: string
  readonly severity: 'low' | 'medium' | 'high'
  readonly options: readonly AiRepairOption[]
  readonly recommendation: string
  readonly disclaimer: string
}

const MODULE_NOT_FOUND = /Cannot find module\s+['"]([^'"]+)['"]/u

export function analyzeDiagnostics(input: string): AiDiagnosis {
  const moduleMatch = MODULE_NOT_FOUND.exec(input)
  const bundle = moduleMatch?.[1] ?? ''
  const baseOptions: AiRepairOption[] = [
    { id: 'A', title: '临时禁用故障插件', risk: '低风险 —— 仅该插件不再加载。' },
    { id: 'B', title: '回滚子模块版本', risk: '高风险（仅开发者） —— 会改动上游子模块版本锁定。' },
    { id: 'C', title: '重置插件加载清单', risk: '中风险 —— 可能丢失自定义插件组合。' },
    { id: 'D', title: '恢复默认配置', risk: '低~中风险 —— 恢复上次健康配置快照。' },
  ]
  const rootCause = bundle === ''
    ? '错误来自插件加载树，无法定位到具体缺失模块。'
    : `依赖解析失败：缺失模块 ${bundle}。插件或子模块未正确安装/兼容。`
  return {
    rootCause,
    severity: bundle === '' ? 'high' : 'medium',
    options: baseOptions,
    recommendation: '建议先尝试方案 A（临时禁用故障插件）进入页面，再逐项排查。',
    disclaimer: 'AI 辅助建议，仅供参考，最终以你选择为准。',
  }
}
