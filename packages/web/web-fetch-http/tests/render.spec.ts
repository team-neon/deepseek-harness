import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderPublicPage } from '../src/render.ts'
import type { PageRenderRequest } from '../src/render.ts'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return { ...actual, spawn: spawnMock }
})

const MISSING = ['/no/such/dsh-chrome-a', '/no/such/dsh-chrome-b']
const FOUND = ['/no/such/dsh-chrome-a', process.execPath]

type ChromeMode = 'ok' | 'throw' | 'silent' | 'error' | 'exit' | 'abort' | 'no-stderr'
type FetchMode = 'page' | 'throw' | 'object' | 'empty' | 'retry' | 'abort-delay'
type SocketMode = 'open' | 'error' | 'stall' | 'abort-now'

interface Command {
  id: number
  method: string
  params?: Record<string, unknown>
}

class FakeChrome extends EventEmitter {
  stdout = new EventEmitter()
  stderr: EventEmitter | null
  stdin = null
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false

  constructor() {
    super()
    this.stderr = chromeMode === 'no-stderr' ? null : new EventEmitter()
  }

  kill(): boolean {
    this.killed = true
    const finish = () => {
      this.signalCode = 'SIGTERM'
      this.emit('exit', null, 'SIGTERM')
    }
    if (killSync) finish()
    else queueMicrotask(finish)
    return true
  }
}

class FakeSocket extends EventTarget {
  sent: string[] = []

  constructor(readonly url: string) {
    super()
    if (socketMode === 'abort-now') {
      controller.abort()
      return
    }
    queueMicrotask(() => {
      if (socketMode === 'error') {
        this.dispatchEvent(new Event('error'))
        return
      }
      if (socketMode === 'stall') {
        setTimeout(() => { controller.abort() }, 20)
        return
      }
      this.dispatchEvent(new MessageEvent('message', { data: 'not-json' }))
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 0, result: {} }) }))
      this.dispatchEvent(new Event('open'))
    })
  }

  send(data: string): void {
    this.sent.push(data)
    const command = JSON.parse(data) as Command
    queueMicrotask(() => { onCommand(this, command) })
  }

  close(): void {}
}

let chromeMode: ChromeMode = 'ok'
let fetchMode: FetchMode = 'page'
let socketMode: SocketMode = 'open'
let killSync = false
let fetches = 0
let controller = new AbortController()
let readyEvent = 'Page.loadEventFired'
let navigateResult: { errorText?: string } = { errorText: '' }
let evaluateResult: unknown = { result: { value: { href: 'https://example.com/ready', html: '<p>ready</p>' } } }
let onCommand: (socket: FakeSocket, command: Command) => void = defaultOnCommand
let lastChild: FakeChrome | undefined

function emit(socket: FakeSocket, message: { method: string; params?: Record<string, unknown> }): void {
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) }))
}

function reply(socket: FakeSocket, id: number, result: unknown): void {
  socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id, result }) }))
}

function defaultOnCommand(socket: FakeSocket, command: Command): void {
  if (command.method === 'Page.navigate') {
    emit(socket, { method: 'Network.requestWillBeSent' })
    emit(socket, { method: 'Network.responseReceived' })
    emit(socket, { method: 'Network.responseReceived', params: { type: 'Script' } })
    emit(socket, { method: 'Network.responseReceived', params: { type: 'Document' } })
    emit(socket, { method: 'Network.responseReceived', params: { type: 'Document', response: null } })
    emit(socket, { method: 'Network.responseReceived', params: { type: 'Document', response: { status: 'nope' } } })
    emit(socket, { method: 'Network.responseReceived', params: { type: 'Document', response: { status: 200 } } })
    reply(socket, command.id, navigateResult)
    setTimeout(() => { emit(socket, { method: readyEvent }) }, 0)
    return
  }
  if (command.method === 'Runtime.evaluate') {
    reply(socket, command.id, evaluateResult)
    return
  }
  reply(socket, command.id, {})
}

