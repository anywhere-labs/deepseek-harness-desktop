/**
 * Official DSH 1024Store adapter — thin wrapper over the shared factory.
 * Behavior and exported constants stay identical to the pre-extraction adapter.
 */
import { createDsh1024StyleStoreAdapter } from './dsh-1024-style-store.js'

export const DSH_1024STORE_KEY = 'dsh-1024store'
export const DSH_1024STORE_ENDPOINT = 'https://deepseek1024.com/api/v1/plugins'
export const DSH_1024STORE_HOSTNAME = 'deepseek1024.com'
export const DSH_1024STORE_PROVIDER_ID = 'com.deepseek1024.catalog'
export const DSH_1024STORE_ADAPTER_ID = 'market.dsh-1024store-v1'

export const dsh1024StoreAdapter = createDsh1024StyleStoreAdapter({
  key: DSH_1024STORE_KEY,
  endpoint: DSH_1024STORE_ENDPOINT,
  hostname: DSH_1024STORE_HOSTNAME,
  providerId: DSH_1024STORE_PROVIDER_ID,
  adapterId: DSH_1024STORE_ADAPTER_ID,
  errorLabel: '1024Store',
})

export type { Dsh1024StoreRawItem } from './dsh-1024-style-store.js'
