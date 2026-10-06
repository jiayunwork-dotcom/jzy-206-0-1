import { describe, expect, it } from 'vitest';
import { H, createPump, equipmentNode, event, makeService } from './helpers.js';

describe('system availability and structure versions', () => {
  it('weights segments by duration across a structure change', async () => {
    const service = makeService();
    for (const id of ['p1', 'p2', 'p3']) await createPump(service, id, false);

    // All pumps are down [0,10h), then run for the rest of the 40h window.
    for (const id of ['p1', 'p2', 'p3']) {
      await service.submitEvent(event(`${id}-f`, id, 0, 'failure', 1));
      await service.submitEvent(event(`${id}-rs`, id, 0, 'repair_start', 2));
      await service.submitEvent(event(`${id}-re`, id, 10 * H, 'repair_end', 3));
    }

    await service.addStructureVersion({
      systemId: 'line',
      id: 'v1',
      effectiveFrom: null,
      root: { type: 'k_of_n', k: 2, n: 3, children: ['p1', 'p2', 'p3'].map(equipmentNode) },
      asOf: 100
    });
    await service.addStructureVersion({
      systemId: 'line',
      id: 'v2',
      effectiveFrom: 20 * H,
      root: { type: 'parallel', children: ['p1', 'p2', 'p3'].map(equipmentNode) },
      asOf: 101
    });

    const result = await service.getSystemAvailability({
      systemId: 'line',
      windowStart: 0,
      windowEnd: 40 * H,
      asOf: 1000
    });

    // First 10h all unavailable => 0; 10-20 all available => 1; 20-40 all available => 1.
    expect(result.availability).toBeCloseTo(0.75);
    expect(result.segments.map((item) => item.structureVersionId)).toEqual(['v1', 'v1', 'v2']);
    expect(result.segments.map((item) => item.availability)).toEqual([0, 1, 1]);
  });

  it('supports per-category planned-maintenance treatment', async () => {
    const down = makeService();
    const available = makeService();
    await createPump(down, 'd', true);
    await createPump(available, 'a', false);
    for (const [service, id] of [[down, 'd'], [available, 'a']] as const) {
      await service.submitEvent(event(`${id}-ps`, id, 5 * H, 'planned_start', 6 * H));
      await service.submitEvent(event(`${id}-pe`, id, 10 * H, 'planned_end', 7 * H));
    }
    const downStats = await down.getWindowStatistics({ equipmentId: 'd', windowStart: 0, windowEnd: 20 * H });
    const upStats = await available.getWindowStatistics({ equipmentId: 'a', windowStart: 0, windowEnd: 20 * H });
    expect(downStats.steadyStateAvailability).toBeCloseTo(0.75);
    expect(upStats.steadyStateAvailability).toBe(1);
  });
});
