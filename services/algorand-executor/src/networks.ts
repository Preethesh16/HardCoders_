/**
 * Pinned public Algorand network identities.
 *
 * These are public, non-secret protocol constants. They exist so that a
 * misconfigured endpoint can never silently move the demonstration onto a
 * different chain than the one the operator intended.
 *
 * Truth boundary for this project: the public demonstration runs on **Algorand
 * TestNet with dummy TestAlgos that carry no monetary value**. MainNet is
 * explicitly denied everywhere, including in configuration validation, so a
 * copied endpoint or a mistyped genesis hash fails closed instead of touching a
 * real-value network.
 */

export const ALGORAND_TESTNET_GENESIS_ID = "testnet-v1.0" as const;
export const ALGORAND_TESTNET_GENESIS_HASH = "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=" as const;

/**
 * Networks this project must never transact on. MainNet carries real value;
 * BetaNet runs unreleased consensus and is not an approved demonstration
 * target. Both are rejected by genesis hash and by genesis ID so that neither a
 * hostile endpoint nor an operator typo can select them.
 */
export const DENIED_GENESIS = Object.freeze({
  "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=": "mainnet-v1.0",
  "mFgazF+2uRS1tMiL9dsj01hJGySEmPN28B/TjjvpVW0=": "betanet-v1.0",
} as Readonly<Record<string, string>>);

export const DENIED_GENESIS_IDS: readonly string[] = Object.freeze(["mainnet-v1.0", "betanet-v1.0"]);

/** Human-readable label that every TestNet-facing surface must display. */
export const TESTNET_FUNDS_LABEL = "ALGORAND TESTNET — DUMMY FUNDS" as const;

/** The official Algorand TestNet dispenser for zero-value funding. */
export const TESTNET_DISPENSER_URL = "https://bank.testnet.algorand.network/" as const;

export type SupportedNetwork = "localnet" | "testnet";

/**
 * Circle's official zero-value USDC ASA on public Algorand TestNet.
 *
 * TestNet settlement must use this asset. The project never deploys its own
 * TestNet stablecoin, so an operator cannot accidentally demonstrate against a
 * self-minted token and present it as USDC.
 */
export const ALGORAND_TESTNET_USDC_ASSET_ID = 10_458_941n;

/**
 * LocalNet settlement asset. AlgoKit LocalNet mints a fresh chain on every
 * reset, so the demo asset is created per environment and only its shape is
 * pinned here: six decimals, matching USDC.
 */
export const LOCALNET_DEMO_ASSET = Object.freeze({
  assetName: "OptiUSD-DEMO",
  unitName: "OPTIUSD",
  decimals: 6,
  total: 100_000_000_000_000n,
} as const);

/** Both supported networks settle a six-decimal USD-denominated unit. */
export const SETTLEMENT_ASSET_DECIMALS = 6;

/**
 * TestNet must settle in the official Circle test USDC ASA. Any other asset ID
 * is refused before a signer or endpoint is ever used.
 */
export function assertTestnetSettlementAsset(assetId: bigint): void {
  if (assetId !== ALGORAND_TESTNET_USDC_ASSET_ID) {
    throw new Error(
      `TestNet settlement requires the official Circle USDC ASA ${ALGORAND_TESTNET_USDC_ASSET_ID}, not ${assetId}. `
      + "This project never deploys a custom TestNet settlement asset.",
    );
  }
}

/**
 * Rejects any genesis identity that belongs to a denied network. This runs for
 * every network selection, including `localnet`, because the guard's purpose is
 * to make a real-value chain unreachable regardless of the configured mode.
 */
export function assertNotDeniedNetwork(genesisHash: string, genesisId?: string): void {
  const deniedByHash = DENIED_GENESIS[genesisHash];
  if (deniedByHash !== undefined) {
    throw new Error(
      `Refusing to operate on ${deniedByHash}: this project is restricted to Algorand LocalNet and TestNet with zero-value funds.`,
    );
  }
  if (genesisId !== undefined && DENIED_GENESIS_IDS.includes(genesisId)) {
    throw new Error(
      `Refusing to operate on ${genesisId}: this project is restricted to Algorand LocalNet and TestNet with zero-value funds.`,
    );
  }
}

/**
 * Asserts that an observed genesis identity is exactly public TestNet.
 *
 * `genesisId` is optional because `GET /v2/transactions/params` returns it but
 * some call sites only carry the hash. When present it must also match, so a
 * fork that replayed the TestNet genesis hash under a different ID is refused.
 */
export function assertTestnetIdentity(genesisHash: string, genesisId?: string): void {
  assertNotDeniedNetwork(genesisHash, genesisId);
  if (genesisHash !== ALGORAND_TESTNET_GENESIS_HASH) {
    throw new Error(
      `Algod reported genesis hash ${genesisHash}, which is not the pinned public Algorand TestNet genesis hash.`,
    );
  }
  if (genesisId !== undefined && genesisId !== ALGORAND_TESTNET_GENESIS_ID) {
    throw new Error(
      `Algod reported genesis ID ${genesisId}, which is not ${ALGORAND_TESTNET_GENESIS_ID}.`,
    );
  }
}

/**
 * Validates the network/genesis pair a configuration selected.
 *
 * `localnet` deliberately accepts any non-denied genesis hash: AlgoKit LocalNet
 * mints a fresh genesis on every reset, so pinning one would break the
 * deterministic regression path this project must keep working.
 */
export function assertNetworkGenesis(network: SupportedNetwork, genesisHash: string, genesisId?: string): void {
  if (network === "testnet") {
    assertTestnetIdentity(genesisHash, genesisId);
    return;
  }
  assertNotDeniedNetwork(genesisHash, genesisId);
}
