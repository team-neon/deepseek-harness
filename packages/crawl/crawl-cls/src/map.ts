/**
 * Map a Cailian Press telegraph list page into items and rejects.
 */

export interface TelegraphItem {
  sourceItemId: string
  publishedAt: string
  ctime: number
  title: string
  body: string
  url: string
  raw: unknown
}

export interface MapReject {
  reason: 'invalid_id' | 'map_failed'
  sourceItemId: string
}

export interface PageBatch {
  items: TelegraphItem[]
  rejects: MapReject[]
}

const SOURCE_ITEM_ID = /^[A-Za-z0-9_-]+$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decimalId(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString(10)
  return undefined
}

function firstLine(content: string): string {
  const newline = content.indexOf('\n')
  if (newline === -1) return content
  return content.slice(0, newline)
}

function mapEntry(entry: unknown): TelegraphItem | MapReject {
  if (!isRecord(entry)) return { reason: 'map_failed', sourceItemId: '' }
  const sourceItemId = decimalId(entry.id)
  if (sourceItemId === undefined) return { reason: 'map_failed', sourceItemId: '' }
  if (!SOURCE_ITEM_ID.test(sourceItemId)) return { reason: 'invalid_id', sourceItemId }
  if (typeof entry.content !== 'string' || typeof entry.ctime !== 'number' || !Number.isFinite(entry.ctime)) {
    return { reason: 'map_failed', sourceItemId }
  }
  const title = typeof entry.title === 'string' && entry.title.length > 0 ? entry.title : firstLine(entry.content)
  const url = typeof entry.shareurl === 'string' ? entry.shareurl : ''
  return {
    sourceItemId,
    publishedAt: new Date(entry.ctime * 1000).toISOString(),
    ctime: entry.ctime,
    title,
    body: entry.content,
    url,
    raw: entry,
  }
}

function isReject(value: TelegraphItem | MapReject): value is MapReject {
  return 'reason' in value
}

/**
 * Map one telegraph list page.
 */
export function mapTelegraphPage(page: unknown): PageBatch {
  // 把财联社电报列表页映射成可落盘条目和拒绝记录。只读取 data.roll_data，数字 id 转成十进制字符串后按 [A-Za-z0-9_-]+ 校验。
  if (!isRecord(page) || !isRecord(page.data) || !Array.isArray(page.data.roll_data)) {
    return { items: [], rejects: [{ reason: 'map_failed', sourceItemId: '' }] }
  }
  const items: TelegraphItem[] = []
  const rejects: MapReject[] = []
  for (const entry of page.data.roll_data) {
    const mapped = mapEntry(entry)
    if (isReject(mapped)) rejects.push(mapped)
    else items.push(mapped)
  }
  return { items, rejects }
}
