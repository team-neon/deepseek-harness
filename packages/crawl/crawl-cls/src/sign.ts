/**
 * Query signing and canonical content hashes for Cailian Press telegraph items.
 */

import { createHash } from 'node:crypto'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (!isRecord(value)) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) sorted[key] = sortKeys(value[key])
  return sorted
}

/** UTF-8 JSON with sorted keys and no extra whitespace. */
export function stableJson(value: unknown): string {
  // 把原文或 canonical 收成稳定 JSON。递归按键名排序后做无多余空白的 JSON.stringify。
  return JSON.stringify(sortKeys(value)) ?? 'null'
}

/**
 * Sign one telegraph query.
 */
export function signQuery(params: Record<string, string>): string {
  // 为财联社电报查询参数生成 sign。按键排序拼接 key=value，对 SHA-1 十六进制再做 MD5 十六进制。
  const query = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const sha1Hex = createHash('sha1').update(query).digest('hex')
  return createHash('md5').update(sha1Hex).digest('hex')
}

/**
 * Hash the canonical title, body, and url.
 */
export function canonicalHash(canonical: { title: string; body: string; url: string }): string {
  // 为条目的 title、body、url 计算内容哈希。对键排序且无多余空白的 UTF-8 JSON 做 SHA-256。
  return createHash('sha256').update(stableJson({
    body: canonical.body,
    title: canonical.title,
    url: canonical.url,
  })).digest('hex')
}
