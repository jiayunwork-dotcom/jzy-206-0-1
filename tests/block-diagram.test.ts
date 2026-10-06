import { describe, expect, it } from 'vitest';
import { evaluateBlock, kOfNAvailability, validateBlock } from '../src/core/block-diagram.js';
import type { ReliabilityBlock } from '../src/core/types.js';
import { expectClose } from './helpers.js';

const availability = { a: 0.9, b: 0.9, c: 0.9, x: 0.972 };

const series: ReliabilityBlock = { type: 'series', children: [
  { type: 'device', deviceId: 'a' },
  { type: 'device', deviceId: 'b' },
] };
const parallel: ReliabilityBlock = { type: 'parallel', children: [
  { type: 'device', deviceId: 'a' },
  { type: 'device', deviceId: 'b' },
] };
const twoOfThree: ReliabilityBlock = { type: 'k_of_n', k: 2, children: [
  { type: 'device', deviceId: 'a' },
  { type: 'device', deviceId: 'b' },
  { type: 'device', deviceId: 'c' },
] };

describe('reliability block diagrams', () => {
  it('matches reference series, parallel and 2-of-3 values', () => {
    expectClose(evaluateBlock(series, availability), 0.81);
    expectClose(evaluateBlock(parallel, availability), 0.99);
    expectClose(kOfNAvailability(3, 2, 0.9), 0.972);
    expectClose(evaluateBlock(twoOfThree, availability), 0.972);
  });

  it('satisfies n identical series and parallel formulas', () => {
    const devices = ['a', 'b', 'c', 'd'];
    const chain: ReliabilityBlock = {
      type: 'series',
      children: devices.map((deviceId) => ({ type: 'device', deviceId })),
    };
    const redundant: ReliabilityBlock = {
      type: 'parallel',
      children: devices.map((deviceId) => ({ type: 'device', deviceId })),
    };
    expectClose(evaluateBlock(chain, { a: 0.9, b: 0.9, c: 0.9, d: 0.9 }), 0.9 ** 4);
    expectClose(evaluateBlock(redundant, { a: 0.9, b: 0.9, c: 0.9, d: 0.9 }), 1 - 0.1 ** 4);
  });

  it('is unchanged when parallel branches are swapped', () => {
    const left: ReliabilityBlock = { type: 'parallel', children: [
      { type: 'series', children: [{ type: 'device', deviceId: 'a' }, { type: 'device', deviceId: 'b' }] },
      { type: 'device', deviceId: 'c' },
    ] };
    const right: ReliabilityBlock = { type: 'parallel', children: [
      { type: 'device', deviceId: 'c' },
      { type: 'series', children: [{ type: 'device', deviceId: 'a' }, { type: 'device', deviceId: 'b' }] },
    ] };
    expect(evaluateBlock(left, availability)).toEqual(evaluateBlock(right, availability));
  });

  it('evaluates nested diagrams and keeps availability bounded', () => {
    const values = { a: 0.9, b: 0.9, c: 0.9, d: 0.9, e: 0.9 };
    const nested: ReliabilityBlock = {
      type: 'series',
      children: [
        { type: 'parallel', children: [
          { type: 'device', deviceId: 'a' },
          { type: 'device', deviceId: 'b' },
        ] },
        { type: 'k_of_n', k: 2, children: [
          { type: 'device', deviceId: 'c' },
          { type: 'device', deviceId: 'd' },
          { type: 'device', deviceId: 'e' },
        ] },
      ],
    };
    const value = evaluateBlock(nested, values);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThanOrEqual(1);
    expectClose(value, 0.99 * 0.972);
  });

  it('rejects invalid k, unknown and duplicated devices', () => {
    const known = new Set(['a', 'b']);
    expect(() => validateBlock({ type: 'k_of_n', k: 3, children: [
      { type: 'device', deviceId: 'a' },
      { type: 'device', deviceId: 'b' },
    ] }, known)).toThrow('k <= n');
    expect(() => validateBlock({ type: 'k_of_n', k: 0, children: [{ type: 'device', deviceId: 'a' }] }, known)).toThrow();
    expect(() => validateBlock(series, new Set(['a']))).toThrow('unknown device');
    expect(() => validateBlock({ type: 'parallel', children: [
      { type: 'device', deviceId: 'a' },
      { type: 'device', deviceId: 'a' },
    ] }, known)).toThrow('more than once');
  });
});
