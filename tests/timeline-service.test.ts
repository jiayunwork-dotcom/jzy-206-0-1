import { describe, expect, it } from 'vitest';
import { H, createPump, event, makeService } from './helpers.js';

describe('timeline event semantics', () => {
  it('rebuilds identically whether events arrive late, duplicated, or in time order', async () => {
    const ordered = makeService();
    const shuffled = makeService();
    await createPump(ordered, 'pump');
    await createPump(shuffled, 'pump');

    const inputs = [
      event('f1', 'pump', 10 * H, 'failure', 11 * H),
      event('rs1', 'pump', 11 * H, 'repair_start', 12 * H),
      event('re1', 'pump', 12 * H, 'repair_end', 13 * H)
    ];
    for (const item of inputs) await ordered.submitEvent(item);

    const late = [inputs[2]!, inputs[0]!, inputs[1]!, inputs[0]!];
    const lateResults = await Promise.all(late.map((item) => shuffled.submitEvent(item)));
    expect(lateResults.map((item) => item.duplicate)).toEqual([false, false, false, true]);

    const [orderedTimeline, lateTimeline] = await Promise.all([
      ordered.getTimeline('pump'),
      shuffled.getTimeline('pump')
    ]);
    expect(lateTimeline).toEqual(orderedTimeline);
  });

  it('restores equipment to fully running after every event is voided', async () => {
    const service = makeService();
    await createPump(service, 'pump');
    await service.submitEvent(event('f1', 'pump', 10 * H, 'failure', 11 * H));
    await service.submitEvent(event('v1', 'pump', 11 * H, 'void_event', 12 * H, 'f1'));

    const timeline = await service.getTimeline('pump');
    expect(timeline.intervals).toEqual([]);
    const stats = await service.getWindowStatistics({
      equipmentId: 'pump',
      windowStart: 0,
      windowEnd: 20 * H
    });
    expect(stats.steadyStateAvailability).toBe(1);
    expect(stats.failureCount).toBe(0);
  });

  it('does not silently repair contradictions and ignores the contradictory events', async () => {
    const service = makeService();
    await createPump(service, 'pump');
    await service.submitEvent(event('f1', 'pump', 10 * H, 'failure', 11 * H));
    await service.submitEvent(event('f2', 'pump', 11 * H, 'failure', 12 * H));
    await service.submitEvent(event('re-bad', 'pump', 12 * H, 'repair_end', 13 * H));

    const timeline = await service.getTimeline('pump');
    expect(timeline.contradictions.map((item) => item.code)).toEqual([
      'failure_already_failed',
      'repair_end_without_repair'
    ]);
    expect(timeline.ignoredEventIds).toEqual(['f2', 're-bad']);
    expect(timeline.intervals.at(-1)?.state).toBe('waiting_repair');
  });

  it('is invariant under a whole-stream time translation', async () => {
    const service = makeService();
    await createPump(service, 'pump');
    const shift = 123_456 * H;
    for (const item of [
      event('f1', 'pump', 10 * H, 'failure', 11 * H),
      event('rs1', 'pump', 11 * H, 'repair_start', 12 * H),
      event('re1', 'pump', 12 * H, 'repair_end', 13 * H)
    ]) {
      await service.submitEvent({ ...item, time: item.time + shift, recordedAt: item.recordedAt! + shift });
    }
    const stats = await service.getWindowStatistics({
      equipmentId: 'pump',
      windowStart: shift,
      windowEnd: shift + 20 * H
    });
    expect(stats.mtbfHours).toBeCloseTo(18);
    expect(stats.mttrHours).toBeCloseTo(1);
    expect(stats.steadyStateAvailability).toBeCloseTo(0.9);
  });
});
