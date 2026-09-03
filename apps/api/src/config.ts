import { readFileSync } from 'node:fs';

/**
 * Runtime configuration.
 *
 * Everything a demo needs has a safe default, and nothing here ever reads a
 * secret from a source-controlled file. Secrets arrive only through the
 * environment and are never logged or returned by a route.
 */

export type Profile = 'demo' | 'local' | 'testnet';

export interface ApiConfig {
  readonly profile: Profile;
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly databaseUrl?: string;
  readonly auth: {
    readonly mode: 'oidc' | 'demo';
    readonly issuer: string;
    readonly audience: string;
    readonly jwksUri?: string;
    readonly rolesClaim: string;
  };
  readonly storage: {
    readonly mode: 's3' | 'memory';
    readonly endpoint?: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId?: string;
    readonly secretAccessKey?: string;
    readonly signedUrlTtlSeconds: number;
  };
  readonly fx: {
    readonly mode: 'fixture' | 'frankfurter';
    readonly baseUrl: string;
    readonly quoteTtlSeconds: number;
  };
  readonly ai: {
    readonly mode: 'fixture' | 'openai';
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKey?: string;
  };
  readonly regulations: {
    readonly refreshMode: 'fixture' | 'live';
  };
  readonly algorand: {
    readonly mode: 'executor' | 'simulated';
    readonly executorUrl?: string;
    readonly executorToken?: string;
    readonly network: 'localnet' | 'testnet';
    readonly explorerBaseUrl: string;
    readonly deployment?: AlgorandDeploymentManifest;
  };
  readonly fabric: {
    readonly mode: 'gateway' | 'mock';
    readonly gatewayAuthMode: 'demo' | 'bearer';
    readonly gatewayUrl?: string;
    readonly gatewayToken?: string;
    readonly gatewayTimeoutMs: number;
    readonly evidenceFixturePath?: string;
  };
}

export interface AlgorandDeploymentManifest {
  readonly schemaVersion: '1.0';
  readonly network: 'localnet' | 'testnet';
  readonly genesisHash: string;
  readonly applicationId: string;
  readonly assetId: number;
  readonly executorAddress: string;
  readonly providers: Readonly<Record<string, {
    readonly originAddress: string;
    readonly destinationAddress: string;
  }>>;
}

const text = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = env[key];
  return value === undefined || value.trim() === '' ? undefined : value.trim();
};

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum: number, maximum: number): number {
  const raw = text(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${key} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function choice<T extends string>(env: NodeJS.ProcessEnv, key: string, allowed: readonly T[], fallback: T): T {
  const raw = text(env, key);
  if (raw === undefined) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`${key} must be one of ${allowed.join(', ')}.`);
  }
  return raw as T;
}

