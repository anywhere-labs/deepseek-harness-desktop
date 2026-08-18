# 目录接入与 adapter 指南

[English](catalog-adapter-guide.md)

状态：已实现的公开 v1 接入指南。权威 Schema 与兼容规则仍以[目录提供方契约](catalog-provider-contract.zh.md)为准。

DSH Community Market 对所有目录 provider 和用户自有来源开放。任何人都可以直接选择路径 A：发布符合 Schema 的公开 HTTPS JSON，并分享 manifest URL；无需修改 Market 代码，也无需先获得合作批准。需要路径 B 的 provider 也可以使用现有公开 API 提出经过审核的 adapter 合作接入。

## 选择一条接入路径

### A. 标准来源：无需编写 Market 代码

Provider 能在同一个 origin 发布两个匿名 HTTPS JSON 资源时，选择这条路径：

1. 一份静态 [`catalog-source` manifest](schemas/catalog-source.schema.json)；
2. 一个 GET `/v1/plugins` endpoint，返回 [`catalog-provider-page`](schemas/catalog-provider-page.schema.json)。

用户只登记 manifest URL。可以从[最小 manifest](examples/catalog-source.example.json)、[最小 query](examples/catalog-query.example.json)和[最小 page](examples/catalog-provider-page.minimal.example.json)开始。建议的最小能力只包含 `q`、`category`、`cursor` 和 `limit`，示例中的 `defaultLimit` 与 `maxLimit` 都是 50。这个值不是全局上限；标准来源可以在 Schema 安全上限 100 以内声明。重复 `category` 使用 OR 语义。以后可以增加可选元数据和媒体，不需要改变 transport。

当前 Desktop Host 会先建立完整本地索引，再提供 UI。它按照来源的有效网络 page limit 跟随当前已选来源的 cursor，之后在本地执行可见搜索、多分类 OR 筛选、分类枚举和每页 50 条的 UI 分页。Endpoint query 契约仍可供其他 consumer 和 adapter 测试使用，但当前 Desktop 全量扫描不会把用户的 `q` 或 `category` filter 发给 provider。标准来源每次可以返回不超过其声明有效 page limit 的条目；50 是 UI 可见 page size，不是通用 provider response 上限。

### B. 已有 API：受审 Host adapter

已有 API 无法返回标准 page 时，选择这条路径，并向 Market 团队提供：

- 公开 endpoint 文档与 response schema；
- 已移除 secret 的成功、空结果、分页和错误 response 样例；
- 稳定字段语义和分页规则；
- 来源声明、rate limit 和 provider 的图标所有权语义。

Adapter 是本地 TypeScript，经过审核与测试后随 Market 发布。它只使用受限 Host HTTP client，并返回经过校验的 `CatalogSnapshot`。开放合作不会绕过审核：manifest 或远程 response 绝不能提供 JavaScript、mapping 表达式、install command、credential 或 adapter 代码。

## 可复制 adapter skeleton

把适配后的版本放在 `src/adapters/example-provider.ts`。下面假设经审核的 API 接受 `search`、使用 OR 语义的重复 `tag`、`after` 和 `pageSize`；默认 page size 为 50，经过审核的最大值为 100。请根据 API 文档明确修改这些 mapping 和常量；不能做成由远程配置的 mapper。1024Store adapter 是有意设计的例外：只请求一次 registry，标准化为每块最多 100 条的 Schema 有界分块，之后由 Host 提供每页 50 条的本地 UI 结果。