function boot(child: FakeChrome): void {
  queueMicrotask(() => {
    if (chromeMode === 'silent' || chromeMode === 'no-stderr') return
    if (chromeMode === 'error') {
      child.emit('error', new Error('spawn failed'))
      return
    }
    if (chromeMode === 'exit') {
      child.exitCode = 1
      child.emit('exit', 1, null)
      return
    }
    if (chromeMode === 'abort') {
      controller.abort('stop')
      return
    }
    if (child.stderr === null) return
    child.stderr.emit('data', Buffer.from('noise\n'))
    child.stderr.emit('data', Buffer.from('DevTools listening on ws://127.0.0.1:9/devtools/browser/abc\n'))
  })
}

function installSpawn(): void {
  spawnMock.mockImplementation(() => {
    if (chromeMode === 'throw') throw new Error('spawn failed')
    const child = new FakeChrome()
    lastChild = child
    boot(child)
    return child
  })
}

function pageList(): { type: string; webSocketDebuggerUrl?: string }[] {
  return [{ type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9/devtools/page/1' }]
}

function installFetch(): void {
  vi.stubGlobal('fetch', () => {
    fetches += 1
    if (fetchMode === 'throw') return Promise.reject(new Error('debug port closed'))
    if (fetchMode === 'object') return Promise.resolve({ json: async () => ({}) })
    if (fetchMode === 'empty') return Promise.resolve({ json: async () => [] })
    if (fetchMode === 'abort-delay') {
      setTimeout(() => { controller.abort() }, 10)
      return Promise.resolve({ json: async () => [] })
    }
    if (fetchMode === 'retry' && fetches === 1) {
      return Promise.resolve({ json: async () => [{ type: 'other' }, { type: 'page' }] })
    }
    return Promise.resolve({ json: async () => pageList() })
  })
}

function request(overrides: Partial<PageRenderRequest> = {}): PageRenderRequest {
  return {
    url: 'https://example.com/',
    signal: controller.signal,
    ready: 'load',
    timeoutMs: 2_000,
    userAgent: 'Harness/test',
    ...overrides,
  }
}

function profileFromSpawn(): string {
  const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined
  const found = args?.find(arg => arg.startsWith('--user-data-dir='))
  if (found === undefined) throw new Error('missing profile arg')
  return found.slice('--user-data-dir='.length)
}

beforeEach(() => {
  chromeMode = 'ok'
  fetchMode = 'page'
  socketMode = 'open'
  killSync = false
  fetches = 0
  controller = new AbortController()
  readyEvent = 'Page.loadEventFired'
  navigateResult = { errorText: '' }
  evaluateResult = { result: { value: { href: 'https://example.com/ready', html: '<p>ready</p>' } } }
  onCommand = defaultOnCommand
  lastChild = undefined
  installSpawn()
  installFetch()
  vi.stubGlobal('WebSocket', FakeSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  spawnMock.mockReset()
  delete process.env.WEB_FETCH_RENDER_PROBE
  delete process.env.WEB_FETCH_RENDER_SECRET
  delete process.env.DSH_WEB_FETCH_RENDER
})

describe('resolve Chromium', () => {
  it('rejects an aborted render before starting a browser', async () => {
    controller.abort()
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/abort/i)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('uses an explicit runnable executable and skips the candidate list', async () => {
    const page = renderPublicPage(request({ executablePath: process.execPath }))
    await expect(page).resolves.toMatchObject({ url: 'https://example.com/ready', statusCode: 200, html: '<p>ready</p>' })
    expect(spawnMock.mock.calls[0]?.[0]).toBe(process.execPath)
    expect(existsSync(profileFromSpawn())).toBe(false)
  })

  it('rejects a configured executable that cannot be run', async () => {
    await expect(renderPublicPage(request({ executablePath: '/no/such/dsh-chrome' }), FOUND))
      .rejects.toThrow(/not runnable/)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('skips missing candidates and accepts a blank path as unset', async () => {
    await expect(renderPublicPage(request({ executablePath: '' }), FOUND))
      .resolves.toMatchObject({ statusCode: 200 })
    expect(spawnMock.mock.calls[0]?.[0]).toBe(process.execPath)
  })

  it('reports when no known Chromium exists', async () => {
    await expect(renderPublicPage(request(), MISSING)).rejects.toThrow(/was not found/)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})

describe('browser launch', () => {
  it('returns the rendered DOM and scrubs credential-shaped environment', async () => {
    process.env.WEB_FETCH_RENDER_PROBE = 'kept'
    process.env.WEB_FETCH_RENDER_SECRET = 'hidden'
    process.env.DSH_WEB_FETCH_RENDER = 'hidden'
    const page = await renderPublicPage(request(), FOUND)
    expect(page).toEqual({ url: 'https://example.com/ready', statusCode: 200, html: '<p>ready</p>' })
    const args = spawnMock.mock.calls[0]?.[1] as string[]
    expect(args).toContain('--headless=new')
    expect(args).toContain('--user-agent=Harness/test')
    expect(args).toContain('about:blank')
    const env = spawnMock.mock.calls[0]?.[2] as { env: Record<string, string> }
    expect(env.env.WEB_FETCH_RENDER_PROBE).toBe('kept')
    expect(env.env.WEB_FETCH_RENDER_SECRET).toBeUndefined()
    expect(env.env.DSH_WEB_FETCH_RENDER).toBeUndefined()
    expect(existsSync(profileFromSpawn())).toBe(false)
    expect(lastChild?.killed).toBe(true)
  })

  it('waits for DOMContentLoaded and stops a browser that exits synchronously', async () => {
    killSync = true
    readyEvent = 'Page.domContentEventFired'
    navigateResult = {}
    await expect(renderPublicPage(request({ ready: 'domcontentloaded' }), FOUND))
      .resolves.toMatchObject({ html: '<p>ready</p>' })
    expect(lastChild?.killed).toBe(true)
  })

  it('aborts while waiting for the ready event', async () => {
    onCommand = (socket, command) => {
      if (command.method === 'Page.navigate') {
        emit(socket, { method: 'Network.responseReceived', params: { type: 'Document', response: { status: 200 } } })
        reply(socket, command.id, {})
        setTimeout(() => {
          emit(socket, { method: 'Page.lifecycleEvent' })
          controller.abort()
        }, 20)
        return
      }
      reply(socket, command.id, {})
    }
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/abort/i)
  })

  it('waits for network idle after load', async () => {
    onCommand = (socket, command) => {
      if (command.method !== 'Page.navigate') {
        defaultOnCommand(socket, command)
        return
      }
      emit(socket, { method: 'Network.responseReceived', params: { type: 'Document', response: { status: 200 } } })
      reply(socket, command.id, {})
      setTimeout(() => { emit(socket, { method: 'Page.loadEventFired' }) }, 0)
      setTimeout(() => {
        emit(socket, { method: 'Network.requestWillBeSent' })
        emit(socket, { method: 'Network.requestWillBeSent' })
        emit(socket, { method: 'Network.loadingFailed' })
        emit(socket, { method: 'Network.loadingFinished' })
        emit(socket, { method: 'Network.loadingFinished' })
      }, 20)
    }
    await expect(renderPublicPage(request({ ready: 'networkidle' }), FOUND))
      .resolves.toMatchObject({ statusCode: 200 })
  })

  it('aborts network idle while requests are outstanding', async () => {
    onCommand = (socket, command) => {
      if (command.method !== 'Page.navigate') {
        reply(socket, command.id, {})
        return
      }
      emit(socket, { method: 'Network.responseReceived', params: { type: 'Document', response: { status: 200 } } })
      reply(socket, command.id, {})
      setTimeout(() => { emit(socket, { method: 'Page.loadEventFired' }) }, 0)
      setTimeout(() => {
        emit(socket, { method: 'Network.requestWillBeSent' })
        controller.abort()
      }, 20)
    }
    await expect(renderPublicPage(request({ ready: 'networkidle' }), FOUND)).rejects.toThrow(/abort/i)
  })

  it('removes the profile when the browser process cannot start', async () => {
    chromeMode = 'throw'
    await expect(renderPublicPage(request({ executablePath: process.execPath }), FOUND)).rejects.toThrow(/spawn failed/)
    expect(existsSync(profileFromSpawn())).toBe(false)
  })

  it('rejects a browser that does not pipe stderr', async () => {
    chromeMode = 'no-stderr'
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/stderr is not piped/)
  })

  it('rejects a browser that exits before the debugging port opens', async () => {
    chromeMode = 'exit'
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/exited before opening/)
    expect(lastChild?.killed).toBe(false)
  })

  it('rejects a browser process error', async () => {
    chromeMode = 'error'
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/spawn failed/)
  })

  it('rejects when the debugging port never opens', async () => {
    chromeMode = 'silent'
    await expect(renderPublicPage(request({ timeoutMs: 40 }), FOUND)).rejects.toThrow(/debugging port/)
  })

  it('rejects when launch is aborted', async () => {
    chromeMode = 'abort'
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/abort/i)
  })
})

describe('page target and CDP', () => {
  it('polls until a page target appears', async () => {
    fetchMode = 'retry'
    await expect(renderPublicPage(request(), FOUND)).resolves.toMatchObject({ statusCode: 200 })
    expect(fetches).toBe(2)
  })

  it('rejects a debugging list that is not an array', async () => {
    fetchMode = 'object'
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/did not expose a page target/)
  })

  it('rejects when the debugging list never includes a page', async () => {
    fetchMode = 'empty'
    await expect(renderPublicPage(request({ timeoutMs: 40 }), FOUND)).rejects.toThrow(/did not expose a page target/)
  })

  it('rejects when the debugging list cannot be read', async () => {
    fetchMode = 'throw'
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/debug port closed/)
  })

  it('rejects when the page list wait is aborted', async () => {
    fetchMode = 'abort-delay'
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/abort/i)
  })

  it('rejects a debugging socket error', async () => {
    socketMode = 'error'
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/debugging socket failed/)
  })

  it('rejects when the socket opens after the caller has aborted', async () => {
    socketMode = 'abort-now'
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/abort/i)
  })

  it('rejects when the socket stays closed until abort', async () => {
    socketMode = 'stall'
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/abort/i)
  })

  it('rejects a navigation error and a CDP command failure', async () => {
    navigateResult = { errorText: 'net::ERR_FAILED' }
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/net::ERR_FAILED/)

    onCommand = (socket, command) => {
      if (command.method === 'Page.enable') {
        socket.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ id: command.id, error: { message: 'nope' } }),
        }))
        return
      }
      reply(socket, command.id, {})
    }
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/nope/)

    onCommand = (socket, command) => {
      if (command.method === 'Page.enable') {
        socket.dispatchEvent(new MessageEvent('message', {
          data: JSON.stringify({ id: command.id, error: {} }),
        }))
        return
      }
      reply(socket, command.id, {})
    }
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/CDP command failed/)
  })

  it('rejects an evaluation failure, a non-document result, and a missing document status', async () => {
    evaluateResult = { exceptionDetails: { text: 'bad' } }
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/evaluation failed/)

    evaluateResult = { result: { value: { href: 1, html: '<p>x</p>' } } }
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/did not return a document/)

    evaluateResult = { result: { value: { href: 'https://example.com/', html: 1 } } }
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/did not return a document/)

    evaluateResult = { result: { value: { href: 'https://example.com/ready', html: '<p>ready</p>' } } }
    onCommand = (socket, command) => {
      if (command.method === 'Page.navigate') {
        reply(socket, command.id, {})
        setTimeout(() => { emit(socket, { method: 'Page.loadEventFired' }) }, 0)
        return
      }
      defaultOnCommand(socket, command)
    }
    await expect(renderPublicPage(request(), FOUND)).rejects.toThrow(/did not produce a document response/)
  })
})
