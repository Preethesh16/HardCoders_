/**
 * Ordered corridor resolution.
 *
 * A corridor is an *ordered* pair: PL→IN and IN→PL are different corridors with
 * different directions, books and rules. Policies come from the shared domain
 * package so the API, the tests and the rules engine all read one versioned
 * source.
 */

import type { CorridorPolicy } from '@optiwork/contracts';
import { CorridorResolutionError, corridorPolicies, resolveCorridor } from '@optiwork/domain';
import { canonicalHash } from '../canonical.js';
import { badRequest, unprocessable } from '../errors.js';

export interface CorridorResolution {
  readonly policy: CorridorPolicy;
  readonly canonicalHash: string;
  readonly bookId: string;
}

const COUNTRY = /^[A-Z]{2}$/u;

/**
 * Books are keyed by corridor and direction. An INWARD book and an OUTWARD book
 * are separate ledgers even for the same pair of countries, which is what keeps
 * the India→UK supplier flow from ever netting against Poland→India.
 */
export function bookIdFor(policy: CorridorPolicy): string {
  return `${policy.originCountry}-${policy.destinationCountry}-${policy.direction}`;
}

export function listCorridors(): readonly CorridorPolicy[] {
  return corridorPolicies.map((policy) => structuredClone(policy));
}

export function resolve(originCountry: string, destinationCountry: string): CorridorResolution {
  if (!COUNTRY.test(originCountry) || !COUNTRY.test(destinationCountry)) {
    throw badRequest('Country codes must be ISO 3166-1 alpha-2 uppercase.');
  }
  if (originCountry === destinationCountry) {
    throw badRequest('A cross-border corridor needs two different countries.');
  }
  try {
    const policy = resolveCorridor(originCountry, destinationCountry);
    return { policy, canonicalHash: canonicalHash(policy), bookId: bookIdFor(policy) };
  } catch (error) {
    if (error instanceof CorridorResolutionError) {
      throw unprocessable(error.message, { code: error.code, originCountry, destinationCountry });
    }
    throw error;
  }
}
