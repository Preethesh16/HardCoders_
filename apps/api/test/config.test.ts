import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { EXECUTABLE_CORRIDOR_BOOKS } from '../src/payments/providers.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

async function manifest(overrides: Record<string, unknown> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'anchor-api-config-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'deployment.json');
  await writeFile(path, JSON.stringify({
    schemaVersion: '1.0',
    network: 'localnet',
    genesisHash: 'localnet-genesis-hash',
    applicationId: '1001',
    assetId: 1002,
    executorAddress: 'A'.repeat(58),
    providers: Object.fromEntries(EXECUTABLE_CORRIDOR_BOOKS.map((bookId) => [bookId, {
      originAddress: 'B'.repeat(58), destinationAddress: 'C'.repeat(58),
    }])),
    ...overrides,
  }));
  return path;
}

function environment(path: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPTIWORK_PROFILE: 'demo',
    ALGORAND_MODE: 'executor',
    ALGORAND_NETWORK: 'localnet',
    ALGORAND_EXECUTOR_URL: 'http://127.0.0.1:4301',
    ALGORAND_EXECUTOR_TOKEN: 'local-token',
    ALGORAND_DEPLOYMENT_MANIFEST_PATH: path,
    FABRIC_MODE: 'gateway',
    FABRIC_GATEWAY_URL: 'http://127.0.0.1:4200',
    FABRIC_GATEWAY_AUTH_MODE: 'demo',
    ...overrides,
  };
}

describe('API Algorand deployment manifest', () => {
  it('accepts exactly the ACTIVE provider books', async () => {
    const path = await manifest();
    const config = loadConfig(environment(path));
    expect(Object.keys(config.algorand.deployment!.providers).sort())
      .toEqual([...EXECUTABLE_CORRIDOR_BOOKS].sort());
  });

  it('requires a provider pair for each supported corridor', async () => {
    const path = await manifest({
      providers: {
        'PL-IN-INWARD': { originAddress: 'B'.repeat(58), destinationAddress: 'C'.repeat(58) },
      },
    });

    expect(() => loadConfig(environment(path))).toThrow(/every supported corridor book/iu);
  });

  it('rejects a deployment from another Algorand network', async () => {
    const path = await manifest({ network: 'testnet' });

    expect(() => loadConfig(environment(path))).toThrow(/network does not match/iu);
  });

  it('rejects a manifest that tries to make a review-only book executable', async () => {
    const active = Object.fromEntries(EXECUTABLE_CORRIDOR_BOOKS.map((bookId) => [bookId, {
      originAddress: 'B'.repeat(58), destinationAddress: 'C'.repeat(58),
    }]));
    const path = await manifest({
      providers: {
        ...active,
        'PL-RU-OUTWARD': { originAddress: 'F'.repeat(58), destinationAddress: 'G'.repeat(58) },
      },
    });
    expect(() => loadConfig(environment(path))).toThrow(/PL-RU-OUTWARD is invalid/u);
  });
});
