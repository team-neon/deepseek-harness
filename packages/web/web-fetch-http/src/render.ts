/**
 * One-shot rendered fetch. Opens a fresh headless Chromium, waits for the
 * deployment's ready condition, and returns the DOM as HTML. The browser is
 * not a Session and is closed before the function returns.
 * @module @deepseek-ai/dsh-web-fetch-http/render
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RenderReadyState } from './policy.ts'

/** HTML and final location produced by one rendered navigation. */
export interface RenderedPage {
  /** The page URL after same-origin redirects the browser followed. */
  readonly url: string
  /** HTTP status of the document response. */
  readonly statusCode: number
  /** `document.documentElement.outerHTML` after the ready condition. */
  readonly html: string
}

/** Inputs for one rendered navigation. Cancellation is the caller's deadline signal. */
export interface PageRenderRequest {
  /** Already validated public HTTP(S) URL. */
  readonly url: string
  /** Aborts launch, navigation, and the ready wait. */
  readonly signal: AbortSignal
  /** Which browser event must fire before the DOM is read. */
  readonly ready: RenderReadyState
  /** Startup budget passed to the browser process, in milliseconds. */
  readonly timeoutMs: number
  /** Product `User-Agent`. The browser does not send cookies or credentials. */
  readonly userAgent: string
  /** Chromium executable. Omitted looks up the stable system Chrome. */
  readonly executablePath?: string
}

/** Replaceable renderer so tests can skip launching Chromium. */
export type PageRenderer = (request: PageRenderRequest) => Promise<RenderedPage>

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { message?: string }
}

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(listener: (message: CdpMessage) => void): void
  off(listener: (message: CdpMessage) => void): void
  close(): void
}

/** Turn an abort reason into an `Error` so a string reason still rejects as an error. */
function rejection(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error('web fetch aborted')
}

/** Quiet window after `load` before a `networkidle` render reads the DOM. */
const NETWORK_IDLE_QUIET_MS = 500

/** How often to poll the browser's page list before the debugging socket exists. */
const PAGE_TARGET_POLL_MS = 50

/** Locations checked when a deployment does not name `executablePath`. */
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

/**
 * 打开公网页面并取渲染后的 DOM。
 * 启动一次无头 Chromium，等到配置的就绪条件后读取 outerHTML，然后关掉浏览器。
 */
export async function renderPublicPage(
  request: PageRenderRequest,
  candidates: readonly string[] = CHROME_CANDIDATES,
): Promise<RenderedPage> {
  request.signal.throwIfAborted()
  const executablePath = await resolveChromeExecutable(request.executablePath, candidates)
  const profile = await mkdtemp(join(tmpdir(), 'dsh-web-fetch-chrome-'))
  let child: ChildProcess | undefined
  let closing: Promise<void> | undefined
  const close = () => closing ??= closeBrowser(child, profile)
  const abort = () => { void close() }
  request.signal.addEventListener('abort', abort, { once: true })
  try {
    child = spawn(executablePath, chromeArgs(profile, request.userAgent), {
      env: scrubbedBrowserEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const endpoint = await waitForDevtools(child, request.timeoutMs, request.signal)
    request.signal.throwIfAborted()
    const pageSocket = await pageDebuggerUrl(endpoint, request.timeoutMs, request.signal)
    const session = await openCdp(pageSocket, request.signal)
    try {
      return await readRenderedPage(session, request)
    } finally {
      session.close()
    }
  } finally {
    request.signal.removeEventListener('abort', abort)
    await close()
  }
}

/** Prefer the configured executable, otherwise the first runnable known Chrome path. */
async function resolveChromeExecutable(explicit: string | undefined, candidates: readonly string[]): Promise<string> {
  if (explicit !== undefined && explicit.length > 0) {
    if (!(await pathIsExecutable(explicit))) throw new Error(`Chromium executable is not runnable: ${explicit}`)
    return explicit
  }
  for (const candidate of candidates) {
    if (await pathIsExecutable(candidate)) return candidate
  }
  throw new Error('Chromium executable was not found')
}

/** `access` reports whether this process may execute `path`. */
async function pathIsExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Flags for one anonymous headless navigation. The profile is removed with the process. */
function chromeArgs(profile: string, userAgent: string): string[] {
  return [
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    `--user-data-dir=${profile}`,
    `--user-agent=${userAgent}`,
    'about:blank',
  ]
}

/** Drop credential-shaped and harness-internal variables before the browser inherits the environment. */
function scrubbedBrowserEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    /* v8 ignore next -- process.env values are strings; the guard matches the declared value type. */
    if (typeof value !== 'string') continue
    if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key)) continue
    if (key.toUpperCase().startsWith('DSH_')) continue
    env[key] = value
  }
  return env
}

