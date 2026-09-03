import type { MoneyDto } from '@optiwork/contracts';

export interface ScaledRate {
  readonly units: bigint;
  readonly scale: number;
}

function powerOfTen(scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0 || scale > 18) {
    throw new RangeError('scale must be an integer between 0 and 18');
  }
  return 10n ** BigInt(scale);
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    throw new RangeError('money conversion accepts non-negative values only');
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

export function convertMoney(
  source: MoneyDto,
  targetCurrency: string,
  targetScale: number,
  rate: ScaledRate,
): MoneyDto {
  if (!/^[A-Z]{3}$/.test(targetCurrency)) {
    throw new TypeError('target currency must be an ISO-style uppercase code');
  }
  if (rate.units <= 0n) {
    throw new RangeError('FX rate must be positive');
  }

  const sourceMinor = BigInt(source.amountMinor);
  const numerator = sourceMinor * rate.units * powerOfTen(targetScale);
  const denominator = powerOfTen(source.scale) * powerOfTen(rate.scale);

  return {
    amountMinor: roundHalfUp(numerator, denominator).toString(),
    currency: targetCurrency,
    scale: targetScale,
  };
}

export function addMoney(left: MoneyDto, right: MoneyDto): MoneyDto {
  if (left.currency !== right.currency || left.scale !== right.scale) {
    throw new TypeError('money operands must use the same currency and scale');
  }
  return {
    amountMinor: (BigInt(left.amountMinor) + BigInt(right.amountMinor)).toString(),
    currency: left.currency,
    scale: left.scale,
  };
}
