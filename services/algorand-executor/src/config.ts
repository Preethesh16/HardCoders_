import algosdk from "algosdk";
import { z } from "zod";

import { assertNotDeniedNetwork, assertTestnetIdentity, assertTestnetSettlementAsset } from "./networks.js";

const canonicalUrl = z.string().url().transform((value, context) => {
  const parsed = new URL(value);
  if (!/^https?:$/u.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    context.addIssue({ code: "custom", message: "URL must be an HTTP(S) origin/path without credentials, query, or fragment." });
    return z.NEVER;
  }
  parsed.pathname = parsed.pathname.replace(/\/$/u, "");
  return parsed;
});

const optionalCanonicalUrl = z.preprocess(
  (value) => value === "" ? undefined : value,
  canonicalUrl.optional(),
);

const optionalSecret = (minimum: number, maximum: number) => z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(minimum).max(maximum).regex(/^\S+$/u).optional(),
);

const integer = (minimum: number, maximum: number, fallback: number) => z.preprocess(
  (value) => value === undefined || value === "" ? fallback : Number(value),
  z.number().int().min(minimum).max(maximum),
);

const environmentBoolean = z.enum(["true", "false"]).default("false").transform((value) => value === "true");

const envSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: integer(1, 65_535, 4301),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  EXECUTOR_BEARER_TOKEN: z.string().min(32).max(4096).regex(/^\S+$/u),
  DATABASE_URL: z.string().url().refine((value) => /^postgres(?:ql)?:/u.test(value), "PostgreSQL URL required."),
  DATABASE_SSL_MODE: z.enum(["disable", "require", "verify-full"]).default("disable"),
  DATABASE_AUTO_MIGRATE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  DATABASE_DEAL_LOCK_TIMEOUT_MS: integer(1_000, 300_000, 120_000),
  FABRIC_GATEWAY_URL: canonicalUrl,
  FABRIC_GATEWAY_BEARER_TOKEN: optionalSecret(16, 4096),
  FABRIC_GATEWAY_OIDC_TOKEN_URL: optionalCanonicalUrl,
  FABRIC_GATEWAY_OIDC_CLIENT_ID: optionalSecret(3, 256),
  FABRIC_GATEWAY_OIDC_CLIENT_SECRET: optionalSecret(16, 4096),
  FABRIC_GATEWAY_OIDC_SCOPE: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().min(1).max(512).regex(/^[\x21-\x7E]+(?: [\x21-\x7E]+)*$/u).optional(),
  ),
  FABRIC_GATEWAY_OIDC_REFRESH_SKEW_SECONDS: integer(1, 300, 30),
  FABRIC_GATEWAY_TIMEOUT_MS: integer(100, 30_000, 3_000),
  FABRIC_PERMIT_ISSUER: z.string().min(1).max(256),
  FABRIC_PERMIT_AUDIENCE: z.string().min(1).max(256),
  FABRIC_PERMIT_PUBLIC_JWK_JSON: z.string().min(1).max(16_384),
  FABRIC_PERMIT_MAX_AGE_SECONDS: integer(5, 300, 60),
  ALGORAND_RELEASE_SAFETY_MARGIN_SECONDS: integer(5, 600, 30),
  // "mock" serves the offline demo and LocalNet with a deterministic in-process
  // approved-evidence reader. It is refused on TestNet, where the real Fabric
  // Gateway must be the only source of an approved work version.
  FABRIC_EVIDENCE_MODE: z.enum(["gateway", "mock"]).default("gateway"),
  FABRIC_EVIDENCE_FIXTURE_PATH: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().min(1).max(4_096).optional(),
  ),
  ALGORAND_NETWORK: z.enum(["localnet", "testnet"]).default("localnet"),
  PUBLIC_TESTNET_DEMO: environmentBoolean,
  ALGORAND_ALGOD_URL: canonicalUrl,
  ALGORAND_ALGOD_TOKEN: z.string().max(4096).default(""),
  ALGORAND_INDEXER_URL: optionalCanonicalUrl,
  ALGORAND_REQUEST_TIMEOUT_MS: integer(500, 120_000, 15_000),
  ALGORAND_CONFIRMATION_ROUNDS: integer(1, 1_000, 12),
  ALGORAND_MAX_TRANSACTION_FEE_MICROALGOS: integer(1_000, 1_000_000, 10_000),
  ALGORAND_MAX_GROUP_FEE_MICROALGOS: integer(1_000, 16_000_000, 20_000),
  ALGORAND_GENESIS_HASH: z.string().min(16).max(256),
  ALGORAND_APPLICATION_ID: z.preprocess((value) => BigInt(String(value)), z.bigint().positive().max(BigInt(Number.MAX_SAFE_INTEGER))),
  ALGORAND_ASSET_ID: z.preprocess((value) => BigInt(String(value)), z.bigint().positive().max(BigInt(Number.MAX_SAFE_INTEGER))),
  ALGORAND_SIGNER_ADDRESS: z.string().refine((value) => algosdk.isValidAddress(value), "Invalid signer address."),
  ALGORAND_SIGNER_PRIVATE_KEY_BASE64: z.string().min(80).max(128).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS: z.string().refine((value) => algosdk.isValidAddress(value), "Invalid origin provider treasury address."),
  ALGORAND_ORIGIN_PROVIDER_TREASURY_PRIVATE_KEY_BASE64: z.string().min(80).max(128).regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  ALGORAND_MAX_VALIDITY_ROUNDS: integer(4, 1_000, 100),
});

