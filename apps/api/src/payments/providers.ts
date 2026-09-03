/**
 * Provider treasuries.
 *
 * Only providers touch Algorand. Each corridor book has exactly two treasuries:
 * the origin provider that funds the escrow after debiting the buyer's
 * simulated fiat book, and the destination provider that receives the release
 * before crediting the beneficiary's simulated fiat book. Companies,
 * freelancers and suppliers never appear here and never hold a key.
 *
 * The India to United Kingdom outward journey deliberately uses *different*
 * treasuries from the Poland to India inward journey, so the two books cannot
 * share a settlement account even by accident.
 */

import { createHash } from 'node:crypto';

export interface ProviderTreasury {
  readonly id: string;
  readonly label: string;
  readonly country: string;
  readonly capabilities: readonly string[];
  readonly address: string;
}

export interface CorridorProviders {
  readonly bookId: string;
  readonly origin: ProviderTreasury;
  readonly destination: ProviderTreasury;
}

/**
 * Derives a checksummed Algorand address from a stable label.
 *
 * No private key exists for these addresses: they exist so the demo carries a
 * structurally real address rather than a placeholder. Any deployment that
 * settles for real overrides them with governed treasury addresses from the
 * environment.
 */
export function deterministicAddress(label: string): string {
  const publicKey = createHash('sha256').update(`optiwork-provider:${label}`, 'utf8').digest();
  const checksum = createHash('sha512-256').update(publicKey).digest().subarray(28, 32);
  return base32(Buffer.concat([publicKey, checksum]));
}

function base32(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output.slice(0, 58);
}

function treasury(id: string, label: string, country: string, capabilities: readonly string[], override?: string): ProviderTreasury {
  return { id, label, country, capabilities, address: override ?? deterministicAddress(id) };
}

export interface ProviderOverrides {
  readonly originAddress?: string;
  readonly destinationAddress?: string;
}

/**
 * The registry is keyed by book, not by country pair, because direction changes
 * which licensed capability a provider must hold.
 */
export function providersForBook(bookId: string, overrides: ProviderOverrides = {}): CorridorProviders {
  switch (bookId) {
    case 'PL-IN-INWARD':
      return {
        bookId,
        origin: treasury('PROVIDER-EU-ORIGIN', 'EU origin provider (simulated)', 'PL', ['EU_ORIGIN_FX'], overrides.originAddress),
        destination: treasury('PROVIDER-IN-INWARD', 'India inward collection provider (simulated)', 'IN', ['INDIA_PA_CB_INWARD'], overrides.destinationAddress),
      };
    case 'IN-GB-OUTWARD':
      return {
        bookId,
        origin: treasury('PROVIDER-IN-OUTWARD', 'India outward remittance provider (simulated)', 'IN', ['INDIA_PA_CB_OUTWARD'], overrides.originAddress),
        destination: treasury('PROVIDER-GB-OFFRAMP', 'United Kingdom destination off-ramp (simulated)', 'GB', ['UK_DESTINATION_OFFRAMP'], overrides.destinationAddress),
      };
    default:
      throw new Error(`No provider treasuries are configured for book ${bookId}.`);
  }
}

export function providerCapabilitiesSatisfied(
  providers: CorridorProviders,
  required: readonly string[],
): { satisfied: boolean; missing: string[] } {
  const available = new Set([...providers.origin.capabilities, ...providers.destination.capabilities]);
  const missing = required.filter((capability) => !available.has(capability));
  return { satisfied: missing.length === 0, missing };
}
