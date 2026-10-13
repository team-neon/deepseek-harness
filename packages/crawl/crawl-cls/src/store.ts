/**
 * File store for Cailian Press telegraph items under crawl/cls/telegraph.
 */

import { createHash } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { MapReject, TelegraphItem } from './map.ts'
import { canonicalHash, stableJson } from './sign.ts'

const SOURCE_ITEM_ID = /^[A-Za-z0-9_-]+$/

export interface CrawlStore {
  put(item: TelegraphItem, fetchedAt: string): 'created' | 'updated' | 'unchanged'
  appendReject(reject: MapReject, fetchedAt: string): void
  commitIndex(): void
  commitCursor(cursor: {
    lastSourceItemId: string
    lastPublishedAt: string
    updatedAt: string
  }): void
}

interface PendingIndex {
  op: 'created' | 'updated'
  sourceItemId: string
  fetchedAt: string
  contentSha256: string
  rawRef: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function readCanonicalHash(itemFile: string): string | undefined {
  if (!existsSync(itemFile)) return undefined
  const parsed: unknown = JSON.parse(readFileSync(itemFile, 'utf8'))
  if (!isRecord(parsed) || !isRecord(parsed.canonical)) return ''
  const { title, body, url } = parsed.canonical
  if (typeof title !== 'string' || typeof body !== 'string' || typeof url !== 'string') return ''
  return canonicalHash({ title, body, url })
}

/**
 * Open a telegraph store at an absolute root.
 */
export function openStore(root: string): CrawlStore {
  // 把财联社电报条目写入 crawl/cls/telegraph。root 必须是绝对路径，目录按 0o700 创建，index 与 cursor 分别延后到 commitIndex 和 commitCursor。
  if (!isAbsolute(root)) throw new Error('root must be an absolute path')
  const base = resolve(root)
  const telegraph = join(base, 'crawl', 'cls', 'telegraph')
  const pending: PendingIndex[] = []
  let tempSeq = 0

  function ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    let current = resolve(dir)
    while (isInside(base, current)) {
      chmodSync(current, 0o700)
      if (current === base) break
      current = dirname(current)
    }
  }

  function writeAtomic(file: string, body: string): void {
    ensureDir(dirname(file))
    const temp = join(dirname(file), `.tmp-${tempSeq}`)
    tempSeq += 1
    writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
    renameSync(temp, file)
  }

  return {
    put(item, fetchedAt) {
      if (!SOURCE_ITEM_ID.test(item.sourceItemId)) throw new Error('source_item_id is not safe to store')
      const rawJson = stableJson(item.raw)
      const rawHash = createHash('sha256').update(rawJson).digest('hex')
      const rawRef = `raw/${rawHash.slice(0, 2)}/${rawHash}.json`
      writeAtomic(join(telegraph, rawRef), rawJson)
      const contentSha256 = canonicalHash({ title: item.title, body: item.body, url: item.url })
      const itemFile = join(telegraph, 'items', `${item.sourceItemId}.json`)
      const previous = readCanonicalHash(itemFile)
      if (previous === contentSha256) return 'unchanged'
      const op = previous === undefined ? 'created' : 'updated'
      writeAtomic(itemFile, JSON.stringify({
        v: 1,
        source_id: 'cls',
        crawler_id: 'crawl-cls',
        doc_type: 'telegraph_item',
        source_item_id: item.sourceItemId,
        fetched_at: fetchedAt,
        published_at: item.publishedAt,
        canonical: {
          body: item.body,
          title: item.title,
          url: item.url,
        },
        raw_ref: rawRef,
      }))
      pending.push({ op, sourceItemId: item.sourceItemId, fetchedAt, contentSha256, rawRef })
      return op
    },
    appendReject(reject, fetchedAt) {
      ensureDir(telegraph)
      appendFileSync(join(telegraph, 'rejects.jsonl'), `${JSON.stringify({
        v: 1,
        reason: reject.reason,
        source_item_id: reject.sourceItemId,
        fetched_at: fetchedAt,
      })}\n`)
    },
    commitIndex() {
      if (pending.length === 0) return
      ensureDir(telegraph)
      const lines = pending.map(row => `${JSON.stringify({
        v: 1,
        op: row.op,
        source_item_id: row.sourceItemId,
        path: `items/${row.sourceItemId}.json`,
        fetched_at: row.fetchedAt,
        content_sha256: row.contentSha256,
        raw_ref: row.rawRef,
      })}\n`).join('')
      appendFileSync(join(telegraph, 'index.jsonl'), lines)
      pending.length = 0
    },
    commitCursor(cursor) {
      writeAtomic(join(telegraph, 'cursor.json'), JSON.stringify({
        v: 1,
        last_source_item_id: cursor.lastSourceItemId,
        last_published_at: cursor.lastPublishedAt,
        updated_at: cursor.updatedAt,
      }))
    },
  }
}
