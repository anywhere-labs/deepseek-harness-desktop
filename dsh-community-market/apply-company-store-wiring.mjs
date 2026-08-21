import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))

function patchRoutes() {
  const path = join(dir, 'src/host/routes.ts')
  let text = readFileSync(path, 'utf8')
  if (text.includes("from './company-store-http.js'")) return
  if (!text.includes("from '../adapters/dshfind.js'")) {
    throw new Error('routes.ts: missing dshfind import anchor')
  }
  text = text.replace(
    "import { DSHFIND_ADAPTER_ID, DSHFIND_HOSTNAME } from '../adapters/dshfind.js'\n",
    `import { DSHFIND_ADAPTER_ID, DSHFIND_HOSTNAME } from '../adapters/dshfind.js'
import {
  COMPANY_STORE_ADAPTER_ID,
  COMPANY_STORE_HOSTNAME,
  companyStoreHttpClient,
} from './company-store-http.js'
`,
  )
  const oldHosts = 'syntheticProxyHostnames: [DSH_1024STORE_HOSTNAME, \'github.com\', \'avatars.githubusercontent.com\'],'
  const newHosts = `syntheticProxyHostnames: [
        DSH_1024STORE_HOSTNAME,
        COMPANY_STORE_HOSTNAME,
        'github.com',
        'avatars.githubusercontent.com',
      ],`
  if (!text.includes(oldHosts)) throw new Error('routes.ts: missing media hostnames anchor')
  text = text.replace(oldHosts, newHosts)
  const oldMap = `adapterHttpClients: new Map([
      [DSH_1024STORE_ADAPTER_ID, dsh1024StoreHttpClient],
      [DSHFIND_ADAPTER_ID, dshfindHttpClient],
    ]),`
  const newMap = `adapterHttpClients: new Map([
      [DSH_1024STORE_ADAPTER_ID, dsh1024StoreHttpClient],
      [DSHFIND_ADAPTER_ID, dshfindHttpClient],
      [COMPANY_STORE_ADAPTER_ID, companyStoreHttpClient],
    ]),`
  if (!text.includes(oldMap)) throw new Error('routes.ts: missing adapterHttpClients anchor')
  text = text.replace(oldMap, newMap)
  writeFileSync(path, text)
}

function patchMarketSettingsTab() {
  const path = join(dir, 'src/client/MarketSettingsTab.tsx')
  let text = readFileSync(path, 'utf8')
  if (text.includes('CompanyStoreDisclaimerBanner')) return
  if (!text.includes("from './api.js'")) throw new Error('MarketSettingsTab: missing api import anchor')
  text = text.replace(
    "} from './api.js'\n",
    `} from './api.js'
import { CompanyStoreDisclaimerBanner } from './CompanyStoreDisclaimerBanner.js'
`,
  )
  const oldBanner = `      </div>
      <main className="dshMarketMain">`
  const newBanner = `      </div>
      <CompanyStoreDisclaimerBanner builtInProviderKey={currentSource?.builtInProviderKey} t={t} />
      <main className="dshMarketMain">`
  if (!text.includes(oldBanner)) throw new Error('MarketSettingsTab: missing banner anchor')
  text = text.replace(oldBanner, newBanner)
  writeFileSync(path, text)
}

patchRoutes()
patchMarketSettingsTab()
