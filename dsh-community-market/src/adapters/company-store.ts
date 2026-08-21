/**
 * Company Store built-in adapter for dsh-community-market.
 *
 * NEW key `company-store` — do not replace or retarget `dsh-1024store`.
 * Placeholder domain matches the company Store fork until DNS is real.
 *
 * Apply into: dsh-community-market/src/adapters/company-store.ts
 */
import { createDsh1024StyleStoreAdapter } from './dsh-1024-style-store.js'

export const COMPANY_STORE_KEY = 'company-store'
/** Placeholder — swap with the real public company Store apex before release. */
export const COMPANY_STORE_ENDPOINT = 'https://plugins.company.example/api/v1/plugins'
export const COMPANY_STORE_HOSTNAME = 'plugins.company.example'
export const COMPANY_STORE_PROVIDER_ID = 'com.company.store.catalog'
export const COMPANY_STORE_ADAPTER_ID = 'market.company-store-v1'

export const companyStoreAdapter = createDsh1024StyleStoreAdapter({
  key: COMPANY_STORE_KEY,
  endpoint: COMPANY_STORE_ENDPOINT,
  hostname: COMPANY_STORE_HOSTNAME,
  providerId: COMPANY_STORE_PROVIDER_ID,
  adapterId: COMPANY_STORE_ADAPTER_ID,
  errorLabel: 'Company Store',
})
