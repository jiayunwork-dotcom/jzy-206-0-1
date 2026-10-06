import { describe, expect, it } from 'vitest';
import { H, createDb, createPump, event, makeService } from './helpers.js';
import { AvailabilityService } from '../src/service.js';
import {
  InMemoryEquipmentRepository,
  InMemoryEventRepository,
  InMemoryStructureRepository
} from '../src/repositories/memory.js';

describe('point-in-time reconstruction and restart', () => {
  it('reproduces the old report and lists later effective-event changes', async () => {
    const service = makeService();
    await createPump(service, 'pump');
    const reportTime = 100 * H;
    await service.submitEvent(event('f1', 'pump', 10 * H, 'failure', 20 * H));
    await service.submitEvent(event('rs1', 'pump', 10 * H, 'repair_start', 30 * H));
    await service.submitEvent(event('re1', 'pump', 12 * H, 'repair_end', 40 * H));

    const oldResult = await service.getWindowStatistics({
      equipmentId: 'pump',
      windowStart: 0,
      windowEnd: 50 * H,
      asOf: reportTime
    });

    // Later: a correction moves the repair end, and a late event arrives.
    await service.correctEvent('re1', { time: 15 * H }, 120 * H);
    await service.submitEvent(event('f-late', 'pump', 20 * H, 'failure', 130 * H));

    const comparison = await service.compareWindowAt({
      equipmentId: 'pump',
      windowStart: 0,
      windowEnd: 50 * H,
      earlierAsOf: reportTime
    });

    expect(comparison.earlier).toEqual(oldResult);
    expect(comparison.current.steadyStateAvailability).not.toBeCloseTo(
      oldResult.steadyStateAvailability!
    );
    expect(comparison.effectiveEventDifference.added.map((item) => item.eventId)).toEqual(['f-late']);
    expect(comparison.effectiveEventDifference.changed.map((item) => item.to.eventId)).toEqual(['re1']);
    expect(comparison.effectiveEventDifference.changed[0]!.from.time).toBe(12 * H);
    expect(comparison.effectiveEventDifference.changed[0]!.to.time).toBe(15 * H);

    const oldAgain = await service.getWindowStatistics({
      equipmentId: 'pump',
      windowStart: 0,
      windowEnd: 50 * H,
      asOf: reportTime
    });
    expect(oldAgain).toEqual(oldResult);
  });

  it('recovers all state by constructing a new service over the same store', async () => {
    const db = createDb();
    const service = new AvailabilityService(
      new InMemoryEventRepository(db),
      new InMemoryEquipmentRepository(db),
      new InMemoryStructureRepository(db),
      () => 10_000_000_000_000
    );
    await createPump(service, 'pump');
    await service.submitEvent(event('f1', 'pump', 10 * H, 'failure', 11 * H));

    const restarted = new AvailabilityService(
      new InMemoryEventRepository(db),
      new InMemoryEquipmentRepository(db),
      new InMemoryStructureRepository(db),
      () => 10_000_000_000_000
    );
    const timeline = await restarted.getTimeline('pump');
    expect(timeline.intervals.at(-1)?.state).toBe('waiting_repair');
    expect(await restarted.listEquipment()).toHaveLength(1);
  });

  it('serializes concurrent submissions and keeps replay semantics', async () => {
    const service = makeService();
    await createPump(service, 'pump');
    const inputs = [
      event('f1', 'pump', 10 * H, 'failure', 10 * H),
      event('rs1', 'pump', 11 * H, 'repair_start', 11 * H),
      event('re1', 'pump', 12 * H, 'repair_end', 12 * H),
      event('p1', 'pump', 20 * H, 'planned_start', 20 * H),
      event('p2', 'pump', 21 * H, 'planned_end', 21 * H)
    ];
    await Promise.all(inputs.map((input) => service.submitEvent(input)));
    const timeline = await service.getTimeline('pump');
    expect(timeline.contradictions).toEqual([]);
    expect(timeline.intervals.map((item) => item.state)).toEqual([
      'running',
      'waiting_repair',
      'under_repair',
      'running',
      'planned_maintenance',
      'running'
    ]);
  });
});
