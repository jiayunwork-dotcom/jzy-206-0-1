import { describe, expect, it } from 'vitest';
import { deriveTimeline } from '../src/timeline.js';
import { calculateWindowStatistics } from '../src/statistics.js';
import { H, effectiveEvent, event } from './helpers.js';

describe('reference statistics', () => {
  it('produces MTBF 900h, MTTR 100h, and availability 0.9 for one complete cycle', () => {
    const start = 0;
    const end = 1000 * H;
    const inputs = [
      event('f1', 'eq', 900 * H, 'failure', 901 * H),
      event('rs1', 'eq', 900 * H, 'repair_start', 902 * H),
      event('re1', 'eq', 1000 * H, 'repair_end', 1001 * H)
    ];
    const events = inputs.map(effectiveEvent);
    const timeline = deriveTimeline('eq', events);
    const stats = calculateWindowStatistics({
      equipmentId: 'eq',
      timeline,
      events,
      windowStart: start,
      windowEnd: end,
      plannedMaintenanceAsDowntime: true
    });
    expect(stats.mtbfHours).toBeCloseTo(900);
    expect(stats.mttrHours).toBeCloseTo(100);
    expect(stats.steadyStateAvailability).toBeCloseTo(0.9);
  });
});
