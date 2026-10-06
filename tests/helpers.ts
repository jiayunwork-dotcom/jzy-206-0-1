import { expect } from 'vitest';
import { InMemoryRepository } from '../src/storage/repository.js';
import { createServices, type Services } from '../src/container.js';
import type { AnyEventInput, Category, Device } from '../src/core/types.js';

export const MS = 3_600_000;

export function iso(base: Date | string, hourOffset = 0): string {
  const time = new Date(base).getTime() + hourOffset * MS;
  return new Date(time).toISOString();
}

export async function setupDevice(
  services: Services,
  plannedIsDowntime = false,
): Promise<{ category: Category; device: Device }> {
  const category = await services.catalog.createCategory({
    name: `pump-${Math.random()}`,
    plannedIsDowntime,
  });
  const device = await services.catalog.createDevice({
    code: `P-${Math.random().toString(36).slice(2)}`,
    name: 'Pump',
    categoryId: category.id,
  });
  return { category, device };
}

export async function submitEvents(services: Services, events: AnyEventInput[]) {
  return services.events.submitBatch(events);
}

export function event(
  id: string,
  deviceId: string,
  hour: number,
  type: AnyEventInput['type'],
  base: Date | string,
  recordedAt?: string,
): AnyEventInput {
  return {
    eventId: id,
    deviceId,
    type: type as Exclude<AnyEventInput['type'], 'VOID'>,
    occurredAt: iso(base, hour),
    recordedAt: recordedAt ?? iso(base, hour + 1),
  } as AnyEventInput;
}

export async function createTestServices(): Promise<Services> {
  return createServices(new InMemoryRepository());
}

export function expectClose(actual: number | null, expected: number, epsilon = 1e-9) {
  expect(actual).not.toBeNull();
  expect(Math.abs((actual ?? 0) - expected)).toBeLessThan(epsilon);
}
