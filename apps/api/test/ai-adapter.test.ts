import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAiAdapter } from '../src/ai/adapter.js';

afterEach(() => vi.unstubAllGlobals());

describe('OpenAI advisory adapter', () => {
  it('reads raw Responses API output and uses the configured /v1 endpoint', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      model: 'gpt-4.1-mini-test',
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify({ score: 87, summary: 'Strong skills match; human selection is still required.', citations: [] }),
        }],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OpenAiAdapter({
      mode: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini', apiKey: 'test-only',
    });

    const result = await adapter.evaluate({
      purpose: 'APPLICATION_SCORING',
      instruction: 'Score fit. Advisory only.',
      facts: { skillMatches: 3, priorContracts: 1 },
    });

    expect(result).toMatchObject({ source: 'OPENAI', model: 'gpt-4.1-mini-test', score: 87, advisoryOnly: true });
    const firstCall = fetchMock.mock.calls[0];
    expect(String(firstCall?.[0])).toBe('https://api.openai.com/v1/responses');
    const request = JSON.parse(String(firstCall?.[1]?.body));
    expect(request.text.format).toMatchObject({ type: 'json_schema', strict: true });
  });
});
