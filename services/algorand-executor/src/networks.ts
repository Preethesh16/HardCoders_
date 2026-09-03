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
