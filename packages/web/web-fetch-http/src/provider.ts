/**
 * Safe HTTP(S) retrieval for `ctx.web`: validates and pins public IP destinations, follows
 * only same-origin redirects, enforces time and size limits, classifies and decodes text,
 * and leaves presentation to `@deepseek-ai/dsh-tool-web`. Requests carry no browser cookies
 * or ambient credentials.
 * @module @deepseek-ai/dsh-web-fetch-http/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { Response } from 'undici'
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { isNonPublicIpLiteral, publicHttpNetwork } from './network.ts'
import type { PublicAddress } from './network.ts'
import { classifyContentType, decoderForCharset, isSameOrigin, parseCharset, validateFetchUrl } from './policy.ts'
import type { RenderReadyState } from './policy.ts'
import { renderPublicPage } from './render.ts'
import type { PageRenderer, RenderedPage } from './render.ts'

/** Resolved provider limits (the plugin's schemastery Config supplies defaults). */
export interface HttpFetchLimits {
  /** Maximum response body size in bytes (read is aborted past this). */
  maxResponseBytes: number
  /** Maximum decoded body length in characters (truncated past this). */
  maxBodyChars: number
  /** Default fetch timeout in milliseconds. */
  timeoutMs: number
  /** Maximum number of (same-origin) redirect hops to follow. */
  maxRedirects: number
  /** `User-Agent` header sent on every request. */
  userAgent: string
  /**
   * When true, open the validated URL in a one-shot headless Chromium and
   * return the rendered DOM. Default false keeps the pinned HTTP read.
   */
  render?: boolean
  /** Browser event to wait for when `render` is true. */
  renderReady?: RenderReadyState
  /** Chromium executable used when `render` is true. */
  executablePath?: string
}

/** Resolve one hostname to an already policy-validated address set. */
export type HttpFetchResolver = (hostname: string, signal: AbortSignal) => Promise<PublicAddress[]>

/** Stable id this provider registers under. */
export const LOCAL_FETCH_PROVIDER_ID = 'http'

/** The anonymous public HTTP(S) fetch provider. */
export class HttpFetchProvider implements WebFetchProvider {
  readonly id = LOCAL_FETCH_PROVIDER_ID

  /**
   * @param limits - resolved transport and response limits.
   * @param resolveAddresses - resolver that rejects non-public destinations before returning.
   * @param renderPage - one-shot renderer. Tests inject this; production uses the headless Chromium renderer.
   */
  constructor(
    private readonly limits: HttpFetchLimits,
    private readonly resolveAddresses: HttpFetchResolver = publicHttpNetwork.resolve,
    private readonly renderPage: PageRenderer = renderPublicPage,
  ) {}

  /** No credentials to check — an anonymous public fetcher is always usable. */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')

