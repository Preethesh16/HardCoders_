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
  readonly algorand: {
    readonly mode: 'executor' | 'simulated';
    readonly executorUrl?: string;
    readonly executorToken?: string;
    readonly network: 'localnet' | 'testnet';
    readonly explorerBaseUrl: string;
  };
  readonly fabric: {
    readonly mode: 'gateway' | 'mock';
    readonly gatewayUrl?: string;
    readonly evidenceFixturePath?: string;
  };
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
  if (algorandMode === 'executor' && (executorUrl === undefined || executorToken === undefined)) {
    throw new Error('ALGORAND_MODE=executor requires ALGORAND_EXECUTOR_URL and ALGORAND_EXECUTOR_TOKEN.');
  }

  const authMode = choice(env, 'AUTH_MODE', ['oidc', 'demo'] as const, profile === 'demo' ? 'demo' : 'oidc');
  const jwksUri = text(env, 'OIDC_JWKS_URI');
  if (authMode === 'oidc' && jwksUri === undefined) {
    throw new Error('AUTH_MODE=oidc requires OIDC_JWKS_URI.');
  }

  const storageMode = choice(env, 'STORAGE_MODE', ['s3', 'memory'] as const, profile === 'demo' ? 'memory' : 's3');
  const fabricMode = choice(env, 'FABRIC_MODE', ['gateway', 'mock'] as const, profile === 'testnet' ? 'gateway' : 'mock');

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
    algorand: {
      mode: algorandMode,
      ...(executorUrl === undefined ? {} : { executorUrl }),
      ...(executorToken === undefined ? {} : { executorToken }),
      network: choice(env, 'ALGORAND_NETWORK', ['localnet', 'testnet'] as const, 'localnet'),
      explorerBaseUrl: text(env, 'ALGORAND_EXPLORER_BASE_URL') ?? 'https://lora.algokit.io/testnet',
    },
    fabric: {
      mode: fabricMode,
      ...(text(env, 'FABRIC_GATEWAY_URL') === undefined ? {} : { gatewayUrl: text(env, 'FABRIC_GATEWAY_URL')! }),
      ...(text(env, 'FABRIC_EVIDENCE_FIXTURE_PATH') === undefined
        ? {}
        : { evidenceFixturePath: text(env, 'FABRIC_EVIDENCE_FIXTURE_PATH')! }),
    },
  };
}
