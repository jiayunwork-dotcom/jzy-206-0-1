import { describe, expect, it } from 'vitest';
import { createTestServices, event, expectClose, iso, setupDevice, submitEvents } from './helpers.js';
import { calculateWindowStatistics } from '../src/core/statistics.js';
import type { StoredEvent } from '../src/core/types.js';

describe('window statistics', () => {
  it('produces reference MTBF, MTTR and steady-state availability', async () => {
    const services = await createTestServices();
    const { device } = await setupDevice(services);
    const start = new Date('2026-01-01T00:00:00.000Z');
    const end = iso(start, 1000);
    await submitEvents(services, [
      event('f1', device.id, 900, 'FAULT', start),
      event('r1', device.id, 1000, 'REPAIR_END', start),
    ]);
    const stats = await services.statistics.forDevice(device.id, start.toISOString(), end);
    expectClose(stats.mtbf, 900);
    expectClose(stats.mttr, 100);
    expectClose(stats.steadyStateAvailability, 0.9);
    expectClose(stats.observedAvailability, 0.9);
  });

  it('treats right-censored exposure as TTT exposure rather than dropping it', async () => {
    const events: StoredEvent[] = [
      { eventId: 'f1', deviceId: 'd', occurredAt: iso(0, 100), recordedAt: iso(0, 100), type: 'FAULT', targetEventId: null },
      { eventId: 'e1', deviceId: 'd', occurredAt: iso(0, 200), recordedAt: iso(0, 200), type: 'REPAIR_END', targetEventId: null },
      { eventId: 'f2', deviceId: 'd', occurredAt: iso(0, 600), recordedAt: iso(0, 600), type: 'FAULT', targetEventId: null },
    ];
    const windowStart = new Date(0).toISOString();
    const windowEnd = iso(0, 1000);
    const censored = calculateWindowStatistics({
      deviceId: 'd', events, windowStart, windowEnd, plannedIsDowntime: false, method: 'right_censored',
    });
    const dropped = calculateWindowStatistics({
      deviceId: 'd', events, windowStart, windowEnd, plannedIsDowntime: false, method: 'drop',
    });
    expectClose(censored.mtbf, 250); // (100 + 400) / 2 failures
    expectClose(censored.mttr, 250); // (100 completed + 400 observed open) / 2 incidents
    expectClose(dropped.mtbf, 400); // only complete 400h UP interval / one complete interval
    expectClose(dropped.mttr, 100); // only the fully closed repair interval
    expect(censored.mtbf).not.toEqual(dropped.mtbf);
  });

  it('is invariant under translation of the whole event stream', () => {
    const make = (offsetHours: number): StoredEvent[] => [
      { eventId: 'f1', deviceId: 'd', occurredAt: iso(0, offsetHours + 100), recordedAt: iso(0, offsetHours + 100), type: 'FAULT', targetEventId: null },
      { eventId: 'e1', deviceId: 'd', occurredAt: iso(0, offsetHours + 200), recordedAt: iso(0, offsetHours + 200), type: 'REPAIR_END', targetEventId: null },
      { eventId: 'f2', deviceId: 'd', occurredAt: iso(0, offsetHours + 800), recordedAt: iso(0, offsetHours + 800), type: 'FAULT', targetEventId: null },
    ];
    const a = calculateWindowStatistics({
      deviceId: 'd', events: make(0), windowStart: new Date(0).toISOString(), windowEnd: iso(0, 1000), plannedIsDowntime: false,
    });
    const b = calculateWindowStatistics({
      deviceId: 'd', events: make(10_000), windowStart: iso(0, 10_000), windowEnd: iso(0, 11_000), plannedIsDowntime: false,
    });
    expect(b.mtbf).toEqual(a.mtbf);
    expect(b.mttr).toEqual(a.mttr);
    expect(b.observedAvailability).toEqual(a.observedAvailability);
  });

  it('returns all-window running when all events are voided', async () => {
    const services = await createTestServices();
    const { device } = await setupDevice(services);
    const start = new Date(0).toISOString();
    const end = iso(0, 100);
    await submitEvents(services, [
      event('f1', device.id, 10, 'FAULT', 0),
      { eventId: 'v1', targetEventId: 'f1', type: 'VOID', occurredAt: iso(0, 20), recordedAt: iso(0, 20) },
    ]);
    const stats = await services.statistics.forDevice(device.id, start, end);
    expectClose(stats.observedAvailability, 1);
    expect(stats.faultCount).toBe(0);
  });

  it('honors category configuration for planned maintenance downtime', async () => {
    const services = await createTestServices();
    const { device } = await setupDevice(services, true);
    const start = new Date(0).toISOString();
    const end = iso(0, 100);
    await submitEvents(services, [
      event('p1', device.id, 10, 'PLANNED_START', 0),
      event('p2', device.id, 20, 'PLANNED_END', 0),
    ]);
    const included = await services.statistics.forDevice(device.id, start, end);
    const excluded = await services.statistics.forDevice(device.id, start, end, {
      plannedIsDowntime: false,
    });
    expectClose(included.observedAvailability, 0.9);
    expectClose(excluded.observedAvailability, 1);
  });
});