    // One signal stops both the request and body read. The deadline's TimeoutReason later
    // distinguishes this provider's timeout from caller or outer-deadline cancellation.
    using d = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    // 单次渲染仍走同一个 web_fetch。先校验公网 URL，再打开一次性浏览器取 DOM，失败不退回原始 HTTP。
    if (this.limits.render === true) return await this.renderDocument(request.url, d.signal)
    return await this.followAndRead(request.url, d.signal)
  }

  /**
   * Render one validated public URL. A missing browser or a failed navigation
   * is `WEB_PROVIDER_ERROR`; cancellation stays `WEB_ABORTED` or `WEB_FETCH_TIMEOUT`.
   */
  private async renderDocument(initialUrl: string, signal: AbortSignal): Promise<WebFetchResult> {
    const url = validateFetchUrl(initialUrl)
    try {
      await this.resolveAddresses(url.hostname, signal)
      const page = await this.renderPage({
        url: url.toString(),
        signal,
        ready: this.limits.renderReady ?? 'load',
        timeoutMs: this.limits.timeoutMs,
        userAgent: this.limits.userAgent,
        ...this.limits.executablePath === undefined ? {} : { executablePath: this.limits.executablePath },
      })
      return this.renderedResult(url, page)
    } catch (error: unknown) {
      if (error instanceof WebError) throw error
      const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT')
      if (timeout !== undefined || signal.aborted) throw translateAbortOrNetwork(error, signal)
      throw new WebError(`web fetch render failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /** Accept a rendered document only when its final URL still passes fetch policy, then cap it. */
  private renderedResult(start: URL, page: RenderedPage): WebFetchResult {
    const finalUrl = validateFetchUrl(page.url)
    if (!isSameOrigin(finalUrl, start)) {
      throw new WebError(
        `cross-origin redirect to ${finalUrl.origin} is not followed automatically; retry against that URL directly`,
        'WEB_REDIRECT_BLOCKED',
      )
    }
    const content = capRenderedText(page.html, this.limits.maxResponseBytes, this.limits.maxBodyChars)
    return {
      url: finalUrl.toString(),
      statusCode: page.statusCode,
      body: { kind: 'html', content: content.text },
      truncated: content.truncated,
    }
  }

  /** Follow same-origin redirects up to the hop cap, then read the final response. */
  private async followAndRead(initialUrl: string, signal: AbortSignal): Promise<WebFetchResult> {
    let currentUrl = validateFetchUrl(initialUrl)
    let redirectsFollowed = 0

    for (;;) {
      const request = await this.requestOnce(currentUrl, signal)
      const { response } = request
      try {
        if (isRedirectStatus(response.status)) {
          // Enforce the redirect budget before resolving or validating the next hop.
          if (redirectsFollowed >= this.limits.maxRedirects) {
            await response.body?.cancel()
            throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
          }
          const location = response.headers.get('location')
          if (location === null) {
            // A redirect status with no Location is not a usable resource. Cancel
            // the (possibly streaming) body before throwing so no socket leaks.
            await response.body?.cancel()
            throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
          }
          const target = resolveRedirect(location, currentUrl)
          // Re-validate the target against the same transport hygiene a direct request gets: a
          // redirect must not be a back door to a credentialed, non-http(s), or over-long URL
          // that validateFetchUrl would reject.
          let validatedTarget: URL
          try {
            validatedTarget = validateFetchUrl(target.toString())
            if (!isSameOrigin(validatedTarget, currentUrl)) {
              throw new WebError(
                `cross-origin redirect to ${validatedTarget.origin} is not followed automatically; retry against that URL directly`,
                'WEB_REDIRECT_BLOCKED',
              )
            }
          } catch (error: unknown) {
            await response.body?.cancel()
            throw error
          }
          await response.body?.cancel()
          currentUrl = validatedTarget
          redirectsFollowed++
          continue
        }

        return await this.readBody(response, currentUrl, signal)
      } finally {
        await request.close()
      }
    }
  }

  private async requestOnce(url: URL, signal: AbortSignal) {
    const headers = {
      'user-agent': this.limits.userAgent,
      'accept': 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
    }
    try {
      // A proxied hop skips public-address resolution and pinning: the proxy performs the origin's
      // DNS, so there is no local address to validate, and pinning one would connect directly and
      // bypass the proxy. A hop the policy bypasses — every loopback and every `NO_PROXY` entry —
      // still takes the resolved-and-pinned path unchanged.
      //
      // One route decides both the branch and the dispatcher, so a mount or disposal between two
      // reads cannot return a direct, unpinned agent for a URL this branch cleared as proxied.
      //
      // An IP literal the address checks would refuse never takes it. The proxy would resolve
      // nothing — the address is already stated — so the shortcut would spend the checks for
      // nothing and let a proxy on this machine reach the very service they keep out of reach.
      const route = proxyRouteFor(url)
      if (route.proxied && !isNonPublicIpLiteral(url.hostname)) {
        return await publicHttpNetwork.requestVia(route.dispatcher, url, headers, signal)
      }
      const addresses = await this.resolveAddresses(url.hostname, signal)
      return await publicHttpNetwork.request(url, addresses, headers, signal)
    } catch (error: unknown) {
      if (error instanceof WebError) throw error
      throw translateAbortOrNetwork(error, signal)
    }
  }

  /** Read, byte-cap, classify, and decode the final response body. */
  private async readBody(response: Response, finalUrl: URL, signal: AbortSignal): Promise<WebFetchResult> {
    const contentType = response.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      await response.body?.cancel()
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }

    // Resolve the decoder BEFORE reading the body so an unsupported charset
    // fails without consuming the stream — but cancel the body on that failure
    // so the socket does not leak (matching the unsupported-content-type path).
    let decoder: TextDecoder
    try {
      decoder = decoderForCharset(parseCharset(contentType))
    } catch (error: unknown) {
      await response.body?.cancel()
      throw error
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response, signal)
    const decoded = decoder.decode(bytes)
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded
    const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }

    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body,
      truncated: truncatedByBytes || truncatedByChars,
    }
  }

  /**
   * Read the response stream up to `maxResponseBytes`. A `Content-Length` over
   * the cap rejects immediately with `WEB_FETCH_TOO_LARGE`; a stream that grows
   * past the cap is cut short (`truncatedByBytes`) rather than rejected, so a
   * server that under-reports still yields a bounded usable body.
   */
  private async readCapped(response: Response, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        await response.body?.cancel()
        throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
    }

    /* v8 ignore next -- a 2xx Response from fetch always exposes a body stream; the null guard is defensive. */
    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }

    const chunks: Uint8Array[] = []
    let total = 0
    let truncatedByBytes = false
    // Undici exposes response chunks as `any`; Fetch guarantees body chunks are Uint8Array.
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = this.limits.maxResponseBytes - total
        // Only DROPPED bytes count as truncation: a chunk that exactly fills the
        // remaining capacity keeps all its bytes and we read on to observe EOF,
        // so an exactly-at-cap body is not falsely flagged truncated.
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } catch (error: unknown) {
      /* v8 ignore next -- mid-stream read fault needs a network drop after headers; translate path covered by request-phase tests. */
      throw translateAbortOrNetwork(error, signal)
    } finally {
      /* v8 ignore next 4 -- cancel() after a completed/broken read settles without rejecting; unobserved best-effort cleanup. */
      await reader.cancel().catch(() => {
        // Cancel after a successful read (or after we broke past the cap) is
        // best-effort cleanup; the bytes we need are already collected.
      })
    }

    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }
}

/** Cut rendered HTML to the byte cap without splitting a UTF-8 sequence, then to the character cap. */
function capRenderedText(
  html: string,
  maxResponseBytes: number,
  maxBodyChars: number,
): { text: string; truncated: boolean } {
  const encoded = Buffer.from(html, 'utf8')
  let truncated = encoded.byteLength > maxResponseBytes
  let text = truncated ? encoded.subarray(0, utf8Boundary(encoded, maxResponseBytes)).toString('utf8') : html
  if (text.length > maxBodyChars) {
    text = text.slice(0, maxBodyChars)
    truncated = true
  }
  return { text, truncated }
}

/** Largest index at or below `maxBytes` that is not the middle of a UTF-8 character. */
function utf8Boundary(encoded: Buffer, maxBytes: number): number {
  let end = Math.min(maxBytes, encoded.byteLength)
  while (end > 0 && isUtf8Continuation(byteAt(encoded, end))) end -= 1
  return end
}

/** Read one encoded byte. The caller keeps `index` inside the buffer. */
function byteAt(encoded: Buffer, index: number): number {
  const byte = encoded[index]
  /* v8 ignore next -- the cut index stays inside the buffer; this guards the indexed read. */
  if (byte === undefined) throw new Error('utf-8 boundary walked past the buffer')
  return byte
}

/** A UTF-8 continuation byte is `10xxxxxx` and must not become the cut point. */
function isUtf8Continuation(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000
}

/** HTTP redirect status codes that carry a `Location`. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Resolve a (possibly relative) `Location` against the current URL. */
function resolveRedirect(location: string, base: URL): URL {
  try {
    return new URL(location, base)
  } catch (error: unknown) {
    /* v8 ignore next 2 -- URL resolution against a valid absolute base effectively never throws; defensive guard. */
    throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error })
  }
}

/**
 * Translate a thrown fetch/stream error into a `WebError`, classified by the
 * deadline signal rather than the thrown value (which differs by phase: the
 * request-phase `fetch` rejects with the abort reason, while the read-phase
 * reader surfaces a bare `AbortError`). `timeoutOf(signal, 'WEB_FETCH_TIMEOUT')`
 * recovering OUR reason means our timeout fired (`WEB_FETCH_TIMEOUT`); any other
 * abort — an upstream cancel, or a foreign/outer deadline's timeout under
 * nesting — is `WEB_ABORTED`; a throw with the signal NOT aborted is a
 * transport/network failure (`WEB_PROVIDER_ERROR`).
 */
function translateAbortOrNetwork(error: unknown, signal: AbortSignal): WebError {
  const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}
