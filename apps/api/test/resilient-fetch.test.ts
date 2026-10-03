import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { resilientFetch } from '../src/http/resilient-fetch.js';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
});
async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('resilient outbound transport', () => {
  it('preserves a Request method, headers and binary body', async () => {
    const url = await listen(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      response.end(JSON.stringify({ method: request.method, token: request.headers['x-test'], bytes: [...Buffer.concat(chunks)] }));
    });
    const response = await resilientFetch(new Request(url, {
      method: 'POST', headers: { 'x-test': 'value' }, body: new Uint8Array([0, 128, 255]),
    }));
    expect(await response.json()).toEqual({ method: 'POST', token: 'value', bytes: [0, 128, 255] });
    expect(response.url).toBe(`${url}/`);
  });

  it.each([204, 205, 304])('handles a bodyless HTTP %s response', async (status) => {
    const url = await listen((_request, response) => { response.writeHead(status); response.end(); });
    const response = await resilientFetch(url);
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
  });

  it('returns a null body for HEAD', async () => {
    const url = await listen((_request, response) => { response.end('hello'); });
    const response = await resilientFetch(url, { method: 'HEAD' });
    expect(response.body).toBeNull();
  });

  it.each([429, 503])('retries HTTP %s and returns the later success', async (status) => {
    let calls = 0;
    const url = await listen((_request, response) => {
      calls += 1; response.writeHead(calls === 1 ? status : 200); response.end('result');
    });
    expect((await resilientFetch(url)).status).toBe(200);
    expect(calls).toBe(2);
  });

  it('returns authentication failures without retrying or exposing their bodies elsewhere', async () => {
    let calls = 0;
    const url = await listen((_request, response) => { calls += 1; response.writeHead(401); response.end('denied'); });
    expect((await resilientFetch(url)).status).toBe(401);
    expect(calls).toBe(1);
  });

  it('keeps redirects manual for caller host validation', async () => {
    let calls = 0;
    const url = await listen((_request, response) => { calls += 1; response.writeHead(302, { location: '/next' }); response.end(); });
    expect((await resilientFetch(url)).headers.get('location')).toBe('/next');
    expect(calls).toBe(1);
  });

  it('opens separate connections for successive HTTP requests', async () => {
    const ports: (number | undefined)[] = [];
    const url = await listen((request, response) => { ports.push(request.socket.remotePort); response.end('ok'); });
    await resilientFetch(url); await resilientFetch(url);
    expect(new Set(ports).size).toBe(2);
  });

  it('honors a pre-aborted signal before opening a connection', async () => {
    let calls = 0;
    const url = await listen((_request, response) => { calls += 1; response.end(); });
    const reason = new Error('caller cancelled');
    await expect(resilientFetch(url, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(calls).toBe(0);
  });

  it('settles a stalled response body when the caller aborts', async () => {
    const controller = new AbortController();
    let calls = 0;
    const url = await listen((_request, response) => {
      calls += 1; response.writeHead(200); response.write('partial');
      setTimeout(() => controller.abort(new Error('deadline reached')), 20);
    });
    await expect(resilientFetch(url, { signal: controller.signal })).rejects.toThrow('deadline reached');
    expect(calls).toBe(1);
  });

  it('stops an interrupted stream and retries only within its attempt limit', async () => {
    let calls = 0;
    const url = await listen((_request, response) => {
      calls += 1; response.writeHead(200); response.write('partial');
      setImmediate(() => response.destroy());
    });
    await expect(resilientFetch(url, {}, 2)).rejects.toThrow();
    expect(calls).toBe(2);
  });
  it.each([true, false])('rejects oversized responses before buffering them (declared: %s)', async (declared) => {
    let calls = 0;
    const url = await listen((_request, response) => {
      calls += 1;
      response.writeHead(200, declared ? { 'content-length': '1000' } : {});
      response.write('123456');
      response.end('789');
    });
    await expect(resilientFetch(url, { maximumBytes: 5 })).rejects.toThrow('response-size limit');
    expect(calls).toBe(1);
  });

  it('cancels retry backoff when the caller aborts', async () => {
    const controller = new AbortController();
    let calls = 0;
    const url = await listen((_request, response) => {
      calls += 1; response.writeHead(503); response.end();
      setTimeout(() => controller.abort(new Error('stop retries')), 20);
    });
    await expect(resilientFetch(url, { signal: controller.signal })).rejects.toThrow('stop retries');
    expect(calls).toBe(1);
  });

});
