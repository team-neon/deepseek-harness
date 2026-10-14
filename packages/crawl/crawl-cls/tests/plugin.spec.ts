import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as crawl from '../src/index.ts'
import { signQuery } from '../src/sign.ts'
import { openStore } from '../src/store.ts'

const FROZEN_PAGE = JSON.parse(readFileSync(new URL('../fixtures/telegraph-page.json', import.meta.url), 'utf8')) as unknown
const DEFAULT_ENDPOINT = 'https://www.cls.cn/v1/roll/get_roll_list'

interface FetchCall {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function row(id: number, ctime: number, content = `body-${id}`) {
  return {
    id,
    ctime,
    title: '',
    content,
    shareurl: `https://www.cls.cn/detail/${id}`,
  }
}

function execContext(): ToolRunContext {
  return {
    signal: new AbortController().signal,
    deferContext() {},
    concludeTurn() {},
  } as unknown as ToolRunContext
}

describe('crawl-cls plugin', () => {
  const roots: string[] = []
  const fibers: Array<{ dispose: () => Promise<void> }> = []

  afterEach(async () => {
    for (const fiber of fibers.splice(0)) await fiber.dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'crawl-cls-plugin-'))
    roots.push(root)
    return root
  }

  async function boot(config: Record<string, unknown> = {}): Promise<{
    root: string
    tool: ToolDefinition
    fiber: { dispose: () => Promise<void> }
  }> {
    const root = typeof config.root === 'string' ? config.root : tempRoot()
    let tool: ToolDefinition | undefined
    class Tools extends Service {
      static inject = []
      constructor(ctx: Context) { super(ctx, 'tools') }
      register(definition: ToolDefinition): void { tool = definition }
    }
    const ctx = new Context()
    const tools = await ctx.plugin(Tools)
    fibers.push(tools)
    const fiber = await ctx.plugin(crawl, { root, ...config })
    fibers.push(fiber)
    if (tool === undefined) throw new Error('cls_telegraph_sync was not registered')
    return { root, tool, fiber }
  }

  function stubFetch(handler: (call: FetchCall) => Promise<Response> | Response): FetchCall[] {
    const calls: FetchCall[] = []
    vi.stubGlobal('fetch', (url: string | URL, init: RequestInit = {}) => {
      const call = { url: String(url), init }
      calls.push(call)
      return handler(call)
    })
    return calls
  }

  it('registers cls_telegraph_sync on the crawl-cls plugin', () => {
    expect(crawl.name).toBe('crawl-cls')
    expect(crawl.inject).toEqual(['tools'])
  })

  it('rejects a relative root and intervals from 1 through 59 at load', async () => {
    await expect(boot({ root: 'relative-crawl' })).rejects.toThrow(/absolute/)
    const root = tempRoot()
    await expect(boot({ root, intervalSeconds: 1 })).rejects.toThrow(/intervalSeconds/)
    await expect(boot({ root, intervalSeconds: 59 })).rejects.toThrow(/intervalSeconds/)
  })

  it('uses a 300s interval by default and skips setInterval when the interval is 0', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const root = tempRoot()
    await boot({ root, intervalSeconds: 0 })
    expect(setIntervalSpy).not.toHaveBeenCalled()

    setIntervalSpy.mockClear()
    await boot({ root: tempRoot(), intervalSeconds: 60 })
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 60_000)

    setIntervalSpy.mockClear()
    await boot({ root: tempRoot() })
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 300_000)
  })

  it('signs the default HTTPS query and stores one frozen page', async () => {
    const calls = stubFetch(() => calls.length > 1
      ? jsonResponse({ data: { roll_data: [] } })
      : jsonResponse(FROZEN_PAGE))
    const { root, tool } = await boot({ intervalSeconds: 0 })
    const counts = await tool.execute({}, execContext())

    expect(counts).toEqual({ created: 1, updated: 0, unchanged: 0, rejected: 1 })
    const url = new URL(calls[0]?.url ?? '')
    expect(`${url.origin}${url.pathname}`).toBe(DEFAULT_ENDPOINT)
    expect(url.searchParams.get('app')).toBe('CailianpressWeb')
    expect(url.searchParams.get('os')).toBe('web')
    expect(url.searchParams.get('sv')).toBe('8.4.6')
    expect(url.searchParams.get('refresh_type')).toBe('1')
    expect(url.searchParams.get('category')).toBe('')
    expect(url.searchParams.get('rn')).toBe('20')
    expect(url.searchParams.get('last_time')).toBeNull()
    expect(url.searchParams.get('sign')).toBe(signQuery({
      app: 'CailianpressWeb',
      os: 'web',
      sv: '8.4.6',
      refresh_type: '1',
      category: '',
      rn: '20',
    }))
    expect(calls[0]?.url).not.toContain('8.7.9')
    expect(calls[0]?.init.redirect).toBe('manual')
    expect(calls).toHaveLength(2)
    expect(existsSync(join(root, 'crawl', 'cls', 'telegraph', 'items', '123456.json'))).toBe(true)
  })

  it('sends the previous page oldest ctime as last_time and stops after the default 3 pages', async () => {
    let pages = 0
    const calls = stubFetch(() => {
      pages += 1
      return jsonResponse({
        data: { roll_data: [row(pages, 500 - pages), row(100 + pages, 100 - pages), row(200 + pages, 400 - pages)] },
      })
    })
    const { tool } = await boot({ intervalSeconds: 0, pageSize: 7 })
    await tool.execute({}, execContext())

    expect(pages).toBe(3)
    expect(calls).toHaveLength(3)
    expect(new URL(calls[0]?.url ?? '').searchParams.get('rn')).toBe('7')
    expect(new URL(calls[0]?.url ?? '').searchParams.get('refresh_type')).toBe('1')
    expect(new URL(calls[0]?.url ?? '').searchParams.get('last_time')).toBeNull()
    expect(new URL(calls[1]?.url ?? '').searchParams.get('refresh_type')).toBe('1')
    expect(new URL(calls[1]?.url ?? '').searchParams.get('last_time')).toBe(String(Math.min(499, 99, 399)))
    expect(new URL(calls[2]?.url ?? '').searchParams.get('refresh_type')).toBe('1')
    expect(new URL(calls[2]?.url ?? '').searchParams.get('last_time')).toBe(String(Math.min(498, 98, 398)))
    const second = {
      app: 'CailianpressWeb',
      os: 'web',
      sv: '8.4.6',
      refresh_type: '1',
      category: '',
      rn: '7',
      last_time: new URL(calls[1]?.url ?? '').searchParams.get('last_time') ?? '',
    }
    expect(new URL(calls[1]?.url ?? '').searchParams.get('sign')).toBe(signQuery(second))
  })

  it('does not follow a redirect that leaves HTTPS or allowedHosts', async () => {
    const calls = stubFetch(() => jsonResponse(null, 302, { location: 'https://evil.example/roll' }))
    const { root, tool } = await boot({ intervalSeconds: 0 })
    await expect(tool.execute({}, execContext())).resolves.toEqual({ created: 0, updated: 0, unchanged: 0, rejected: 0 })
    expect(calls).toHaveLength(1)
    expect(existsSync(join(root, 'crawl', 'cls', 'telegraph', 'items'))).toBe(false)

    const httpCalls = stubFetch((call) => {
      if (call.url.startsWith('http://')) throw new Error('refusing non-HTTPS fetch')
      return jsonResponse(null, 302, { location: 'http://www.cls.cn/v1/roll/get_roll_list' })
    })
    const httpRoot = tempRoot()
    const httpTool = (await boot({ root: httpRoot, intervalSeconds: 0, endpoint: 'http://www.cls.cn/v1/roll/get_roll_list' })).tool
    await expect(httpTool.execute({}, execContext())).resolves.toEqual({ created: 0, updated: 0, unchanged: 0, rejected: 0 })
    expect(httpCalls).toHaveLength(0)
  })

  it('follows a redirect only after the target host is allowed', async () => {
    const calls = stubFetch(() => {
      if (calls.length === 1) return jsonResponse(null, 302, { location: 'https://www.cls.cn/v1/roll/next' })
      return jsonResponse({ data: { roll_data: [row(7, 50)] } })
    })
    const { root, tool } = await boot({ intervalSeconds: 0, maxPages: 1 })
    await expect(tool.execute({}, execContext())).resolves.toMatchObject({ created: 1 })
    expect(calls.map(call => call.url)).toEqual([
      expect.stringContaining(DEFAULT_ENDPOINT),
      'https://www.cls.cn/v1/roll/next',
    ])
    expect(existsSync(join(root, 'crawl', 'cls', 'telegraph', 'items', '7.json'))).toBe(true)
  })

  it('treats timeout and oversized bodies as transport failures', async () => {
    const root = tempRoot()
    const store = openStore(root)
    store.commitCursor({
      lastSourceItemId: 'old',
      lastPublishedAt: '1970-01-01T00:00:01.000Z',
      updatedAt: '1970-01-01T00:00:01.000Z',
    })
    const cursorPath = join(root, 'crawl', 'cls', 'telegraph', 'cursor.json')
    const cursorBytes = readFileSync(cursorPath)

    stubFetch(call => new Promise((_resolve, reject) => {
      const abort = () => reject(new Error('aborted'))
      if (call.init.signal?.aborted === true) {
        abort()
        return
      }
      call.init.signal?.addEventListener('abort', abort, { once: true })
    }))
    const timeoutTool = (await boot({ root, intervalSeconds: 0, timeoutMs: 1000 })).tool
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = timeoutTool.execute({}, execContext())
    await vi.advanceTimersByTimeAsync(1000)
    await expect(pending).resolves.toEqual({ created: 0, updated: 0, unchanged: 0, rejected: 0 })
    expect(readFileSync(cursorPath)).toEqual(cursorBytes)
    vi.useRealTimers()

    stubFetch(() => jsonResponse({ data: { roll_data: [row(9, 80)] } }))
    const sized = (await boot({ root: tempRoot(), intervalSeconds: 0, maxResponseBytes: 4 })).tool
    await expect(sized.execute({}, execContext())).resolves.toEqual({ created: 0, updated: 0, unchanged: 0, rejected: 0 })
  })

  it('runs one round at a time: the timer returns and the tool waits', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let release: (() => void) | undefined
    let fetches = 0
    stubFetch(() => {
      fetches += 1
      return new Promise((resolve) => {
        release = () => resolve(jsonResponse({ data: { roll_data: [] } }))
      })
    })
    const { tool } = await boot({})
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fetches).toBe(1)
    const waiting = tool.execute({}, execContext())
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fetches).toBe(1)
    release?.()
    await expect(waiting).resolves.toEqual({ created: 0, updated: 0, unchanged: 0, rejected: 0 })

    const again = tool.execute({}, execContext())
    expect(fetches).toBe(2)
    release?.()
    await again
  })

  it('clears the interval and aborts the in-flight fetch on unload', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let signal: AbortSignal | undefined
    let fetches = 0
    stubFetch((_call) => {
      fetches += 1
      return new Promise((_resolve, reject) => {
        signal = _call.init.signal ?? undefined
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const { tool, fiber } = await boot({})
    const pending = tool.execute({}, execContext())
    expect(fetches).toBe(1)
    expect(signal?.aborted).toBe(false)
    await fiber.dispose()
    expect(signal?.aborted).toBe(true)
    expect(clearSpy).toHaveBeenCalled()
    await expect(pending).resolves.toEqual({ created: 0, updated: 0, unchanged: 0, rejected: 0 })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(fetches).toBe(1)
  })

  it('reads the stored watermark and does not rewrite an item that is not newer', async () => {
    const root = tempRoot()
    openStore(root).commitCursor({
      lastSourceItemId: '123456',
      lastPublishedAt: '2025-10-13T13:59:12.000Z',
      updatedAt: '2026-10-13T00:00:00.000Z',
    })
    const cursorPath = join(root, 'crawl', 'cls', 'telegraph', 'cursor.json')
    const before = readFileSync(cursorPath)
    stubFetch(() => jsonResponse(FROZEN_PAGE))
    const { tool } = await boot({ root, intervalSeconds: 0 })
    await expect(tool.execute({}, execContext())).resolves.toEqual({ created: 0, updated: 0, unchanged: 0, rejected: 1 })
    expect(readFileSync(cursorPath)).toEqual(before)
    expect(existsSync(join(root, 'crawl', 'cls', 'telegraph', 'items', '123456.json'))).toBe(false)
  })

  it('disables the bundle patch until NEONQUANT_CRAWL_ROOT is set', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).toContain('disabled: !!js "!process.env.NEONQUANT_CRAWL_ROOT"')
    expect(patch).toContain('root: !!js "process.env.NEONQUANT_CRAWL_ROOT"')
    expect(patch).toContain("name: '@deepseek-ai/dsh-crawl-cls'")
  })
})
