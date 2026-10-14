/**
 * Cailian Press telegraph crawl plugin.
 * A profile mounts this bundle, and NEONQUANT_CRAWL_ROOT enables the interval.
 * @module @deepseek-ai/dsh-crawl-cls
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { assertHttpsHost } from './policy.ts'
import { runOnce } from './run.ts'
import type { RunCounts } from './run.ts'
import { signQuery } from './sign.ts'
import { openStore } from './store.ts'

/** Cordis plugin name. */
export const name = 'crawl-cls'

/** The tool registry that receives `cls_telegraph_sync`. */
export const inject = ['tools']

const DEFAULT_ENDPOINT = 'https://www.cls.cn/v1/roll/get_roll_list'
const DEFAULT_INTERVAL_SECONDS = 300
const DEFAULT_MAX_PAGES = 3
const DEFAULT_PAGE_SIZE = 20
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_RESPONSE_BYTES = 5_000_000
const MAX_REDIRECTS = 5

/** Telegraph crawl configuration. `intervalSeconds` is 0 or at least 60. */
export interface Config {
  /** Absolute directory that receives `crawl/cls/telegraph`. */
  root: string
  /** Seconds between rounds. 0 keeps manual sync only. Defaults to 300. */
  intervalSeconds?: number
  /** Maximum pages in one round. Defaults to 3. */
  maxPages?: number
  /** Page size sent as `rn`. Defaults to 20. */
  pageSize?: number
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number
  /** Maximum response body size in bytes. Defaults to 5000000. */
  maxResponseBytes?: number
  /** Telegraph list URL. Defaults to the Cailian Press roll endpoint. */
  endpoint?: string
  /** HTTPS hosts that requests and redirects may use. Defaults to the endpoint host. */
  allowedHosts?: string[]
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  root: z.string().required(),
  intervalSeconds: z.number(),
  maxPages: z.number(),
  pageSize: z.number(),
  timeoutMs: z.number(),
  maxResponseBytes: z.number(),
  endpoint: z.string(),
  allowedHosts: z.array(z.string()),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertInterval(intervalSeconds: number): void {
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 0 || (intervalSeconds > 0 && intervalSeconds < 60)) {
    throw new Error('intervalSeconds must be 0 or at least 60')
  }
}

function oldestCtime(page: unknown): number | undefined {
  if (!isRecord(page) || !isRecord(page.data) || !Array.isArray(page.data.roll_data)) return undefined
  let oldest: number | undefined
  for (const entry of page.data.roll_data) {
    if (!isRecord(entry) || typeof entry.ctime !== 'number' || !Number.isFinite(entry.ctime)) continue
    if (oldest === undefined || entry.ctime < oldest) oldest = entry.ctime
  }
  return oldest
}

async function readLimited(response: Response, maxResponseBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('response has no body')
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > maxResponseBytes) {
      await reader.cancel()
      throw new Error('response exceeds maxResponseBytes')
    }
    chunks.push(value)
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

interface LiveFetchInput {
  endpoint: string
  allowedHosts: readonly string[]
  pageSize: number
  timeoutMs: number
  maxResponseBytes: number
  lastTime?: number
  signal: AbortSignal
}

async function fetchTelegraphPage(input: LiveFetchInput): Promise<{ page: unknown; oldestCtime?: number }> {
  // 按 HTTPS 拉取一页财联社电报，翻页带 refresh_type=1，否则接口忽略 last_time。先对不含 sign 的参数调用 signQuery，再校验请求和重定向主机。
  const params: Record<string, string> = {
    app: 'CailianpressWeb',
    os: 'web',
    sv: '8.4.6',
    refresh_type: '1',
    category: '',
    rn: String(input.pageSize),
  }
  if (input.lastTime !== undefined) params.last_time = String(input.lastTime)
  params.sign = signQuery(params)
  const url = new URL(input.endpoint)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  assertHttpsHost(url, input.allowedHosts)

  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), input.timeoutMs)
  const signal = AbortSignal.any([input.signal, timeout.signal])
  try {
    let current = url
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      assertHttpsHost(current, input.allowedHosts)
      const response = await globalThis.fetch(current, { redirect: 'manual', signal })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (location === null) throw new Error('redirect missing location')
        current = new URL(location, current)
        continue
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await readLimited(response, input.maxResponseBytes)
      const page: unknown = JSON.parse(text)
      return { page, oldestCtime: oldestCtime(page) }
    }
    throw new Error('too many redirects')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Register the telegraph sync tool and, unless the interval is 0, the crawl timer.
 * @param ctx - plugin context. The timer and the in-flight request end with it.
 * @param config - crawl root, schedule, and HTTPS endpoint.
 */
export function apply(ctx: Context, config: Config): void {
  // 定时抓取财联社电报，并提供手动同步工具。同一时刻只保留一轮，卸载时 clearInterval 并中止进行中的请求。
  if (!isAbsolute(config.root)) throw new Error('root must be an absolute path')
  const intervalSeconds = config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS
  assertInterval(intervalSeconds)
  const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES
  const pageSize = config.pageSize ?? DEFAULT_PAGE_SIZE
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const endpoint = config.endpoint ?? DEFAULT_ENDPOINT
  const allowedHosts = config.allowedHosts !== undefined && config.allowedHosts.length > 0
    ? config.allowedHosts
    : [new URL(endpoint).hostname]
  const store = openStore(config.root)
  let round: Promise<RunCounts> | undefined
  let roundAbort: AbortController | undefined

  const startRound = (): Promise<RunCounts> => {
    if (round !== undefined) return round
    const abort = new AbortController()
    roundAbort = abort
    const pending = runOnce({
      fetchPage: input => fetchTelegraphPage({
        endpoint,
        allowedHosts,
        pageSize,
        timeoutMs,
        maxResponseBytes,
        lastTime: input.lastTime,
        signal: input.signal,
      }),
      store,
      cursor: store.readCursor(),
      maxPages,
      now: new Date().toISOString(),
      signal: abort.signal,
    }).finally(() => {
      if (round === pending) round = undefined
      if (roundAbort === abort) roundAbort = undefined
    })
    round = pending
    return pending
  }

  ctx.tools.register(defineTool({
    name: 'cls_telegraph_sync',
    description: 'Sync the latest Cailian Press telegraph items into the configured crawl directory. Returns created, updated, unchanged, and rejected counts for that round.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          created: { type: 'integer', required: true, description: 'Items stored for the first time.' },
          updated: { type: 'integer', required: true, description: 'Items whose canonical content changed.' },
          unchanged: { type: 'integer', required: true, description: 'Items whose canonical content was already stored.' },
          rejected: { type: 'integer', required: true, description: 'Rows that could not be mapped.' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `created ${value.created}, updated ${value.updated}, unchanged ${value.unchanged}, rejected ${value.rejected}`,
      }],
    },
    execute() {
      return startRound()
    },
  }))

  const timer = intervalSeconds === 0
    ? undefined
    : setInterval(() => {
      if (round !== undefined) return
      void startRound()
    }, intervalSeconds * 1000)
  ctx.effect(() => () => {
    if (timer !== undefined) clearInterval(timer)
    roundAbort?.abort()
  })
}