```ts
import type { CatalogQuery, CatalogSnapshot } from '../contracts/index.js'
import type { CatalogAdapter, CatalogFetchContext } from '../contracts/types.js'
import { parseCatalogSnapshot } from '../contracts/validate.js'

const ADAPTER_ID = 'market.example-provider-v1'
const ENDPOINT = 'https://catalog.example.org/api/plugins'
const ORIGIN = new URL(ENDPOINT).origin
const DEFAULT_PAGE_LIMIT = 50
const MAX_PAGE_LIMIT = 100

interface RawPlugin {
  readonly id: string
  readonly title: string
  readonly summary: string
  readonly npm: string
  readonly categories?: readonly string[]
}

interface RawPage {
  readonly plugins: readonly RawPlugin[]
  readonly next?: string
  readonly total?: number
}

function readRawPage(value: unknown, effectiveLimit: number): RawPage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('example provider response is not an object')
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.plugins) || record.plugins.length > effectiveLimit) {
    throw new Error('example provider page is invalid')
  }
  const plugins = record.plugins.map((entry): RawPlugin => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('example provider item is invalid')
    }
    const item = entry as Record<string, unknown>
    if (
      typeof item.id !== 'string'
      || typeof item.title !== 'string'
      || typeof item.summary !== 'string'
      || typeof item.npm !== 'string'
      || (item.categories !== undefined
        && (!Array.isArray(item.categories) || item.categories.some(value => typeof value !== 'string')))
    ) {
      throw new Error('example provider item fields are invalid')
    }
    return {
      id: item.id,
      title: item.title,
      summary: item.summary,
      npm: item.npm,
      ...(item.categories === undefined ? {} : { categories: item.categories as string[] }),
    }
  })
  if (record.next !== undefined && (typeof record.next !== 'string' || record.next.length === 0)) {
    throw new Error('example provider cursor is invalid')
  }
  if (record.total !== undefined && (
    typeof record.total !== 'number'
    || !Number.isSafeInteger(record.total)
    || record.total < 0
  )) {
    throw new Error('example provider total is invalid')
  }
  return {
    plugins,
    ...(record.next === undefined ? {} : { next: record.next as string }),
    ...(record.total === undefined ? {} : { total: record.total as number }),
  }
}

function requestUrl(query: CatalogQuery, effectiveLimit: number): URL {
  const url = new URL(ENDPOINT)
  if (query.q !== undefined) url.searchParams.set('search', query.q)
  for (const category of query.category ?? []) url.searchParams.append('tag', category)
  if (query.cursor !== undefined) url.searchParams.set('after', query.cursor)
  url.searchParams.set('pageSize', String(effectiveLimit))
  return url
}

function snapshot(
  raw: RawPage,
  responseFinalUrl: string,
  context: CatalogFetchContext,
): CatalogSnapshot {
  return parseCatalogSnapshot({
    schemaVersion: '1.0.0',
    source: {
      sourceRecordId: context.source.sourceRecordId,
      providerId: context.source.providerId,
      adapterId: context.source.adapterId,
      registrationKind: context.source.registrationKind,
      fetchedAt: new Date().toISOString(),
      finalUrl: responseFinalUrl,
    },
    items: raw.plugins.map(item => ({
      id: item.id,
      name: item.npm,
      displayName: item.title,
      summary: item.summary,
      ...(item.categories === undefined ? {} : { categories: [...item.categories] }),
      package: { registry: 'npm', name: item.npm },
      provenance: {
        sourceRecordId: context.source.sourceRecordId,
        providerId: context.source.providerId,
        itemId: item.id,
      },
    })),
    page: {
      ...(raw.next === undefined ? {} : { nextCursor: raw.next }),
      ...(raw.total === undefined ? {} : { total: raw.total }),
    },
  })
}

export const exampleProviderAdapter: CatalogAdapter = {
  adapterId: ADAPTER_ID,
  async fetch(query, context) {
    const effectiveLimit = Math.min(query.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT)
    const response = await context.http.getJson(
      requestUrl(query, effectiveLimit).href,
      context.signal,
      { allowedOrigin: ORIGIN },
    )
    if (new URL(response.finalUrl).origin !== ORIGIN) {
      throw new Error('example provider response changed the reviewed origin')
    }
    return snapshot(readRawPage(response.value, effectiveLimit), response.finalUrl, context)
  },
}
```

只在 Host 的静态 adapter map 中登记它，并添加经过审核的内置 provider 定义。这是一次代码评审变更，绝不是 provider 数据：

```ts
import { exampleProviderAdapter } from '../adapters/example-provider.js'

const adapters = new Map<string, CatalogAdapter>([
  [standardHttpAdapter.adapterId, standardHttpAdapter],
  [dsh1024StoreAdapter.adapterId, dsh1024StoreAdapter],
  [exampleProviderAdapter.adapterId, exampleProviderAdapter],
])
```

## 评审清单

- Endpoint 与 allowed origin 是编译期受审常量。
- Adapter 在 mapping 前解析 provider response 并执行边界限制。
- 搜索、重复分类 OR 过滤、cursor 归属、默认 page size、受审最大值和超限 response 拒绝都有明确测试。
- 每个条目都有 package 或标准化 repository identity，以及由 Host 注入的 provenance。
- Provider command、HTML、script、credential 和未知字段都不能进入 snapshot。
- 可选图标通过 `context.media.register()` 登记精确受审 hostname；Renderer 只能获得 `assetRef`。
- Timeout、redirect、response size、取消和已选来源重置测试通过。
- Adapter 与内置 provider 定义随同一份经过审核的 Market release 发布。

Adapter 的行为和发布生命周期由 Market 团队负责，而不是远程 provider。
