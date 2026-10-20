import { describe, expect, it } from 'vitest';
import { TOTAL_BUDGET_MS, nextBackoff } from './retry.js';

describe('nextBackoff', () => {
  it('grows exponentially', () => {
    const noJitter = () => 0.5;
    const a = nextBackoff(1, noJitter);
    const b = nextBackoff(2, noJitter);
    const c = nextBackoff(3, noJitter);
    expect(a).not.toBeNull();
    expect(b as number).toBeGreaterThan(a as number);
    expect(c as number).toBeGreaterThan(b as number);
  });

  it('applies jitter so retries do not synchronize', () => {
    expect(nextBackoff(5, () => 0)).not.toBe(nextBackoff(5, () => 1));
  });

  it('never returns a negative or zero delay', () => {
    for (let i = 1; i < 30; i += 1) {
      const d = nextBackoff(i, () => 0);
      if (d !== null) expect(d, `attempt ${i}`).toBeGreaterThan(0);
    }
  });

  it('returns null for a nonsensical attempt number', () => {
    expect(nextBackoff(0)).toBeNull();
    expect(nextBackoff(-1)).toBeNull();
  });

  it('gives up well before an unbounded number of attempts', () => {
    expect(nextBackoff(400, () => 1)).toBeNull();
  });

  it('terminates with the cumulative spend inside the 24 h budget', () => {
    let total = 0;
    let attempts = 0;
    for (;;) {
      attempts += 1;
      const d = nextBackoff(attempts, () => 0.5);
      if (d === null) break;
      total += d;
      expect(attempts, 'must terminate well under 1000 attempts').toBeLessThan(1000);
    }
    expect(total).toBeLessThanOrEqual(TOTAL_BUDGET_MS);
  });

  it('caps a single delay at one hour', () => {
    for (let i = 1; i < 40; i += 1) {
      const d = nextBackoff(i, () => 1);
      if (d !== null) expect(d).toBeLessThanOrEqual(60 * 60 * 1000);
    }
  });
});