/** Stop the browser if it is still running, then delete the temporary profile. */
async function closeBrowser(child: ChildProcess | undefined, profile: string): Promise<void> {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill()
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      child.once('exit', () => { resolve() })
    })
  }
  await rm(profile, { recursive: true, force: true })
}

/** Resolve when Chromium prints its debugging socket, or reject on exit, error, timeout, or abort. */
function waitForDevtools(child: ChildProcess, timeoutMs: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const stderr = child.stderr
  if (stderr === null) throw new Error('Chromium stderr is not piped')
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => { fail(new Error('Chromium did not open a debugging port')) }, timeoutMs)
    const onAbort = () => { fail(rejection(signal.reason)) }
    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString()
      const endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(buffer)?.[1]
      if (endpoint === undefined) return
      cleanup()
      resolve(endpoint)
    }
    const onExit = () => { fail(new Error('Chromium exited before opening a debugging port')) }
    const onError = (error: Error) => { fail(error) }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      stderr.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    stderr.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

/** Find the about:blank page target on the browser's debugging port. */
async function pageDebuggerUrl(browserSocket: string, timeoutMs: number, signal: AbortSignal): Promise<string> {
  const port = new URL(browserSocket).port
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (Date.now() > deadline) throw new Error('Chromium did not expose a page target')
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal })
    const targets = await response.json() as unknown
    if (!Array.isArray(targets)) throw new Error('Chromium did not expose a page target')
    const page = targets.find((target: { type?: string; webSocketDebuggerUrl?: string }) => (
      target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string'
    )) as { webSocketDebuggerUrl?: string } | undefined
    if (page?.webSocketDebuggerUrl !== undefined) return page.webSocketDebuggerUrl
    await delay(PAGE_TARGET_POLL_MS, signal)
  }
}

/** Drive one page: enable events, navigate, wait, then read the DOM. */
async function readRenderedPage(session: CdpSession, request: PageRenderRequest): Promise<RenderedPage> {
  await session.send('Page.enable')
  await session.send('Network.enable')
  await session.send('Network.setUserAgentOverride', { userAgent: request.userAgent })
  await session.send('Network.clearBrowserCookies')
  let statusCode = 0
  const onResponse = (message: CdpMessage) => {
    if (message.method !== 'Network.responseReceived') return
    const params = message.params
    if (params === undefined || params['type'] !== 'Document') return
    const response = params['response']
    if (typeof response !== 'object' || response === null) return
    const status = (response as { status?: unknown }).status
    if (typeof status === 'number') statusCode = status
  }
  session.on(onResponse)
  try {
    const navigated = await session.send('Page.navigate', { url: request.url }) as { errorText?: string }
    if (navigated.errorText !== undefined && navigated.errorText.length > 0) throw new Error(navigated.errorText)
    await waitUntilReady(session, request.ready, request.signal)
    const evaluated = await session.send('Runtime.evaluate', {
      expression: '({ href: location.href, html: document.documentElement ? document.documentElement.outerHTML : "" })',
      returnByValue: true,
    }) as { result?: { value?: { href?: unknown; html?: unknown } }; exceptionDetails?: unknown }
    if (evaluated.exceptionDetails !== undefined) throw new Error('rendered page evaluation failed')
    const href = evaluated.result?.value?.href
    const html = evaluated.result?.value?.html
    if (typeof href !== 'string' || typeof html !== 'string') throw new Error('rendered page did not return a document')
    if (statusCode === 0) throw new Error('rendered page did not produce a document response')
    return { url: href, statusCode, html }
  } finally {
    session.off(onResponse)
  }
}