export type FabricGatewayAuth =
  | { readonly mode: "static"; readonly bearerToken: string }
  | {
      readonly mode: "oidc";
      readonly tokenUrl: URL;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly scope?: string;
      readonly refreshSkewSeconds: number;
    };

type RawSecretField =
  | "FABRIC_PERMIT_PUBLIC_JWK_JSON"
  | "ALGORAND_SIGNER_PRIVATE_KEY_BASE64"
  | "ALGORAND_ORIGIN_PROVIDER_TREASURY_PRIVATE_KEY_BASE64"
  | "FABRIC_GATEWAY_BEARER_TOKEN"
  | "FABRIC_GATEWAY_OIDC_TOKEN_URL"
  | "FABRIC_GATEWAY_OIDC_CLIENT_ID"
  | "FABRIC_GATEWAY_OIDC_CLIENT_SECRET"
  | "FABRIC_GATEWAY_OIDC_SCOPE"
  | "FABRIC_GATEWAY_OIDC_REFRESH_SKEW_SECONDS";

export type ExecutorConfig = Omit<z.infer<typeof envSchema>, RawSecretField> & {
  permitPublicJwk: JsonWebKey & { kid: string };
  signerPrivateKey: Uint8Array;
  originProviderTreasuryPrivateKey: Uint8Array;
  fabricGatewayAuth: FabricGatewayAuth;
};

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/u, "$1").toLowerCase();
}

