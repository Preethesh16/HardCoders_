/** Shared, non-secret constants for the TestNet deployment path. */

/** Ignored, owner-only default location for disposable TestNet key material. */
export const DEFAULT_TESTNET_ACCOUNTS_PATH = "generated-credentials/testnet-accounts.json";

/** Sanitized, publishable deployment manifest written by the TestNet deployer. */
export const DEFAULT_TESTNET_MANIFEST_PATH = "testnet/deployment-manifest.json";

/**
 * Dummy TestAlgos the deployer must hold before deployment starts.
 *
 * Budget: 2 ALGO of application-account minimum balance for box storage,
 * 1.2 ALGO distributed to the buyer treasury and three sellers for their own
 * minimum balances and asset opt-ins, plus headroom for the deployer's own
 * minimum balance, the created asset, and transaction fees. A single official
 * dispenser grant covers this comfortably.
 */
export const MINIMUM_DEPLOYER_FUNDING_ALGOS = 5;
export const MINIMUM_DEPLOYER_FUNDING_MICROALGOS = BigInt(MINIMUM_DEPLOYER_FUNDING_ALGOS) * 1_000_000n;

/** Dummy TestAlgos each participant account receives from the deployer. */
export const PARTICIPANT_FUNDING_MICROALGOS = 300_000n;

/** Default application-account funding for box minimum-balance requirements. */
export const DEFAULT_APP_FUNDING_MICROALGOS = 2_000_000n;

/** Bounded confirmation window; TestNet is slower than LocalNet but not unbounded. */
export const TESTNET_CONFIRMATION_ROUNDS = 20;

/** Zero-value demonstration settlement asset parameters. */
export const DEMO_ASSET_UNIT_NAME = "ANCHUSD";
export const DEMO_ASSET_TOTAL = 10_000_000_000n;
export const DEMO_ASSET_DECIMALS = 0;

/** Public explorer used for human verification of TestNet references. */
export const TESTNET_EXPLORER_BASE = "https://lora.algokit.io/testnet";

export function explorerTransactionUrl(transactionId: string): string {
  return `${TESTNET_EXPLORER_BASE}/transaction/${transactionId}`;
}

export function explorerApplicationUrl(applicationId: string | bigint): string {
  return `${TESTNET_EXPLORER_BASE}/application/${applicationId}`;
}

export function explorerAssetUrl(assetId: string | bigint): string {
  return `${TESTNET_EXPLORER_BASE}/asset/${assetId}`;
}

export function explorerAccountUrl(address: string): string {
  return `${TESTNET_EXPLORER_BASE}/account/${address}`;
}
