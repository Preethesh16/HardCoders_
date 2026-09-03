import type { BaseHTTPClient, BaseHTTPClientResponse } from "algosdk";

type Query = Record<string, unknown>;

export class BoundedHttpError extends Error {
  constructor(readonly response: BaseHTTPClientResponse) {
    super(`Algod request failed with HTTP ${response.status}.`);
    this.name = "BoundedHttpError";
  }
}

export class BoundedAlgodHttpClient implements BaseHTTPClient {
  constructor(
    private readonly endpoint: URL,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly maxResponseBytes = 16 * 1024 * 1024,
  ) {
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
      throw new Error("Algod response size limit must be a positive safe integer.");
    }
  }

  get(path: string, query?: Query, headers?: Record<string, string>): Promise<BaseHTTPClientResponse> {
    return this.request("GET", path, undefined, query, headers);
  }

  post(path: string, data: Uint8Array, query?: Query, headers?: Record<string, string>): Promise<BaseHTTPClientResponse> {
    return this.request("POST", path, data, query, headers);
  }

  delete(path: string, data?: Uint8Array, query?: Query, headers?: Record<string, string>): Promise<BaseHTTPClientResponse> {
    return this.request("DELETE", path, data, query, headers);
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: Uint8Array,
    query?: Query,
    requestHeaders: Record<string, string> = {},
  ): Promise<BaseHTTPClientResponse> {
    if (!path.startsWith("/") || path.includes("..") || path.includes("//")) throw new Error("Invalid Algod path.");
    const url = new URL(this.endpoint);
    url.pathname = `${url.pathname.replace(/\/$/u, "")}${path}`;
    for (const [key, raw] of Object.entries(query ?? {})) {
      if (raw === undefined) continue;
      for (const value of Array.isArray(raw) ? raw : [raw]) url.searchParams.append(key, String(value));
    }
    const response = await fetch(url, {
      method,
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        ...requestHeaders,
        ...(this.token ? { "x-algo-api-token": this.token } : {}),
      },
      ...(body === undefined ? {} : { body: body as BodyInit }),
    });
    const declared = parseContentLength(response.headers.get("content-length"));
    if (declared !== null && declared > this.maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Algod response exceeds the size limit.");
    }
    const bytes = await readBoundedBody(response.body, this.maxResponseBytes);
    const result: BaseHTTPClientResponse = {
      body: bytes,
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
    };
    if (!response.ok) throw new BoundedHttpError(result);
    return result;
  }
}

export function parseContentLength(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) throw new Error("Algod returned an invalid Content-Length header.");
  const value = BigInt(raw);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Algod returned an invalid Content-Length header.");
  return Number(value);
}

async function readBoundedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Algod response exceeds the size limit.").catch(() => undefined);
        throw new Error("Algod response exceeds the size limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
