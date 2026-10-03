import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export interface ResilientRequestInit extends RequestInit {
  /** Maximum buffered response size, checked while bytes arrive. */
  readonly maximumBytes?: number;
}
class ResponseSizeError extends Error {}

/**
 * Buffered HTTP transport for small provider responses. Each attempt opens a
 * fresh connection so stale pooled sockets cannot survive between calls.
 * Transport errors, 429 and 5xx responses are retried within the caller's
 * abort deadline. Redirects are always manual: callers validate their hosts.
 */
export async function resilientFetch(input: RequestInfo | URL, init: ResilientRequestInit = {}, attempts = 3): Promise<Response> {
  if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError('Attempts must be a positive integer.');
  const maximumBytes = init.maximumBytes ?? 10_000_000;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new TypeError('Response limit must be a positive integer.');
  const normalized = new Request(input, init);
  const url = new URL(normalized.url);
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('Only HTTP and HTTPS are supported.');
  const signal = AbortSignal.any([normalized.signal, AbortSignal.timeout(30_000)]);
  signal.throwIfAborted();
  const body = normalized.body === null ? undefined : Buffer.from(await normalized.arrayBuffer());
  signal.throwIfAborted();
  const headers = Object.fromEntries(normalized.headers);
  if (body !== undefined) headers['content-length'] = String(body.byteLength);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal.throwIfAborted();
    try {
      const response = await once(url, normalized.method, headers, body, signal, maximumBytes);
      if ((response.status !== 429 && response.status < 500) || attempt === attempts) return response;
    } catch (error) {
      signal.throwIfAborted();
      if (attempt === attempts || error instanceof ResponseSizeError) throw error;
    }
    try {
      await delay(250 * attempt, undefined, { signal });
    } catch {
      signal.throwIfAborted();
    }
  }
  throw new Error('The outbound request failed.');
}

function once(url: URL, method: string, headers: Record<string, string>, body: Buffer | undefined, signal: AbortSignal, maximumBytes: number): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const succeed = (response: Response): void => {
      if (!settled) { settled = true; cleanup(); resolve(response); }
    };
    const fail = (error: unknown): void => {
      if (!settled) { settled = true; cleanup(); reject(error); }
    };
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(url, { method, headers, agent: false }, (incoming) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      const oversized = (): void => {
        fail(new ResponseSizeError('The outbound response exceeded the response-size limit.'));
        incoming.destroy();
        request.destroy();
      };
      incoming.on('error', fail);
      incoming.on('aborted', () => fail(new Error('The outbound response was interrupted.')));
      if (method !== 'HEAD' && Number(incoming.headers['content-length']) > maximumBytes) {
        oversized();
        return;
      }
      incoming.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > maximumBytes) oversized();
        else if (!settled) chunks.push(chunk);
      });
      incoming.on('end', () => {
        if (settled) return;
        try {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(incoming.headers)) {
            if (typeof value === 'string') responseHeaders.set(key, value);
            else if (Array.isArray(value)) for (const entry of value) responseHeaders.append(key, entry);
          }
          const status = incoming.statusCode ?? 0;
          const payload = method === 'HEAD' || [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
          const response = new Response(payload, { status, statusText: incoming.statusMessage ?? '', headers: responseHeaders });
          Object.defineProperty(response, 'url', { value: url.href, configurable: true });
          succeed(response);
        } catch (error) { fail(error); }
      });
    });
    const abort = (): void => { fail(signal.reason); request.destroy(); };
    request.on('error', fail);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    request.end(body);
  });
}
