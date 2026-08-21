import type { CatalogAdapter } from '../contracts/types.js'
import { DSH_1024STORE_ADAPTER_ID, DSH_1024STORE_ENDPOINT, DSH_1024STORE_KEY, DSH_1024STORE_PROVIDER_ID, dsh1024StoreAdapter } from '../adapters/dsh-1024store.js'
import { DSHFIND_ADAPTER_ID, DSHFIND_ENDPOINT, DSHFIND_KEY, DSHFIND_PROVIDER_ID, dshfindAdapter } from '../adapters/dshfind.js'
import {
  COMPANY_STORE_ADAPTER_ID,
  COMPANY_STORE_ENDPOINT,
  COMPANY_STORE_KEY,
  COMPANY_STORE_PROVIDER_ID,
  companyStoreAdapter,
} from '../adapters/company-store.js'
import { standardHttpAdapter } from '../adapters/standard-http.js'

export interface BuiltInProviderDefinition {
  readonly key: string
  readonly name: string
  readonly description: string
  readonly providerId: string
  readonly adapterId: string
  readonly endpoint: string
  readonly attribution: {
    readonly name: string
    readonly url: string
    readonly notice?: string
  }
  readonly partnership: boolean
}

export const BUILT_IN_PROVIDERS: readonly BuiltInProviderDefinition[] = [
  {
    key: DSH_1024STORE_KEY,
    name: 'DSH 1024Store',
    description: '合作提供方目录。需要用户明确添加并启用。目录收录不代表插件经过审核或推荐。',
    providerId: DSH_1024STORE_PROVIDER_ID,
    adapterId: DSH_1024STORE_ADAPTER_ID,
    endpoint: DSH_1024STORE_ENDPOINT,
    attribution: {
      name: 'DSH 1024Store',
      url: 'https://deepseek1024.com',
      notice: 'Community catalog data provided by a cooperating provider.',
    },
    partnership: true,
  },
  {
    key: DSHFIND_KEY,
    name: 'dshfind',
    description: '合作提供方目录。需要用户明确添加并启用。目录收录不代表插件经过审核或推荐。',
    providerId: DSHFIND_PROVIDER_ID,
    adapterId: DSHFIND_ADAPTER_ID,
    endpoint: DSHFIND_ENDPOINT,
    attribution: {
      name: 'dshfind',
      url: 'https://dshfind.com',
      notice: 'Community catalog data provided by a cooperating provider.',
    },
    partnership: true,
  },
  {
    key: COMPANY_STORE_KEY,
    name: 'Company Store',
    description: '公司目录，收录≠安全审核。需要用户明确添加并启用。',
    providerId: COMPANY_STORE_PROVIDER_ID,
    adapterId: COMPANY_STORE_ADAPTER_ID,
    endpoint: COMPANY_STORE_ENDPOINT,
    attribution: {
      name: '公司插件目录',
      url: 'https://plugins.company.example',
      notice: 'Company-reviewed catalog. Listing means inclusion only — not a security audit.',
    },
    partnership: true,
  },
]

export const adapters = new Map<string, CatalogAdapter>([
  [standardHttpAdapter.adapterId, standardHttpAdapter],
  [dsh1024StoreAdapter.adapterId, dsh1024StoreAdapter],
  [dshfindAdapter.adapterId, dshfindAdapter],
  [companyStoreAdapter.adapterId, companyStoreAdapter],
])

export const catalogAdapters = adapters
