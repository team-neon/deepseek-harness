import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openStore } from '../src/store.ts'
import { runOnce } from '../src/run.ts'

const NOW = '2026-10-13T14:00:00.000Z'
const FROZEN_PAGE = JSON.parse(readFileSync(new URL('../fixtures/telegraph-page.json', import.meta.url), 'utf8')) as {
  data: { roll_data: Array<{ id: number; ctime: number; content: string }> }
}

function publishedAt(ctime: number): string {
  return new Date(ctime * 1000).toISOString()
}

function entry(id: number | string, ctime: number, content = `body-${id}`) {
  return {
    id,
    ctime,
    title: '',
    content,
    shareurl: `https://www.cls.cn/detail/${id}`,
  }
}

function page(rows: ReturnType<typeof entry>[]) {
  return { data: { roll_data: rows } }
}

describe('runOnce', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'crawl-cls-run-'))
    roots.push(root)
    return root
  }

  function telegraph(root: string): string {
    return join(root, 'crawl', 'cls', 'telegraph')
  }

  function seed(root: string, files: Record<string, string>): void {
    const dir = telegraph(root)
    mkdirSync(dir, { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  }

  it('keeps cursor and index bytes when a later page fails, and keeps the item file', async () => {
    const root = tempRoot()
    const store = openStore(root)
    const indexBytes = '{"sentinel":1}\n'
    const cursorBytes = '{"sentinel":true}\n'
    seed(root, { 'index.jsonl': indexBytes, 'cursor.json': cursorBytes })
    const calls: Array<{ lastTime?: number }> = []

    const counts = await runOnce({
      store,
      cursor: { lastSourceItemId: '1', lastPublishedAt: publishedAt(1) },
      maxPages: 3,
      now: NOW,
      async fetchPage(input) {
        calls.push({ lastTime: input.lastTime })
        if (calls.length === 1) return { page: FROZEN_PAGE, oldestCtime: FROZEN_PAGE.data.roll_data[0]?.ctime }
        expect(readFileSync(join(telegraph(root), 'index.jsonl'), 'utf8')).toBe(indexBytes)
        expect(readFileSync(join(telegraph(root), 'cursor.json'), 'utf8')).toBe(cursorBytes)
        expect(existsSync(join(telegraph(root), 'items', '123456.json'))).toBe(true)
        throw new Error('transport failed')
      },
    })

    expect(counts).toEqual({ created: 1, updated: 0, unchanged: 0, rejected: 1 })
    expect(calls.map(call => call.lastTime)).toEqual([undefined, FROZEN_PAGE.data.roll_data[0]?.ctime])
    expect(readFileSync(join(telegraph(root), 'index.jsonl'), 'utf8')).toBe(indexBytes)
    expect(readFileSync(join(telegraph(root), 'cursor.json'), 'utf8')).toBe(cursorBytes)
    expect(existsSync(join(telegraph(root), 'items', '123456.json'))).toBe(true)
    expect(readFileSync(join(telegraph(root), 'rejects.jsonl'), 'utf8')).toContain('"reason":"invalid_id"')
  })

  it('commits index lines and leaves the watermark unchanged at maxPages', async () => {
    const root = tempRoot()
    const store = openStore(root)
    const cursorBytes = '{"v":1,"last_source_item_id":"old","last_published_at":"1970-01-01T00:00:01.000Z","updated_at":"1970-01-01T00:00:01.000Z"}'
    const indexBytes = '{"sentinel":1}\n'
    seed(root, { 'cursor.json': cursorBytes, 'index.jsonl': indexBytes })
    let calls = 0

    const counts = await runOnce({
      store,
      cursor: { lastSourceItemId: 'old', lastPublishedAt: publishedAt(1) },
      maxPages: 1,
      now: NOW,
      async fetchPage() {
        calls += 1
        const ctime = 10 + calls
        return { page: page([entry(100 + calls, ctime)]), oldestCtime: ctime }
      },
    })

    expect(calls).toBe(1)
    expect(counts.created).toBe(1)
    expect(readFileSync(join(telegraph(root), 'cursor.json'), 'utf8')).toBe(cursorBytes)
    const index = readFileSync(join(telegraph(root), 'index.jsonl'), 'utf8')
    expect(index.startsWith(indexBytes)).toBe(true)
    expect(index.length).toBeGreaterThan(indexBytes.length)
    expect(index).toContain('"op":"created"')
    expect(existsSync(join(telegraph(root), 'items', '101.json'))).toBe(true)
  })

  it('does not move the watermark when an empty page adds no items', async () => {
    const root = tempRoot()
    const store = openStore(root)
    const cursorBytes = '{"v":1,"last_source_item_id":"old","last_published_at":"2025-10-13T13:59:12.000Z","updated_at":"2026-10-13T00:00:00.000Z"}'
    seed(root, { 'cursor.json': cursorBytes })

    const counts = await runOnce({
      store,
      cursor: { lastSourceItemId: 'old', lastPublishedAt: '2025-10-13T13:59:12.000Z' },
      maxPages: 3,
      now: NOW,
      async fetchPage() {
        return { page: page([]) }
      },
    })

    expect(counts).toEqual({ created: 0, updated: 0, unchanged: 0, rejected: 0 })
    expect(readFileSync(join(telegraph(root), 'cursor.json'), 'utf8')).toBe(cursorBytes)
    expect(existsSync(join(telegraph(root), 'index.jsonl'))).toBe(false)
  })

  it('stops on an item that is not newer and commits the newest written published_at', async () => {
    const root = tempRoot()
    const store = openStore(root)
    const equalCtime = 1760363952
    const newerCtime = equalCtime + 2
    const olderCtime = equalCtime - 5
    const calls: number[] = []

    const counts = await runOnce({
      store,
      cursor: { lastSourceItemId: 'same', lastPublishedAt: '2025-10-13T13:59:12+00:00' },
      maxPages: 3,
      now: NOW,
      async fetchPage(input) {
        calls.push(calls.length)
        expect(input.lastTime).toBeUndefined()
        return {
          page: page([
            entry(30, newerCtime, 'newer'),
            entry(20, equalCtime, 'equal instant, different timestamp text'),
            entry(10, olderCtime, 'older'),
          ]),
          oldestCtime: olderCtime,
        }
      },
    })

    expect(calls).toEqual([0])
    expect(counts).toEqual({ created: 1, updated: 0, unchanged: 0, rejected: 0 })
    expect(existsSync(join(telegraph(root), 'items', '30.json'))).toBe(true)
    expect(existsSync(join(telegraph(root), 'items', '20.json'))).toBe(false)
    expect(existsSync(join(telegraph(root), 'items', '10.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(telegraph(root), 'cursor.json'), 'utf8'))).toEqual({
      v: 1,
      last_source_item_id: '30',
      last_published_at: publishedAt(newerCtime),
      updated_at: NOW,
    })
    expect(JSON.parse(readFileSync(join(telegraph(root), 'items', '30.json'), 'utf8'))).toMatchObject({
      fetched_at: NOW,
      published_at: publishedAt(newerCtime),
    })
  })

  it('paginates with the previous oldestCtime and commits after new items meet an empty page', async () => {
    const root = tempRoot()
    const store = openStore(root)
    store.put({
      sourceItemId: '2',
      publishedAt: publishedAt(300),
      ctime: 300,
      title: 'body-2',
      body: 'body-2',
      url: 'https://www.cls.cn/detail/2',
      raw: entry(2, 300),
    }, '2026-10-13T00:00:00.000Z')
    store.put({
      sourceItemId: '3',
      publishedAt: publishedAt(200),
      ctime: 200,
      title: 'old',
      body: 'old',
      url: 'https://www.cls.cn/detail/3',
      raw: entry(3, 200, 'old'),
    }, '2026-10-13T00:00:00.000Z')
    store.commitIndex()
    const seen: Array<{ lastTime?: number; signal: AbortSignal }> = []

    const counts = await runOnce({
      store,
      cursor: { lastPublishedAt: publishedAt(1) },
      maxPages: 3,
      now: NOW,
      async fetchPage(input) {
        seen.push({ lastTime: input.lastTime, signal: input.signal })
        if (seen.length === 1) {
          return {
            page: page([
              entry(4, 400, 'new'),
              entry(2, 300),
              entry(3, 200, 'new-body'),
              { id: '../x', ctime: 150, title: '', content: 'nope', shareurl: '' },
            ]),
            oldestCtime: 150,
          }
        }
        expect(existsSync(join(telegraph(root), 'rejects.jsonl'))).toBe(true)
        expect(existsSync(join(telegraph(root), 'index.jsonl'))).toBe(true)
        const indexBeforeCommit = readFileSync(join(telegraph(root), 'index.jsonl'), 'utf8')
        expect(indexBeforeCommit).not.toContain('"source_item_id":"4"')
        return { page: page([]) }
      },
    })

    expect(seen.map(call => call.lastTime)).toEqual([undefined, 150])
    expect(seen[0]?.signal).toBe(seen[1]?.signal)
    expect(counts).toEqual({ created: 1, updated: 1, unchanged: 1, rejected: 1 })
    expect(JSON.parse(readFileSync(join(telegraph(root), 'cursor.json'), 'utf8'))).toMatchObject({
      last_source_item_id: '4',
      last_published_at: publishedAt(400),
      updated_at: NOW,
    })
    const ops = readFileSync(join(telegraph(root), 'index.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
      op?: string
      source_item_id?: string
    })
    expect(ops.filter(row => row.source_item_id === '4').map(row => row.op)).toEqual(['created'])
    expect(ops.filter(row => row.source_item_id === '3').map(row => row.op)).toEqual(['created', 'updated'])
    expect(ops.some(row => row.source_item_id === '2' && row.op === 'updated')).toBe(false)
  })
})
