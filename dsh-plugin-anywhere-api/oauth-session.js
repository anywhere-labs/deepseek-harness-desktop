/** Resolve tokens under the credential provider's atomic record lock. */
export function createAccessTokenResolver({ key, refresh, skewSeconds = 60 }) {
  const pending = new WeakMap()
  return async function accessToken(credentials, rejectedToken) {
    if (!credentials) return undefined
    if (pending.has(credentials)) {
      const token = await pending.get(credentials)
      if (rejectedToken !== undefined && token === rejectedToken) {
        return accessToken(credentials, rejectedToken)
      }
      return token
    }
    const operation = (async () => {
      let token
      // Re-read inside the provider lock: another request/process may have rotated
      // the grant. Saving the replacement is part of the same atomic operation.
      await credentials.modifyRecord(key, async record => {
        if (record?.kind !== 'grant') return undefined
        const grant = record.payload
        const fresh = typeof grant.accessToken === 'string'
          && grant.expiresAt - skewSeconds > Math.floor(Date.now() / 1000)
        if (fresh && grant.accessToken !== rejectedToken) {
          token = grant.accessToken
          return undefined
        }
        if (typeof grant.refreshToken !== 'string') throw new Error('登录凭据不完整，请重新登录')
        const next = await refresh(grant.refreshToken)
        token = next.accessToken
        return { kind: 'grant', payload: next }
      })
      return token
    })()
    pending.set(credentials, operation)
    try {
      return await operation
    } finally {
      pending.delete(credentials)
    }
  }
}
