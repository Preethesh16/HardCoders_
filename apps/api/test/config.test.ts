import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

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
    providers: {
      'PL-IN-INWARD': { originAddress: 'B'.repeat(58), destinationAddress: 'C'.repeat(58) },
      'IN-GB-OUTWARD': { originAddress: 'D'.repeat(58), destinationAddress: 'E'.repeat(58) },
    },
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
  it('requires a provider pair for each supported corridor', async () => {
    const path = await manifest({
      providers: {
        'PL-IN-INWARD': { originAddress: 'B'.repeat(58), destinationAddress: 'C'.repeat(58) },
      },
    });

    expect(() => loadConfig(environment(path))).toThrow(/both supported corridor books/iu);
  });

  it('rejects a deployment from another Algorand network', async () => {
    const path = await manifest({ network: 'testnet' });

    expect(() => loadConfig(environment(path))).toThrow(/network does not match/iu);
  });
});