function isLoopback(url: URL): boolean {
  const hostname = normalizedHostname(url);
  return hostname === "localhost" || hostname === "::1" || /^127(?:\.[0-9]{1,3}){3}$/u.test(hostname);
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ExecutorConfig {
  // Zod object parsing intentionally strips unrelated process variables. Do
  // not make this schema strict: a normal process always contains PATH, HOME,
  // shell metadata, and other variables outside this service's namespace.
  const parsed = envSchema.parse(environment);

  if (parsed.FABRIC_EVIDENCE_MODE === "mock" && parsed.FABRIC_EVIDENCE_FIXTURE_PATH === undefined) {
    throw new Error("FABRIC_EVIDENCE_MODE=mock requires FABRIC_EVIDENCE_FIXTURE_PATH.");
  }
  if (parsed.FABRIC_EVIDENCE_MODE === "gateway" && parsed.FABRIC_EVIDENCE_FIXTURE_PATH !== undefined) {
    throw new Error("FABRIC_EVIDENCE_FIXTURE_PATH is only valid with FABRIC_EVIDENCE_MODE=mock.");
  }
  if (parsed.ALGORAND_MAX_GROUP_FEE_MICROALGOS < parsed.ALGORAND_MAX_TRANSACTION_FEE_MICROALGOS) {
    throw new Error("ALGORAND_MAX_GROUP_FEE_MICROALGOS must be at least the per-transaction fee cap.");
  }

  const databaseUrl = new URL(parsed.DATABASE_URL);
  if (databaseUrl.search || databaseUrl.hash) {
    throw new Error("DATABASE_URL must not contain query parameters or a fragment; configure TLS only with DATABASE_SSL_MODE.");
  }
  if (!isLoopback(databaseUrl) && parsed.DATABASE_SSL_MODE !== "verify-full") {
    throw new Error("A non-loopback DATABASE_URL requires DATABASE_SSL_MODE=verify-full.");
  }

  const oidcValues = [
    parsed.FABRIC_GATEWAY_OIDC_TOKEN_URL,
    parsed.FABRIC_GATEWAY_OIDC_CLIENT_ID,
    parsed.FABRIC_GATEWAY_OIDC_CLIENT_SECRET,
  ];
  const oidcConfigured = oidcValues.filter((value) => value !== undefined).length;
  if (parsed.FABRIC_GATEWAY_BEARER_TOKEN !== undefined && oidcConfigured > 0) {
    throw new Error("Configure either FABRIC_GATEWAY_BEARER_TOKEN or Gateway OIDC client credentials, never both.");
  }
  if (oidcConfigured !== 0 && oidcConfigured !== oidcValues.length) {
    throw new Error("Gateway OIDC requires token URL, client ID, and client secret together.");
  }
  if (parsed.FABRIC_GATEWAY_BEARER_TOKEN === undefined && oidcConfigured === 0) {
    throw new Error("Configure Gateway OIDC client credentials or a LocalNet-only static bearer token.");
  }
  if (parsed.FABRIC_GATEWAY_OIDC_SCOPE !== undefined && oidcConfigured === 0) {
    throw new Error("FABRIC_GATEWAY_OIDC_SCOPE requires Gateway OIDC client credentials.");
  }
  const fabricGatewayAuth: FabricGatewayAuth = oidcConfigured === oidcValues.length
    ? {
        mode: "oidc",
        tokenUrl: parsed.FABRIC_GATEWAY_OIDC_TOKEN_URL!,
        clientId: parsed.FABRIC_GATEWAY_OIDC_CLIENT_ID!,
        clientSecret: parsed.FABRIC_GATEWAY_OIDC_CLIENT_SECRET!,
        ...(parsed.FABRIC_GATEWAY_OIDC_SCOPE === undefined ? {} : { scope: parsed.FABRIC_GATEWAY_OIDC_SCOPE }),
        refreshSkewSeconds: parsed.FABRIC_GATEWAY_OIDC_REFRESH_SKEW_SECONDS,
      }
    : { mode: "static", bearerToken: parsed.FABRIC_GATEWAY_BEARER_TOKEN! };

  // A real-value genesis is refused for every mode, before any transport check,
  // so no combination of URLs or credentials can select MainNet or BetaNet.
  assertNotDeniedNetwork(parsed.ALGORAND_GENESIS_HASH);

  if (parsed.ALGORAND_NETWORK === "testnet") {
    const loopbackGatewayDemo = parsed.PUBLIC_TESTNET_DEMO && isLoopback(parsed.FABRIC_GATEWAY_URL);
    if (parsed.ALGORAND_ALGOD_URL.protocol !== "https:"
      || (parsed.FABRIC_GATEWAY_URL.protocol !== "https:" && !loopbackGatewayDemo)) {
      throw new Error("Testnet requires HTTPS for Algod and the Fabric Gateway, except an explicitly enabled loopback demo Gateway.");
    }
    if (parsed.ALGORAND_INDEXER_URL !== undefined && parsed.ALGORAND_INDEXER_URL.protocol !== "https:") {
      throw new Error("Testnet requires an HTTPS ALGORAND_INDEXER_URL.");
    }
    const loopbackOidcDemo = fabricGatewayAuth.mode === "oidc"
      && parsed.PUBLIC_TESTNET_DEMO
      && isLoopback(fabricGatewayAuth.tokenUrl);
    if (fabricGatewayAuth.mode !== "oidc"
      || (fabricGatewayAuth.tokenUrl.protocol !== "https:" && !loopbackOidcDemo)) {
      throw new Error("Testnet requires HTTPS Gateway OIDC client credentials, except explicitly enabled loopback demo OIDC; static bearer tokens are LocalNet-only.");
    }
    // Pin the exact public TestNet genesis identity. Transport checks run first
    // so their more specific messages are preserved for existing operators.
    assertTestnetIdentity(parsed.ALGORAND_GENESIS_HASH);
    // TestNet settles only in Circle's official zero-value USDC ASA.
    assertTestnetSettlementAsset(parsed.ALGORAND_ASSET_ID);
    if (parsed.FABRIC_EVIDENCE_MODE !== "gateway") {
      throw new Error("TestNet requires FABRIC_EVIDENCE_MODE=gateway; the mock evidence reader is LocalNet-only.");
    }
  } else {
    const localUrls = [
      ["ALGORAND_ALGOD_URL", parsed.ALGORAND_ALGOD_URL],
      ["FABRIC_GATEWAY_URL", parsed.FABRIC_GATEWAY_URL],
      ...(parsed.ALGORAND_INDEXER_URL === undefined ? [] : [["ALGORAND_INDEXER_URL", parsed.ALGORAND_INDEXER_URL] as const]),
    ] as const;
    for (const [name, url] of localUrls) {
      if (url.protocol !== "https:" && !isLoopback(url)) throw new Error(`${name} permits HTTP only on loopback LocalNet.`);
    }
    if (fabricGatewayAuth.mode === "oidc"
      && fabricGatewayAuth.tokenUrl.protocol !== "https:"
      && !isLoopback(fabricGatewayAuth.tokenUrl)) {
      throw new Error("FABRIC_GATEWAY_OIDC_TOKEN_URL permits HTTP only on loopback LocalNet.");
    }
  }

  let permitPublicJwk: unknown;
  try {
    permitPublicJwk = JSON.parse(parsed.FABRIC_PERMIT_PUBLIC_JWK_JSON) as unknown;
  } catch {
    throw new Error("FABRIC_PERMIT_PUBLIC_JWK_JSON must contain valid JSON.");
  }
  const jwk = z.object({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    x: z.string().min(40).max(64),
    kid: z.string().min(1).max(128),
    use: z.literal("sig").optional(),
    alg: z.literal("EdDSA").optional(),
  }).strict().parse(permitPublicJwk) as JsonWebKey & { kid: string };

  const decodePrivateKey = (encoded: string, address: string, name: string): Uint8Array => {
    const privateKey = Buffer.from(encoded, "base64");
    if (privateKey.length !== 64) throw new Error(`${name} must decode to exactly 64 bytes.`);
    const derivedAddress = algosdk.encodeAddress(privateKey.subarray(32));
    if (derivedAddress.toString() !== address) throw new Error(`${name} does not match its configured address.`);
    return privateKey;
  };
  const signerPrivateKey = decodePrivateKey(
    parsed.ALGORAND_SIGNER_PRIVATE_KEY_BASE64,
    parsed.ALGORAND_SIGNER_ADDRESS,
    "ALGORAND_SIGNER_PRIVATE_KEY_BASE64",
  );
  const originProviderTreasuryPrivateKey = decodePrivateKey(
    parsed.ALGORAND_ORIGIN_PROVIDER_TREASURY_PRIVATE_KEY_BASE64,
    parsed.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS,
    "ALGORAND_ORIGIN_PROVIDER_TREASURY_PRIVATE_KEY_BASE64",
  );
  if (parsed.ALGORAND_ORIGIN_PROVIDER_TREASURY_ADDRESS === parsed.ALGORAND_SIGNER_ADDRESS) {
    throw new Error("The origin provider treasury and executor must use distinct Algorand accounts.");
  }

  const {
    FABRIC_PERMIT_PUBLIC_JWK_JSON: _jwkJson,
    ALGORAND_SIGNER_PRIVATE_KEY_BASE64: _signerKey,
    ALGORAND_ORIGIN_PROVIDER_TREASURY_PRIVATE_KEY_BASE64: _originTreasuryKey,
    FABRIC_GATEWAY_BEARER_TOKEN: _gatewayBearer,
    FABRIC_GATEWAY_OIDC_TOKEN_URL: _oidcTokenUrl,
    FABRIC_GATEWAY_OIDC_CLIENT_ID: _oidcClientId,
    FABRIC_GATEWAY_OIDC_CLIENT_SECRET: _oidcClientSecret,
    FABRIC_GATEWAY_OIDC_SCOPE: _oidcScope,
    FABRIC_GATEWAY_OIDC_REFRESH_SKEW_SECONDS: _oidcRefreshSkew,
    ...safe
  } = parsed;
  return { ...safe, fabricGatewayAuth, permitPublicJwk: jwk, signerPrivateKey, originProviderTreasuryPrivateKey };
}
