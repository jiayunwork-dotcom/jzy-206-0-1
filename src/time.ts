export const HOUR_MS = 3_600_000;

export const hours = (ms: number): number => ms / HOUR_MS;

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
