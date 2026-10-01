import { createHash, randomUUID } from 'node:crypto'

/** Provision one account/profile through DSH's documented credentials/settings seams. */
export function createProviderSetup({ issuer, userApi, models }) {
  const pending = new Map()

  async function identity(ctx, userId) {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('无法确定配置所属账号')
    const credentials = ctx.get('credentials')
    const settings = ctx.get('settings')
    if (!credentials || !settings) throw new Error('当前 DSH 缺少官方凭据或配置服务')
    const profile = await settings.prepareDocument()
    const suffix = createHash('sha256').update(`${issuer}\n${profile}\n${userId}`).digest('hex').slice(0, 24)
    return { credentials, settings, key: `anywhere-gateway/setup-${suffix}`,
      providerId: `anywhere-${suffix}`, ref: `ANYWHERE_API_${suffix.toUpperCase()}` }
  }

  async function status(ctx, userId) {
    const id = await identity(ctx, userId)
    const record = await id.credentials.readRecord(id.key)
    const state = record?.kind === 'grant' ? record.payload : undefined
    if (!state) return { status: 'idle' }
    if (pending.has(id.key)) return { status: 'working' }
    return { status: state.status, error: state.error, modelCount: state.modelCount }
  }

  async function run(ctx, userId) {
    const id = await identity(ctx, userId)
    if (pending.has(id.key)) return pending.get(id.key)
    const task = provision(ctx, userId, id)
    pending.set(id.key, task)
    try { return await task } finally { pending.delete(id.key) }
  }

  async function provision(ctx, userId, id, allowReplacement = true) {
    const { credentials, settings, key, ref, providerId } = id
    let state = (await credentials.readRecord(key))?.payload
    if (state?.status === 'ready') {
      return { status: 'ready', modelCount: state.modelCount, alreadyConfigured: true }
    }
    const descriptor = settings.describe({ redactSecrets: true }).find(row => row.ns === 'llm-pi-ai')
    if (!descriptor) throw new Error('当前 DSH 未启用官方 llm-pi-ai 模型配置服务')
    const existing = descriptor.value?.providers?.[providerId]
    if (existing && (existing.apiKeyEnv !== ref || existing.baseURL !== `${issuer}/v1`)) {
      throw new Error('现有供应商已被修改，请保留或手动移除后再配置')
    }
    if (!state || state.canRetryCreate) {
      let claimed = false
      await credentials.modifyRecord(key, current => {
        if (current !== undefined && !current.payload?.canRetryCreate) return undefined
        claimed = true
        state = { status: 'creating', flowId: randomUUID(), userId, issuer }
        return { kind: 'grant', payload: state }
      })
      if (!claimed) throw new Error('另一个配置任务已启动，请稍后重试')
      try {
        const created = await userApi(ctx, '/api/token/', {
          expectedUserId: userId,
          method: 'POST', body: JSON.stringify({ name: `DSH-${state.flowId}`, expired_time: -1,
            unlimited_quota: true, remain_quota: 0, group: '', model_limits_enabled: false,
            model_limits: '', allow_ips: '', cross_group_retry: false }),
        })
        if (!Number.isSafeInteger(created?.id) || created.id <= 0) {
          throw new Error('创建接口未返回 ID，请先更新网关后端；勿重复创建')
        }
        state = { ...state, tokenId: created.id, status: 'configuring' }
        await credentials.modifyRecord(key, () => ({ kind: 'grant', payload: state }))
      } catch (error) {
        // POST may have committed even when the response was lost. Do not replay it.
        state = { ...state, status: 'error', canRetryCreate: error.requestRejected === true,
          error: error.requestRejected === true ? '网关拒绝创建，请检查数量上限或限流后重试'
            : '未确认创建结果，请在网关检查本次 DSH key，勿重复创建' }
        await credentials.modifyRecord(key, () => ({ kind: 'grant', payload: state }))
        throw new Error(state.error)
      }
    }
    if (!state.tokenId) throw new Error(state.error ?? '创建结果尚未确认，请在网关检查本次 DSH key')
    let keyReadCompleted = false
    try {
      const value = await userApi(ctx, `/api/token/${state.tokenId}/key`, { method: 'POST', expectedUserId: userId })
      keyReadCompleted = true
      if (typeof value?.key !== 'string' || !value.key) throw new Error('未获取到模型 API key')
      const apiKey = value.key.startsWith('sk-') ? value.key : `sk-${value.key}`
      const available = await models(apiKey)
      const catalog = [...new Set(available.filter(model => model.supported_endpoint_types?.includes('openai'))
        .map(model => model.id).filter(model => typeof model === 'string' && model.length > 0))]
        .map(model => ({ id: model, name: model }))
      if (catalog.length === 0) throw new Error('没有已声明支持 OpenAI Chat Completions 的模型')
      await userApi(ctx, '/api/user/self', { expectedUserId: userId })
      // Keep credentials out of the provider profile and all client snapshots.
      await credentials.set(ref, apiKey)
      const latest = settings.describe({ redactSecrets: true }).find(row => row.ns === descriptor.ns)
      if (!latest) throw new Error('模型配置服务已卸载，请重试')
      const current = latest.value?.providers?.[providerId]
      if (current && (current.apiKeyEnv !== ref || current.baseURL !== `${issuer}/v1`)) {
        throw new Error('供应商配置已变更，请检查后重试')
      }
      if (!current) {
        await settings.mutate(descriptor.ns, [{ op: 'set', path: ['providers', providerId], value: {
          displayName: 'Anywhere 模型网关', api: 'openai-completions', baseURL: `${issuer}/v1`, apiKeyEnv: ref,
          // Explicit conservative fallback, not claimed model metadata.
          defaultContextWindow: 8192, defaultMaxTokens: 2048, models: catalog,
        } }], latest.revision)
      }
      const saved = settings.describe({ redactSecrets: true }).find(row => row.ns === descriptor.ns)
        ?.value?.providers?.[providerId]
      if (saved?.apiKeyEnv !== ref) throw new Error('供应商配置未保存，请重试')
      state = { ...state, status: 'ready', namespace: descriptor.ns,
        modelCount: saved.models?.length ?? catalog.length, error: null }
      await credentials.modifyRecord(key, () => ({ kind: 'grant', payload: state }))
      return { status: 'ready', modelCount: state.modelCount }
    } catch (error) {
      // The existing owned-key endpoint reports GORM's exact not-found message.
      // Only a confirmed missing key can restart creation, once per attempt.
      if (!keyReadCompleted && allowReplacement && error.requestRejected === true && error.message === 'record not found') {
        const missingTokenId = state.tokenId
        await credentials.modifyRecord(key, current => {
          if (current?.payload?.tokenId !== missingTokenId) return undefined
          return { kind: 'grant', payload: { ...current.payload, tokenId: undefined,
            status: 'error', canRetryCreate: true, error: null } }
        })
        return provision(ctx, userId, id, false)
      }
      // Avoid propagating upstream responses or provider errors containing secrets.
      state = { ...state, status: 'error', error: '配置未完成，请确认 key 有效、聊天模型可用且 DSH 配置可写后重试' }
      await credentials.modifyRecord(key, () => ({ kind: 'grant', payload: state }))
      throw new Error(state.error)
    }
  }

  return { run, status }
}
