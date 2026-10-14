/**
 * One Cailian Press telegraph crawl round.
 * The caller injects page fetches; this module does not open a network connection.
 */

import { mapTelegraphPage } from './map.ts'
import type { CrawlStore } from './store.ts'

/** Counts for one telegraph crawl round. */
export interface RunCounts {
  created: number
  updated: number
  unchanged: number
  rejected: number
}

interface FetchPage {
  (input: { lastTime?: number; signal: AbortSignal }): Promise<{
    page: unknown
    oldestCtime?: number
  }>
}

interface WrittenItem {
  sourceItemId: string
  publishedAt: string
  time: number
}

function instant(value: string): number {
  return Date.parse(value)
}

/**
 * Crawl at most `maxPages` telegraph pages and commit according to the stop reason.
 * @param input - injected fetcher, store, watermark, page cap, clock, and optional cancellation.
 * @returns Counts of created, updated, unchanged, and rejected rows.
 */
export async function runOnce(input: {
  fetchPage: FetchPage
  store: CrawlStore
  cursor?: { lastSourceItemId?: string; lastPublishedAt?: string }
  maxPages: number
  now: string
  signal?: AbortSignal
}): Promise<RunCounts> {
  // 抓取一轮财联社电报，只在空列表或走到水位时提交水位。传输失败时丢掉未提交的索引行，非列表页和整页拒绝只提交已写入条目的索引。
  const counts: RunCounts = { created: 0, updated: 0, unchanged: 0, rejected: 0 }
  const watermark = input.cursor?.lastPublishedAt === undefined ? undefined : instant(input.cursor.lastPublishedAt)
  const signal = input.signal ?? new AbortController().signal
  let lastTime: number | undefined
  let newest: WrittenItem | undefined

  const commitRound = (): void => {
    if (newest === undefined) return
    input.store.commitIndex()
    input.store.commitCursor({
      lastSourceItemId: newest.sourceItemId,
      lastPublishedAt: newest.publishedAt,
      updatedAt: input.now,
    })
  }

  for (let pages = 0; pages < input.maxPages; pages += 1) {
    let fetched: { page: unknown; oldestCtime?: number }
    try {
      fetched = await input.fetchPage(lastTime === undefined ? { signal } : { lastTime, signal })
    } catch {
      input.store.discardIndex()
      return counts
    }
    const batch = mapTelegraphPage(fetched.page)
    for (const reject of batch.rejects) {
      input.store.appendReject(reject, input.now)
      counts.rejected += 1
    }
    let reachedWatermark = false
    for (const item of batch.items) {
      const time = instant(item.publishedAt)
      if (watermark !== undefined && !(time > watermark)) {
        reachedWatermark = true
        break
      }
      const op = input.store.put(item, input.now)
      counts[op] += 1
      if (newest === undefined || time > newest.time) {
        newest = { sourceItemId: item.sourceItemId, publishedAt: item.publishedAt, time }
      }
    }
    const listEnded = batch.items.length === 0 && batch.rejects.length === 0
    if (reachedWatermark || listEnded) {
      commitRound()
      return counts
    }
    if (batch.items.length === 0) {
      input.store.commitIndex()
      return counts
    }
    if (pages + 1 >= input.maxPages) {
      input.store.commitIndex()
      return counts
    }
    if (fetched.oldestCtime === undefined) {
      commitRound()
      return counts
    }
    lastTime = fetched.oldestCtime
  }
  return counts
}
