import { badRequest } from './errors.js';
import type { ReliabilityBlock } from './types.js';

export function validateBlock(
  block: ReliabilityBlock,
  knownDeviceIds: ReadonlySet<string>,
  seen = new Set<string>(),
): void {
  if (!block || typeof block !== 'object') throw badRequest('Invalid reliability block');

  if (block.type === 'device') {
    if (!block.deviceId) throw badRequest('Device block must reference a device');
    if (!knownDeviceIds.has(block.deviceId)) {
      throw badRequest(`Block references unknown device ${block.deviceId}`);
    }
    if (seen.has(block.deviceId)) {
      throw badRequest(`Device ${block.deviceId} appears more than once in one structure`);
    }
    seen.add(block.deviceId);
    return;
  }

  if (!['series', 'parallel', 'k_of_n'].includes(block.type)) {
    throw badRequest(`Unknown block type ${String((block as { type: unknown }).type)}`);
  }
  if (!Array.isArray(block.children) || block.children.length === 0) {
    throw badRequest(`${block.type} must contain children`);
  }
  if (block.type === 'k_of_n') {
    const { k } = block;
    const n = block.children.length;
    if (!Number.isInteger(k) || (k as number) <= 0) {
      throw badRequest('k-of-n requires k to be a positive integer');
    }
    if ((k as number) > n) throw badRequest('k-of-n requires k <= n');
  }
  for (const child of block.children) validateBlock(child, knownDeviceIds, seen);
}

export function evaluateBlock(
  block: ReliabilityBlock,
  availabilityByDevice: Readonly<Record<string, number>>,
): number {
  if (block.type === 'device') {
    const value = availabilityByDevice[block.deviceId];
    if (value === undefined || Number.isNaN(value)) {
      throw new Error(`Missing availability for device ${block.deviceId}`);
    }
    if (value < 0 || value > 1) {
      throw new Error(`Availability of ${block.deviceId} is outside [0,1]`);
    }
    return value;
  }

  const values = block.children.map((child) => evaluateBlock(child, availabilityByDevice));
  if (block.type === 'series') {
    return Math.min(1, Math.max(0, values.reduce((a, b) => a * b, 1)));
  }
  if (block.type === 'parallel') {
    const unavailability = values.reduce((product, value) => product * (1 - value), 1);
    return Math.min(1, Math.max(0, 1 - unavailability));
  }

  const k = block.k!;
  let probability = 0;
  for (let mask = 0; mask < 2 ** values.length; mask += 1) {
    let workingCount = 0;
    let probabilityOfOutcome = 1;
    values.forEach((value, index) => {
      if ((mask & (1 << index)) !== 0) {
        workingCount += 1;
        probabilityOfOutcome *= value;
      } else {
        probabilityOfOutcome *= 1 - value;
      }
    });
    if (workingCount >= k) probability += probabilityOfOutcome;
  }
  return Math.min(1, Math.max(0, probability));
}

export function kOfNAvailability(n: number, k: number, availability: number): number {
  if (!Number.isInteger(k) || k <= 0) throw new Error('k must be a positive integer');
  if (k > n) throw new Error('k must not exceed n');
  let result = 0;
  for (let successes = k; successes <= n; successes += 1) {
    let coefficient = 1;
    for (let i = 0; i < successes; i += 1) {
      coefficient *= (n - i) / (i + 1);
    }
    result +=
      coefficient * availability ** successes * (1 - availability) ** (n - successes);
  }
  return Math.min(1, Math.max(0, result));
}
