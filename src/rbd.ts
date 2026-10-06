import { invalidRequest } from './errors.js';
import { collectRbdEquipmentIds, findRbdDuplicateEquipment, validateRbdShape } from './validation.js';
import type { RbdNode } from './types.js';

export function validateRbd(node: unknown, existingEquipmentIds: ReadonlySet<string>): RbdNode {
  validateRbdShape(node);
  const duplicate = findRbdDuplicateEquipment(node);
  if (duplicate) {
    throw invalidRequest(`Equipment ${duplicate} appears more than once in the same structure`);
  }
  const referenced = collectRbdEquipmentIds(node);
  for (const equipmentId of referenced) {
    if (!existingEquipmentIds.has(equipmentId)) {
      throw invalidRequest(`RBD references non-existent equipment ${equipmentId}`);
    }
  }
  return node;
}

function probabilityAtLeastK(availabilities: number[], k: number): number {
  // DP[j] is the probability that exactly j independent children are available.
  let dp = [1];
  for (const available of availabilities) {
    const next = new Array<number>(dp.length + 1).fill(0);
    for (let j = 0; j < dp.length; j += 1) {
      next[j]! += dp[j]! * (1 - available);
      next[j + 1]! += dp[j]! * available;
    }
    dp = next;
  }
  let result = 0;
  for (let j = k; j < dp.length; j += 1) result += dp[j]!;
  return result;
}

/**
 * Availability under statistically independent equipment states.
 * series = product; parallel = 1 - product(unavailability);
 * k-of-n uses the exact subset probability distribution.
 */
export function evaluateRbd(node: RbdNode, availabilityById: ReadonlyMap<string, number>): number {
  if (node.type === 'equipment') {
    const value = availabilityById.get(node.equipmentId);
    if (value === undefined || !Number.isFinite(value)) {
      throw invalidRequest(`Missing availability for equipment ${node.equipmentId}`);
    }
    if (value < 0 || value > 1) {
      throw invalidRequest(`Availability for equipment ${node.equipmentId} must be between 0 and 1`);
    }
    return value;
  }

  const children = node.children.map((child) => evaluateRbd(child, availabilityById));

  if (node.type === 'series') {
    return children.reduce((product, value) => product * value, 1);
  }

  if (node.type === 'parallel') {
    return 1 - children.reduce((product, value) => product * (1 - value), 1);
  }

  return probabilityAtLeastK(children, node.k);
}

export function requiredEquipmentIds(node: RbdNode): Set<string> {
  return collectRbdEquipmentIds(node);
}
