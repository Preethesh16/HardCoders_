import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpFabricPermitProvider } from '../src/algorand/executor-client.js';

function gatewayResponse(permit = 'signed-fabric-permit-that-is-long-enough-for-validation'): Response {
  return new Response(JSON.stringify({ success: true, data: { permit }, error: null }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('HTTP Fabric permit provider', () => {
  it('requests lifecycle permits with an exact executor command', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => gatewayResponse());
    vi.stubGlobal('fetch', fetchMock);
    const provider = new HttpFabricPermitProvider({ baseUrl: 'http://fabric-gateway:4200' });

    await expect(provider.issue('fund', '/escrows/DEAL-001/fund', 'FUND-001', null))
      .resolves.toContain('signed-fabric-permit');

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe('http://fabric-gateway:4200/v1/command-permits');
    expect(JSON.parse(String(init?.body))).toEqual({
      command: {
        action: 'fund', method: 'POST', path: '/escrows/DEAL-001/fund', idempotencyKey: 'FUND-001', body: null,
      },
    });
    const headers = new Headers(init?.headers);
    expect(headers.get('idempotency-key')).toBe('PERMIT:FUND-001');
    expect(headers.get('x-demo-role')).toBe('payments_service');
  });

  it('requests release permits from the approved evidence aggregate using bearer auth', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => gatewayResponse());
    vi.stubGlobal('fetch', fetchMock);
    const provider = new HttpFabricPermitProvider({
      baseUrl: 'https://fabric.example.test/base/',
      bearerToken: 'workload-token',
    });

    await provider.issue('release', '/escrows/DEAL-001/releases', 'RELEASE-001', {
      evidenceId: 'EVID:PL-IN:001',
    });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe('https://fabric.example.test/v1/evidence/EVID%3APL-IN%3A001/release-permits');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer workload-token');
    expect(headers.has('x-demo-role')).toBe(false);
  });

  it('fails closed when a release has no evidence identity', async () => {
    const provider = new HttpFabricPermitProvider({ baseUrl: 'http://fabric-gateway:4200' });
    await expect(provider.issue('release', '/escrows/DEAL-001/releases', 'RELEASE-001', {}))
      .rejects.toMatchObject({ code: 'UNPROCESSABLE' });
  });
});
