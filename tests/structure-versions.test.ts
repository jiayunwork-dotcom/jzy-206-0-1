import { describe, expect, it } from 'vitest';
import { createTestServices, expectClose } from './helpers.js';
import type { ReliabilityBlock } from '../src/core/types.js';

const device = (id: string): ReliabilityBlock => ({ type: 'device', deviceId: id });

describe('structure versions across a window', () => {
  it('segments at an effective-time change and time-weights the result', async () => {
    const services = await createTestServices();
    const devices = await Promise.all(['a', 'b', 'c'].map(async (code) => {
      const category = await services.catalog.createCategory({ name: `c-${code}`, plannedIsDowntime: false });
      return services.catalog.createDevice({ code, name: code, categoryId: category.id });
    }));
    const [a, b, c] = devices;
    const start = new Date(0).toISOString();
    const end = new Date(10_000 * 3_600_000).toISOString();
    const change = new Date(5_000 * 3_600_000).toISOString();
    for (const item of devices) {
      const batch = [];
      for (let cycle = 0; cycle < 10; cycle += 1) {
        batch.push(
          { eventId: `${item.code}-f-${cycle}`, deviceId: item.id, occurredAt: new Date((cycle * 1000 + 900) * 3_600_000).toISOString(), recordedAt: start, type: 'FAULT' },
          { eventId: `${item.code}-r-${cycle}`, deviceId: item.id, occurredAt: new Date((cycle + 1) * 1000 * 3_600_000).toISOString(), recordedAt: start, type: 'REPAIR_END' },
        );
      }
      await services.events.submitBatch(batch);
    }
    await services.structures.createVersion('line', {
      version: 'v1',
      validFrom: start,
      recordedAt: start,
      root: { type: 'series', children: [device(a.id), device(b.id)] },
    });
    await services.structures.createVersion('line', {
      version: 'v2',
      validFrom: change,
      recordedAt: start,
      root: { type: 'k_of_n', k: 2, children: [device(a.id), device(b.id), device(c.id)] },
    });
    const stats = await services.statistics.forAll(start, end);
    const result = await services.structures.systemAvailability(
      'line',
      start,
      end,
      stats,
    );
    expect(result.segments.map((segment) => segment.version)).toEqual(['v1', 'v2']);
    expectClose(result.availability, 0.5 * 0.81 + 0.5 * 0.972);
  });

  it('models pumps in parallel followed by a dosing system in series', async () => {
    const services = await createTestServices();
    const devices = await Promise.all(['p1', 'p2', 'p3', 'dose'].map(async (code) => {
      const category = await services.catalog.createCategory({ name: `line-${code}`, plannedIsDowntime: false });
      return services.catalog.createDevice({ code, name: code, categoryId: category.id });
    }));
    const [p1, p2, p3, dose] = devices;
    const start = new Date(0).toISOString();
    const end = new Date(10_000 * 3_600_000).toISOString();
    for (const item of devices) {
      const batch = [];
      for (let cycle = 0; cycle < 10; cycle += 1) {
        batch.push(
          { eventId: `${item.code}-f-${cycle}`, deviceId: item.id, occurredAt: new Date((cycle * 1000 + 900) * 3_600_000).toISOString(), recordedAt: start, type: 'FAULT' },
          { eventId: `${item.code}-r-${cycle}`, deviceId: item.id, occurredAt: new Date((cycle + 1) * 1000 * 3_600_000).toISOString(), recordedAt: start, type: 'REPAIR_END' },
        );
      }
      await services.events.submitBatch(batch);
    }
    await services.structures.createVersion('water-line', {
      version: 'v1',
      validFrom: start,
      recordedAt: start,
      root: { type: 'series', children: [
        { type: 'parallel', children: [device(p1.id), device(p2.id), device(p3.id)] },
        device(dose.id),
      ] },
    });
    const stats = await services.statistics.forAll(start, end);
    const result = await services.structures.systemAvailability('water-line', start, end, stats);
    expectClose(result.availability, (1 - 0.1 ** 3) * 0.9);
  });
});
