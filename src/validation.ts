import { invalidRequest } from './errors.js';
import { isFiniteNumber } from './time.js';
import type { EventInput, EventType, RbdNode } from './types.js';

export const EVENT_TYPES: ReadonlySet<EventType> = new Set([
  'failure',
  'repair_start',
  'repair_end',
  'planned_start',
  'planned_end',
  'void_event'
]);

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidRequest(`${field} must be a non-empty string`);
  }
  return value;
}

export function requireTimestamp(value: unknown, field: string): number {
  if (!isFiniteNumber(value) || !Number.isInteger(value)) {
    throw invalidRequest(`${field} must be an integer epoch millisecond timestamp`);
  }
  return value;
}

export function optionalTimestamp(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : requireTimestamp(value, field);
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalidRequest(`${field} must be boolean`);
  }
  return value;
}

export function validateWindow(windowStart: unknown, windowEnd: unknown): { start: number; end: number } {
  const start = requireTimestamp(windowStart, 'windowStart');
  const end = requireTimestamp(windowEnd, 'windowEnd');
  if (end <= start) {
    throw invalidRequest('windowEnd must be later than windowStart');
  }
  return { start, end };
}

export function normalizeEventInput(raw: unknown, fallbackRecordedAt: number): EventInput {
  if (typeof raw !== 'object' || raw === null) {
    throw invalidRequest('event must be an object');
  }
  const body = raw as Record<string, unknown>;
  const eventId = requireString(body.eventId, 'eventId');
  const equipmentId = requireString(body.equipmentId, 'equipmentId');
  const time = requireTimestamp(body.time, 'time');
  const type = body.type;
  if (typeof type !== 'string' || !EVENT_TYPES.has(type as EventType)) {
    throw invalidRequest(`unknown event type: ${String(type)}`);
  }
  const event: EventInput = {
    eventId,
    equipmentId,
    time,
    type: type as EventType,
    recordedAt: optionalTimestamp(body.recordedAt, 'recordedAt') ?? fallbackRecordedAt
  };
  if (type === 'void_event') {
    event.targetEventId = requireString(body.targetEventId, 'targetEventId');
  }
  return event;
}

export function normalizeEventBatch(raw: unknown, fallbackRecordedAt: number): EventInput[] {
  if (!Array.isArray(raw)) {
    throw invalidRequest('events must be an array');
  }
  return raw.map((event) => normalizeEventInput(event, fallbackRecordedAt));
}

/** Structural validation. Equipment existence is checked by the service with the repository. */
export function validateRbdShape(node: unknown): asserts node is RbdNode {
  if (typeof node !== 'object' || node === null) {
    throw invalidRequest('RBD node must be an object');
  }
  const value = node as Record<string, unknown>;
  if (value.type === 'equipment') {
    requireString(value.equipmentId, 'equipment node equipmentId');
    return;
  }
  if (value.type === 'series' || value.type === 'parallel') {
    if (!Array.isArray(value.children) || value.children.length === 0) {
      throw invalidRequest(`${value.type} node requires a non-empty children array`);
    }
    value.children.forEach(validateRbdShape);
    return;
  }
  if (value.type === 'k_of_n') {
    if (!Number.isInteger(value.k) || !Number.isInteger(value.n)) {
      throw invalidRequest('k_of_n requires integer k and n');
    }
    const k = value.k as number;
    const n = value.n as number;
    if (k <= 0) {
      throw invalidRequest('k_of_n k must be positive');
    }
    if (k > n) {
      throw invalidRequest('k_of_n k must not be greater than n');
    }
    if (n <= 0) {
      throw invalidRequest('k_of_n n must be positive');
    }
    if (!Array.isArray(value.children) || value.children.length !== n) {
      throw invalidRequest('k_of_n children count must equal n');
    }
    value.children.forEach(validateRbdShape);
    return;
  }
  throw invalidRequest(`unknown RBD node type: ${String(value.type)}`);
}

export function collectRbdEquipmentIds(node: RbdNode, output: Set<string> = new Set()): Set<string> {
  if (node.type === 'equipment') {
    output.add(node.equipmentId);
    return output;
  }
  node.children.forEach((child) => collectRbdEquipmentIds(child, output));
  return output;
}

export function findRbdDuplicateEquipment(node: RbdNode, trail: Set<string> = new Set()): string | null {
  if (node.type === 'equipment') {
    if (trail.has(node.equipmentId)) return node.equipmentId;
    trail.add(node.equipmentId);
    return null;
  }
  for (const child of node.children) {
    const duplicate = findRbdDuplicateEquipment(child, trail);
    if (duplicate) return duplicate;
  }
  return null;
}
