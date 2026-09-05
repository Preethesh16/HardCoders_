import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

/**
 * A drop-in replacement for the global fetch for outbound calls to third
 * parties.
 *
 * Node's global fetch keeps a connection pool alive for the life of the
 * process. An intervening NAT can drop a pooled socket silently, and every
 * later request then stalls on the dead socket until it times out. A
 * long-running API therefore starts failing every official-source, FX and
 * provider call until it is restarted, while the same request from a fresh
 * process succeeds. Each attempt here opens its own connection and closes it,
 * so a poisoned socket cannot outlive a single request.
 *
 * A transport error, a 429 or a 5xx is retried. A 4xx is returned as-is: it is
 * a real rejection, and retrying it would only repeat a rejected call.
 *
 * Redirects are never followed. Callers that accept them inspect the 3xx and
 * its `location` header themselves, which keeps host allow-listing at the
 * caller where it belongs.
 */
export async function resilientFetch(input: RequestInfo | URL, init: RequestInit = {}, attempts = 3): Promise<Response> {
  const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await once(url, init);
      if (response.status === 429 || response.status >= 500) {
        if (attempt === attempts) return response;
        lastError = new Error(`HTTP ${response.status}`);
      } else {
        return response;
      }
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    }
    await new Promise((resolve) => { setTimeout(resolve, 250 * attempt); });
  }
  throw lastError instanceof Error ? lastError : new Error('The outbound request failed.');
}

function headerRecord(init: RequestInit): Record<string, string> {
  const headers = new Headers(init.headers ?? {});
  const record: Record<string, string> = {};
  headers.forEach((value, key) => { record[key] = value; });
  return record;
}

async function once(url: URL, init: RequestInit): Promise<Response> {
  const secure = url.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  const body = init.body === undefined || init.body === null ? undefined : String(init.body);
  const headers = headerRecord(init);
  if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));

  return new Promise<Response>((resolve, reject) => {
    // Every path must settle exactly once. Destroying a request whose response
    // has already begun does not reliably emit 'error', so abort and stream
    // failure reject directly rather than waiting for a socket event that may
    // never arrive — otherwise a stalled body hangs the caller forever.
    let settled = false;
    const succeed = (response: Response): void => { if (!settled) { settled = true; resolve(response); } };
    const fail = (error: unknown): void => { if (!settled) { settled = true; reject(error); } };

    const request = send(url, {
      method: init.method ?? 'GET',
      headers,
      ...(secure ? { agent: new HttpsAgent({ keepAlive: false }) } : {}),
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      incoming.on('end', () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (typeof value === 'string') responseHeaders.set(key, value);
          else if (Array.isArray(value)) for (const entry of value) responseHeaders.append(key, entry);
        }
        const status = incoming.statusCode ?? 0;
        // A 1xx/204/304 body must stay null for the Response constructor.
        const payload = status === 204 || status === 304 || status < 200 ? null : Buffer.concat(chunks);
        const response = new Response(payload, { status, statusText: incoming.statusMessage ?? '', headers: responseHeaders });
        // Response.url is read-only on the constructor; callers verify the
        // final host from it, so it must reflect the URL actually requested.
        Object.defineProperty(response, 'url', { value: url.href, configurable: true });
        succeed(response);
      });
      incoming.on('error', fail);
      incoming.on('aborted', () => { fail(new Error('The outbound response was interrupted.')); });
    });

    // Attach the error listener before anything can destroy the request: an
    // 'error' event with no listener is an unhandled event and terminates the
    // process.
    request.on('error', fail);

    const signal = init.signal;
    if (signal) {
      if (signal.aborted) {
        request.destroy();
        fail(new Error('The outbound request was aborted.'));
        return;
      }
      signal.addEventListener('abort', () => {
        request.destroy();
        fail(new Error('The outbound request timed out.'));
      }, { once: true });
    }
    request.end(body);
  });
}
