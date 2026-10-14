/**
 * HTTPS host allow-list for Cailian Press telegraph requests.
 */

/**
 * Accept only HTTPS URLs whose hostname is listed.
 */
export function assertHttpsHost(url: URL, allowedHosts: readonly string[]): void {
  // 拒绝非 HTTPS 或不在 allowedHosts 里的主机。比较 URL.protocol 与 URL.hostname，不匹配就抛错。
  if (url.protocol !== 'https:') throw new Error(`refusing non-HTTPS URL: ${url.protocol}`)
  if (!allowedHosts.includes(url.hostname)) throw new Error(`host is not allowed: ${url.hostname}`)
}
