import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TelegraphItem } from '../src/map.ts'
import { openStore } from '../src/store.ts'

const FETCHED_AT = '2026-10-13T14:00:00.000Z'
const CANONICAL_SHA = '2424c703acf0e76856d28508d1d157050fe6658ef8aad9cf4bbb8c4f58f73c96'
const RAW_SHA = '674a0e06146466360ae615d3e73a6385a78dc06409eb5847fed5b9b5dd400a47'

function sample(body = '第一行\n其余'): TelegraphItem {
  return {
    sourceItemId: '123456',
    publishedAt: '2025-10-13T13:59:12.000Z',
    ctime: 1760363952,
    title: '第一行',
    body,
    url: 'https://www.cls.cn/detail/123456',
    raw: {
      content: body,
      ctime: 1760363952,
      id: 123456,
      shareurl: 'https://www.cls.cn/detail/123456',
      title: '',
    },
  }
}

describe('openStore', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function tempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'crawl-cls-'))
    roots.push(root)
    return root
  }

  it('rejects a relative root', () => {
    const relative = 'crawl-cls-relative-root'
    const created = join(process.cwd(), relative)
    try {
      expect(() => openStore(relative)).toThrow(/absolute/)
    } finally {
      if (existsSync(created)) rmSync(created, { recursive: true, force: true })
    }
    expect(existsSync(created)).toBe(false)
  })

  it('writes raw and item immediately, and index only on commitIndex', () => {
    const root = tempRoot()
    const store = openStore(root)
    const telegraph = join(root, 'crawl', 'cls', 'telegraph')
    const indexPath = join(telegraph, 'index.jsonl')
    const itemPath = join(telegraph, 'items', '123456.json')
    const rawRef = `raw/${RAW_SHA.slice(0, 2)}/${RAW_SHA}.json`

    expect(store.put(sample(), FETCHED_AT)).toBe('created')
    expect(existsSync(indexPath)).toBe(false)
    expect(existsSync(join(telegraph, 'cursor.json'))).toBe(false)
    expect(readFileSync(join(telegraph, rawRef), 'utf8')).toBe(JSON.stringify({
      content: '第一行\n其余',
      ctime: 1760363952,
      id: 123456,
      shareurl: 'https://www.cls.cn/detail/123456',
      title: '',
    }))
    expect(JSON.parse(readFileSync(itemPath, 'utf8'))).toMatchObject({
      v: 1,
      source_id: 'cls',
      crawler_id: 'crawl-cls',
      doc_type: 'telegraph_item',
      source_item_id: '123456',
      fetched_at: FETCHED_AT,
      published_at: '2025-10-13T13:59:12.000Z',
      canonical: {
        title: '第一行',
        body: '第一行\n其余',
        url: 'https://www.cls.cn/detail/123456',
      },
      raw_ref: rawRef,
    })

    store.commitIndex()
    const indexText = readFileSync(indexPath, 'utf8')
    expect(indexText.endsWith('\n')).toBe(true)
    expect(indexText.includes(': ')).toBe(false)
    expect(JSON.parse(indexText)).toEqual({
      v: 1,
      op: 'created',
      source_item_id: '123456',
      path: 'items/123456.json',
      fetched_at: FETCHED_AT,
      content_sha256: CANONICAL_SHA,
      raw_ref: rawRef,
    })

    const createdSize = statSync(indexPath).size
    expect(store.put(sample(), FETCHED_AT)).toBe('unchanged')
    store.commitIndex()
    expect(statSync(indexPath).size).toBe(createdSize)

    const changed = sample('第一行\n其余\n更多')
    expect(store.put(changed, FETCHED_AT)).toBe('updated')
    expect(statSync(indexPath).size).toBe(createdSize)
    store.commitIndex()
    const lines = readFileSync(indexPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { op: string; content_sha256: string })
    expect(lines.map(line => line.op)).toEqual(['created', 'updated'])
    expect(lines[1]?.content_sha256).not.toBe(CANONICAL_SHA)
    expect(JSON.parse(readFileSync(itemPath, 'utf8'))).toMatchObject({
      canonical: { body: '第一行\n其余\n更多' },
    })
  })

  it('does not create an items path for an illegal id', () => {
    const root = tempRoot()
    const store = openStore(root)
    const telegraph = join(root, 'crawl', 'cls', 'telegraph')
    expect(() => store.put({ ...sample(), sourceItemId: '../x' }, FETCHED_AT)).toThrow()
    expect(existsSync(join(telegraph, 'items'))).toBe(false)
    expect(existsSync(join(telegraph, 'x.json'))).toBe(false)
  })

  it('appends rejects immediately and writes cursor.json only on commitCursor', () => {
    const root = tempRoot()
    const store = openStore(root)
    const telegraph = join(root, 'crawl', 'cls', 'telegraph')
    const cursorPath = join(telegraph, 'cursor.json')
    expect(existsSync(cursorPath)).toBe(false)
    store.appendReject({ reason: 'invalid_id', sourceItemId: '../x' }, FETCHED_AT)
    store.appendReject({ reason: 'map_failed', sourceItemId: '' }, FETCHED_AT)
    expect(readFileSync(join(telegraph, 'rejects.jsonl'), 'utf8')).toBe(`${JSON.stringify({
      v: 1,
      reason: 'invalid_id',
      source_item_id: '../x',
      fetched_at: FETCHED_AT,
    })}\n${JSON.stringify({
      v: 1,
      reason: 'map_failed',
      source_item_id: '',
      fetched_at: FETCHED_AT,
    })}\n`)
    expect(existsSync(cursorPath)).toBe(false)
    store.commitCursor({
      lastSourceItemId: '123456',
      lastPublishedAt: '2025-10-13T13:59:12.000Z',
      updatedAt: FETCHED_AT,
    })
    expect(JSON.parse(readFileSync(cursorPath, 'utf8'))).toEqual({
      v: 1,
      last_source_item_id: '123456',
      last_published_at: '2025-10-13T13:59:12.000Z',
      updated_at: FETCHED_AT,
    })
  })

  it('replaces an item whose canonical JSON cannot be hashed', () => {
    const root = tempRoot()
    const store = openStore(root)
    const itemDir = join(root, 'crawl', 'cls', 'telegraph', 'items')
    mkdirSync(itemDir, { recursive: true })
    const itemPath = join(itemDir, '123456.json')
    writeFileSync(itemPath, '[]')
    expect(store.put(sample(), FETCHED_AT)).toBe('updated')
    writeFileSync(itemPath, JSON.stringify({ canonical: { title: 1, body: 'x', url: 'y' } }))
    expect(store.put(sample(), FETCHED_AT)).toBe('updated')
    expect(JSON.parse(readFileSync(itemPath, 'utf8'))).toMatchObject({
      canonical: { body: '第一行\n其余' },
    })
  })

  it('creates the telegraph directories with mode 0o700', () => {
    const root = tempRoot()
    const store = openStore(root)
    store.put(sample(), FETCHED_AT)
    const telegraph = join(root, 'crawl', 'cls', 'telegraph')
    for (const dir of [
      root,
      join(root, 'crawl'),
      join(root, 'crawl', 'cls'),
      telegraph,
      join(telegraph, 'raw'),
      join(telegraph, 'raw', RAW_SHA.slice(0, 2)),
      join(telegraph, 'items'),
    ]) {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
    }
  })
})
