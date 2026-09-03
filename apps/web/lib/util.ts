import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * Formats an exact integer amount of minor units for display.
 *
 * The amount never becomes a JavaScript number: the decimal point is inserted
 * by string surgery, exactly as the API does it.
 */
export function formatMoney(amountMinor: string, currency: string, scale: number): string {
  const negative = amountMinor.startsWith('-');
  const digits = (negative ? amountMinor.slice(1) : amountMinor).padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale) || '0';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ' ');
  const fraction = scale === 0 ? '' : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? '-' : ''}${grouped}${fraction} ${currency}`;
}

export function formatRate(units: string, scale: number): string {
  const digits = units.padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale) || '0';
  return scale === 0 ? whole : `${whole}.${digits.slice(digits.length - scale)}`;
}

export function shortHash(value: string | null | undefined, length = 10): string {
  if (!value) return '—';
  const body = value.startsWith('sha256:') ? value.slice(7) : value;
  return body.length <= length * 2 ? body : `${body.slice(0, length)}…${body.slice(-4)}`;
}

export function formatInstant(value: string): string {
  return new Date(value).toISOString().replace('T', ' ').replace('.000Z', 'Z');
}

export function titleCase(value: string): string {
  return value.toLowerCase().split('_').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}
