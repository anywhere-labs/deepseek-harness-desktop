import {
  COMPANY_STORE_ADAPTER_ID,
  COMPANY_STORE_HOSTNAME,
} from '../adapters/company-store.js'
import { createCachedCatalogHttpClient, createRestrictedHttpClient } from '../network/restricted-http.js'

const MAX_COMPANY_STORE_BODY_BYTES = 16 * 1024 * 1024

export const companyStoreHttpClient = createCachedCatalogHttpClient(
  createRestrictedHttpClient({
    syntheticProxyHostnames: [COMPANY_STORE_HOSTNAME],
    maxBodyBytes: MAX_COMPANY_STORE_BODY_BYTES,
  }),
)

export { COMPANY_STORE_ADAPTER_ID, COMPANY_STORE_HOSTNAME }