function loadAlgorandManifest(path: string | undefined): AlgorandDeploymentManifest | undefined {
  if (path === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    throw new Error('ALGORAND_DEPLOYMENT_MANIFEST_PATH must reference readable JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('The Algorand deployment manifest is invalid.');
  }
  const record = parsed as Record<string, unknown>;
  const providers = record['providers'];
  const applicationId = record['applicationId'];
  const assetId = record['assetId'];
  const address = /^[A-Z2-7]{58}$/u;
  if (record['schemaVersion'] !== '1.0'
    || (record['network'] !== 'localnet' && record['network'] !== 'testnet')
    || typeof record['genesisHash'] !== 'string' || record['genesisHash'].length < 16
    || typeof applicationId !== 'string' || !/^[1-9][0-9]*$/u.test(applicationId)
    || !Number.isSafeInteger(assetId) || (assetId as number) < 1
    || typeof record['executorAddress'] !== 'string' || !address.test(record['executorAddress'])
    || typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    throw new Error('The Algorand deployment manifest is invalid.');
  }
  for (const [bookId, pair] of Object.entries(providers as Record<string, unknown>)) {
    if (!['PL-IN-INWARD', 'IN-GB-OUTWARD'].includes(bookId)
      || typeof pair !== 'object' || pair === null || Array.isArray(pair)
      || !address.test(String((pair as Record<string, unknown>)['originAddress']))
      || !address.test(String((pair as Record<string, unknown>)['destinationAddress']))) {
      throw new Error(`The Algorand provider mapping for ${bookId} is invalid.`);
    }
  }
  if (!['PL-IN-INWARD', 'IN-GB-OUTWARD'].every((bookId) => Object.hasOwn(providers, bookId))
    || Object.keys(providers).length !== 2) {
    throw new Error('The Algorand deployment manifest must map both supported corridor books exactly once.');
  }
  return parsed as AlgorandDeploymentManifest;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const profile = choice(env, 'OPTIWORK_PROFILE', ['demo', 'local', 'testnet'] as const, 'demo');
  const databaseUrl = text(env, 'DATABASE_URL');
  if (profile !== 'demo' && databaseUrl === undefined) {
    throw new Error('DATABASE_URL is required outside the demo profile.');
  }

  const openAiKey = text(env, 'OPENAI_API_KEY');
  const aiMode = choice(env, 'AI_MODE', ['fixture', 'openai'] as const, openAiKey ? 'openai' : 'fixture');
  if (aiMode === 'openai' && openAiKey === undefined) {
    throw new Error('AI_MODE=openai requires OPENAI_API_KEY.');
  }

  const algorandMode = choice(env, 'ALGORAND_MODE', ['executor', 'simulated'] as const, profile === 'demo' ? 'simulated' : 'executor');
  const executorUrl = text(env, 'ALGORAND_EXECUTOR_URL');
  const executorToken = text(env, 'ALGORAND_EXECUTOR_TOKEN');
  const algorandNetwork = choice(env, 'ALGORAND_NETWORK', ['localnet', 'testnet'] as const, 'localnet');
  const algorandManifest = loadAlgorandManifest(text(env, 'ALGORAND_DEPLOYMENT_MANIFEST_PATH'));
  if (algorandMode === 'executor' && (executorUrl === undefined || executorToken === undefined)) {
    throw new Error('ALGORAND_MODE=executor requires ALGORAND_EXECUTOR_URL and ALGORAND_EXECUTOR_TOKEN.');
  }
  if (algorandMode === 'executor' && algorandManifest === undefined) {
    throw new Error('ALGORAND_MODE=executor requires ALGORAND_DEPLOYMENT_MANIFEST_PATH.');
  }
  if (algorandManifest !== undefined && algorandManifest.network !== algorandNetwork) {
    throw new Error('The Algorand deployment manifest network does not match ALGORAND_NETWORK.');
  }

  const authMode = choice(env, 'AUTH_MODE', ['oidc', 'demo'] as const, profile === 'demo' ? 'demo' : 'oidc');
  const jwksUri = text(env, 'OIDC_JWKS_URI');
  if (authMode === 'oidc' && jwksUri === undefined) {
    throw new Error('AUTH_MODE=oidc requires OIDC_JWKS_URI.');
  }

  const storageMode = choice(env, 'STORAGE_MODE', ['s3', 'memory'] as const, profile === 'demo' ? 'memory' : 's3');
  const fabricMode = choice(env, 'FABRIC_MODE', ['gateway', 'mock'] as const, profile === 'demo' ? 'mock' : 'gateway');
  const fabricGatewayUrl = text(env, 'FABRIC_GATEWAY_URL');
  const fabricGatewayToken = text(env, 'FABRIC_GATEWAY_TOKEN');
  if ((fabricMode === 'gateway' || algorandMode === 'executor') && fabricGatewayUrl === undefined) {
    throw new Error('Fabric Gateway URL is required for gateway or executor mode.');
  }
  const fabricGatewayAuthMode = choice(
    env,
    'FABRIC_GATEWAY_AUTH_MODE',
    ['demo', 'bearer'] as const,
    profile === 'demo' ? 'demo' : 'bearer',
  );
  if (fabricGatewayAuthMode === 'demo') {
    if (profile !== 'demo') throw new Error('Fabric Gateway demo authentication is allowed only in the demo profile.');
    if (fabricGatewayUrl !== undefined) {
      const hostname = new URL(fabricGatewayUrl).hostname;
      if (!['127.0.0.1', 'localhost', 'fabric-gateway'].includes(hostname)) {
        throw new Error('Fabric Gateway demo authentication requires a loopback or local Compose Gateway URL.');
      }
    }
  } else if (fabricMode === 'gateway' && fabricGatewayToken === undefined) {
    throw new Error('Fabric Gateway bearer authentication requires FABRIC_GATEWAY_TOKEN.');
  }

  return {
    profile,
    host: text(env, 'API_HOST') ?? '127.0.0.1',
    port: integer(env, 'API_PORT', 4000, 1, 65_535),
    version: text(env, 'OPTIWORK_VERSION') ?? '0.1.0',
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    auth: {
      mode: authMode,
      issuer: text(env, 'OIDC_ISSUER') ?? 'http://127.0.0.1:18080/realms/optiwork',
      audience: text(env, 'OIDC_AUDIENCE') ?? 'optiwork-api',
      ...(jwksUri === undefined ? {} : { jwksUri }),
      rolesClaim: text(env, 'OIDC_ROLES_CLAIM') ?? 'roles',
    },
    storage: {
      mode: storageMode,
      ...(text(env, 'S3_ENDPOINT') === undefined ? {} : { endpoint: text(env, 'S3_ENDPOINT')! }),
      region: text(env, 'S3_REGION') ?? 'us-east-1',
      bucket: text(env, 'S3_BUCKET') ?? 'optiwork-documents',
      ...(text(env, 'S3_ACCESS_KEY_ID') === undefined ? {} : { accessKeyId: text(env, 'S3_ACCESS_KEY_ID')! }),
      ...(text(env, 'S3_SECRET_ACCESS_KEY') === undefined ? {} : { secretAccessKey: text(env, 'S3_SECRET_ACCESS_KEY')! }),
      signedUrlTtlSeconds: integer(env, 'S3_SIGNED_URL_TTL_SECONDS', 300, 30, 3_600),
    },
    fx: {
      mode: choice(env, 'FX_MODE', ['fixture', 'frankfurter'] as const, 'fixture'),
      baseUrl: text(env, 'FX_FRANKFURTER_URL') ?? 'https://api.frankfurter.app',
      quoteTtlSeconds: integer(env, 'FX_QUOTE_TTL_SECONDS', 900, 30, 86_400),
    },
    ai: {
      mode: aiMode,
      baseUrl: text(env, 'OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
      model: text(env, 'OPENAI_MODEL') ?? 'gpt-4.1-mini',
      ...(openAiKey === undefined ? {} : { apiKey: openAiKey }),
    },
    regulations: {
      refreshMode: choice(env, 'REGULATION_REFRESH_MODE', ['fixture', 'live'] as const, 'live'),
    },
    algorand: {
      mode: algorandMode,
      ...(executorUrl === undefined ? {} : { executorUrl }),
      ...(executorToken === undefined ? {} : { executorToken }),
      network: algorandNetwork,
      explorerBaseUrl: text(env, 'ALGORAND_EXPLORER_BASE_URL') ?? 'https://lora.algokit.io/testnet',
      ...(algorandManifest === undefined ? {} : { deployment: algorandManifest }),
    },
    fabric: {
      mode: fabricMode,
      gatewayAuthMode: fabricGatewayAuthMode,
      ...(fabricGatewayUrl === undefined ? {} : { gatewayUrl: fabricGatewayUrl }),
      ...(fabricGatewayToken === undefined ? {} : { gatewayToken: fabricGatewayToken }),
      gatewayTimeoutMs: integer(env, 'FABRIC_GATEWAY_TIMEOUT_MS', 4_000, 250, 30_000),
      ...(text(env, 'FABRIC_EVIDENCE_FIXTURE_PATH') === undefined
        ? {}
        : { evidenceFixturePath: text(env, 'FABRIC_EVIDENCE_FIXTURE_PATH')! }),
    },
  };
}
