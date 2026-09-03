import { describe, expect, it } from 'vitest';
import { assertTransition, canTransition } from '../src/index.js';

describe('work contract state machine', () => {
  it('allows the authorized happy-path release sequence', () => {
    expect(canTransition('COMPANY_APPROVED', 'RELEASE_AUTHORIZED')).toBe(true);
    expect(canTransition('RELEASE_AUTHORIZED', 'ESCROW_RELEASED')).toBe(true);
  });

  it('does not allow validation to skip human approval', () => {
    expect(canTransition('VALIDATION_RECORDED', 'ESCROW_RELEASED')).toBe(false);
    expect(() => assertTransition('VALIDATION_RECORDED', 'ESCROW_RELEASED')).toThrow(
      'invalid work contract transition',
    );
  });
});
