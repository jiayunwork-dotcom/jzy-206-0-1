import { describe, expect, it } from 'vitest';
import { evaluateRbd } from '../src/rbd.js';
import type { RbdNode } from '../src/types.js';
import { equipmentNode } from './helpers.js';

const a = equipmentNode('a');
const b = equipmentNode('b');
const c = equipmentNode('c');
const map = new Map([
  ['a', 0.9],
  ['b', 0.9],
  ['c', 0.9]
]);

describe('reliability block diagrams', () => {
  it('matches the 2-of-3 reference value', () => {
    expect(
      evaluateRbd(
        { type: 'k_of_n', k: 2, n: 3, children: [a, b, c] },
        map
      )
    ).toBeCloseTo(0.972);
  });

  it('multiplies availability for two series components', () => {
    expect(evaluateRbd({ type: 'series', children: [a, b] }, map)).toBeCloseTo(0.81);
  });

  it('subtracts unavailability powers for two parallel components', () => {
    expect(evaluateRbd({ type: 'parallel', children: [a, b] }, map)).toBeCloseTo(0.99);
  });

  it('satisfies series and parallel power identities for n equal components', () => {
    const nodes = [a, b, c];
    expect(evaluateRbd({ type: 'series', children: nodes }, map)).toBeCloseTo(0.9 ** 3);
    expect(evaluateRbd({ type: 'parallel', children: nodes }, map)).toBeCloseTo(1 - 0.1 ** 3);
  });

  it('is invariant when parallel branches are interchanged', () => {
    const branchX = { type: 'series' as const, children: [a, b] };
    const branchY = { type: 'series' as const, children: [c] };
    const one = evaluateRbd({ type: 'parallel', children: [branchX, branchY] }, map);
    const two = evaluateRbd({ type: 'parallel', children: [branchY, branchX] }, map);
    expect(one).toBeCloseTo(two);
  });

  it('always returns a probability between zero and one', () => {
    const nested: RbdNode = {
      type: 'series',
      children: [
        { type: 'parallel', children: [a, b] },
        { type: 'k_of_n', k: 2, n: 2, children: [c, a] }
      ]
    };
    const value = evaluateRbd(nested, map);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
  });
});
