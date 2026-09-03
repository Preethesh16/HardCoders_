import type { JWK } from 'jose';
import type { FabricIdentityConnection } from './ledger/fabric-connection.js';

export interface GatewayConfig {
  readonly appMode: 'demo' | 'production';
  readonly fabricMode: 'memory' | 'real';
  readonly host: string;
  readonly port: number;
  readonly logLevel: string;
  readonly channelName: string;
  readonly chaincodeName: string;
  readonly fabricIdentities: readonly FabricIdentityConnection[];
  readonly oidc?: { readonly issuer: string; readonly audience: string; readonly jwksUrl: string };
  readonly permit: {
    readonly issuer: string;
    readonly audience: string;
    readonly keyId: string;
    readonly ttlSeconds: number;
    readonly privateJwk?: JWK;
  };
  readonly idempotency: {
    readonly store: 'memory' | 'postgres';
    readonly databaseUrl?: string;
    readonly autoMigrate: boolean;
    readonly ttlMs: number;
    readonly maxEntries: number;
  };
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new Error(`Invalid integer configuration: ${value}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Integer configuration is outside ${minimum}..${maximum}.`);
  }
  return parsed;
}

function parseJson<T>(name: string, value: string | undefined): T | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const appMode = environment['APP_MODE'] ?? 'demo';
  const fabricMode = environment['FABRIC_MODE'] ?? 'memory';
  const store = environment['IDEMPOTENCY_STORE'] ?? 'memory';
  if (appMode !== 'demo' && appMode !== 'production') throw new Error('APP_MODE must be demo or production.');
  if (fabricMode !== 'memory' && fabricMode !== 'real') throw new Error('FABRIC_MODE must be memory or real.');
  if (store !== 'memory' && store !== 'postgres') throw new Error('IDEMPOTENCY_STORE must be memory or postgres.');
  const oidc = environment['OIDC_ISSUER'] === undefined ? undefined : {
    issuer: environment['OIDC_ISSUER'],
    audience: environment['OIDC_AUDIENCE'] ?? '',
    jwksUrl: environment['OIDC_JWKS_URL'] ?? '',
  };
  if (appMode === 'production' && (oidc === undefined || oidc.audience === '' || oidc.jwksUrl === '')) {
    throw new Error('Production mode requires complete OIDC configuration.');
  }
  const privateJwk = parseJson<JWK>('FABRIC_PERMIT_PRIVATE_JWK_JSON', environment['FABRIC_PERMIT_PRIVATE_JWK_JSON']);
  if (appMode === 'production' && privateJwk === undefined) {
    throw new Error('Production mode requires an injected Fabric permit private JWK.');
  }
  const fabricIdentities = parseJson<FabricIdentityConnection[]>(
    'FABRIC_IDENTITIES_JSON',
    environment['FABRIC_IDENTITIES_JSON'],
  ) ?? [];
  if (fabricMode === 'real' && fabricIdentities.length < 2) {
    throw new Error('Real Fabric mode requires seller and buyer identity connections.');
  }
  const databaseUrl = environment['IDEMPOTENCY_DATABASE_URL'];
  if (store === 'postgres' && databaseUrl === undefined) {
    throw new Error('PostgreSQL idempotency requires IDEMPOTENCY_DATABASE_URL.');
  }
  return {
    appMode,
    fabricMode,
    host: environment['HOST'] ?? '127.0.0.1',
    port: integer(environment['PORT'], 4200, 1, 65_535),
    logLevel: environment['LOG_LEVEL'] ?? 'info',
    channelName: environment['FABRIC_CHANNEL_NAME'] ?? 'optiwork-channel',
    chaincodeName: environment['FABRIC_CHAINCODE_NAME'] ?? 'optiwork-evidence',
    fabricIdentities,
    ...(oidc === undefined ? {} : { oidc }),
    permit: {
      issuer: environment['FABRIC_PERMIT_ISSUER'] ?? 'optiwork-fabric-gateway',
      audience: environment['FABRIC_PERMIT_AUDIENCE'] ?? 'optiwork-algorand-executor',
      keyId: environment['FABRIC_PERMIT_KEY_ID'] ?? 'optiwork-local-permit-1',
      ttlSeconds: integer(environment['FABRIC_PERMIT_TTL_SECONDS'], 60, 5, 120),
      ...(privateJwk === undefined ? {} : { privateJwk }),
    },
    idempotency: {
      store,
      ...(databaseUrl === undefined ? {} : { databaseUrl }),
      autoMigrate: environment['IDEMPOTENCY_AUTO_MIGRATE'] === 'true',
      ttlMs: integer(environment['IDEMPOTENCY_TTL_MS'], 900_000, 1_000, 86_400_000),
      maxEntries: integer(environment['IDEMPOTENCY_MAX_ENTRIES'], 10_000, 100, 100_000),
    },
  };
}