/** Wait for the configured browser event. `networkidle` follows `load` with a quiet period. */
async function waitUntilReady(session: CdpSession, ready: RenderReadyState, signal: AbortSignal): Promise<void> {
  if (ready === 'domcontentloaded') {
    await waitForMethod(session, 'Page.domContentEventFired', signal)
    return
  }
  await waitForMethod(session, 'Page.loadEventFired', signal)
  if (ready === 'load') return
  await waitForNetworkIdle(session, signal)
}

/** Resolve on the next CDP event of `method`, or reject when `signal` aborts. */
function waitForMethod(session: CdpSession, method: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(rejection(signal.reason))
    }
    const onMessage = (message: CdpMessage) => {
      if (message.method !== method) return
      cleanup()
      resolve()
    }
    const cleanup = () => {
      session.off(onMessage)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    session.on(onMessage)
  })
}

/** After load, wait until no network event has arrived for a short quiet window. */
function waitForNetworkIdle(session: CdpSession, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let inflight = 0
    let quiet: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      cleanup()
      resolve()
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    const arm = () => {
      if (quiet !== undefined) clearTimeout(quiet)
      if (inflight === 0) quiet = setTimeout(finish, NETWORK_IDLE_QUIET_MS)
    }
    const onMessage = (message: CdpMessage) => {
      if (message.method === 'Network.requestWillBeSent') {
        inflight += 1
        if (quiet !== undefined) {
          clearTimeout(quiet)
          quiet = undefined
        }
      }
      if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') {
        inflight = Math.max(0, inflight - 1)
        arm()
      }
    }
    const onAbort = () => { fail(rejection(signal.reason)) }
    const cleanup = () => {
      if (quiet !== undefined) clearTimeout(quiet)
      session.off(onMessage)
      signal.removeEventListener('abort', onAbort)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    session.on(onMessage)
    arm()
  })
}

/** Attach a page debugging socket and dispatch CDP commands by id. */
function openCdp(url: string, signal: AbortSignal): Promise<CdpSession> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
    const listeners = new Set<(message: CdpMessage) => void>()
    let next = 0
    const fail = (error: Error) => {
      signal.removeEventListener('abort', onAbort)
      ws.close()
      reject(error)
    }
    const onAbort = () => { fail(rejection(signal.reason)) }
    if (signal.aborted) {
      fail(rejection(signal.reason))
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    ws.addEventListener('error', () => { fail(new Error('Chromium debugging socket failed')) }, { once: true })
    ws.addEventListener('message', (event) => {
      let message: CdpMessage
      try {
        message = JSON.parse(String(event.data)) as CdpMessage
      } catch {
        return
      }
      if (message.id !== undefined) {
        const waiter = pending.get(message.id)
        pending.delete(message.id)
        if (waiter === undefined) return
        if (message.error !== undefined) waiter.reject(new Error(message.error.message ?? 'CDP command failed'))
        else waiter.resolve(message.result)
        return
      }
      for (const listener of listeners) listener(message)
    })
    ws.addEventListener('open', () => {
      signal.removeEventListener('abort', onAbort)
      resolve({
        send(method, params) {
          const id = ++next
          return new Promise((resolveSend, rejectSend) => {
            pending.set(id, { resolve: resolveSend, reject: rejectSend })
            ws.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }))
          })
        },
        on(listener) { listeners.add(listener) },
        off(listener) { listeners.delete(listener) },
        close() { ws.close() },
      })
    }, { once: true })
  })
}

/** Pause until `ms` elapse or `signal` aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(rejection(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
