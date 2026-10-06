import { describe, expect, it } from 'vitest';
import { createTestServices, event, iso, setupDevice, submitEvents } from './helpers.js';

describe('as-of recalculation and concurrency', () => {
  it('freezes the old report and lists events that changed it', async () => {
    const services = await createTestServices();
    const { device } = await setupDevice(services);
    const start = new Date(0).toISOString();
    const end = iso(0, 1000);
    await submitEvents(services, [
      event('f1', device.id, 900, 'FAULT', 0, iso(0, 950)),
      event('e1', device.id, 1000, 'REPAIR_END', 0, iso(0, 950)),
    ]);
    const reportDate = iso(0, 960);
    const old = await services.asOf.recalculateWindow(start, end, reportDate);
    expect(old[device.id].faultCount).toBe(1);

    await submitEvents(services, [
      event('late-fault', device.id, 100, 'FAULT', 0, iso(0, 1100)),
      event('late-end', device.id, 200, 'REPAIR_END', 0, iso(0, 1100)),
    ]);
    const current = await services.asOf.recalculateWindow(start, end, iso(0, 1200));
    expect(current[device.id].faultCount).toBe(2);

    const diff = await services.asOf.compare(start, end, reportDate, iso(0, 1200));
    expect(diff.changedEvents.map((item) => item.eventId).sort()).toEqual([
      'late-end',
      'late-fault',
    ]);
    expect(diff.eventChanges.map((item) => item.kind)).toEqual(['added', 'added']);
    expect(diff.baseline[device.id].faultCount).toBe(1);
    expect(diff.current[device.id].faultCount).toBe(2);
  });

  it('freezes an explicitly published report independently of later event backfill', async () => {
    const services = await createTestServices();
    const { device } = await setupDevice(services);
    const start = new Date(0).toISOString();
    const end = iso(0, 1000);
    const reportDate = iso(0, 950);
    await submitEvents(services, [
      event('f1', device.id, 900, 'FAULT', 0, reportDate),
      event('r1', device.id, 950, 'REPAIR_END', 0, reportDate),
    ]);
    const frozen = await services.statistics.forDevice(device.id, start, end, {
      asOf: reportDate,
      freeze: true,
    });
    expect(frozen.faultCount).toBe(1);

    await submitEvents(services, [
      event('f0', device.id, 100, 'FAULT', 0, iso(0, 1000)),
      event('r0', device.id, 200, 'REPAIR_END', 0, iso(0, 1000)),
    ]);
    const refrozen = await services.statistics.forDevice(device.id, start, end, {
      asOf: reportDate,
      freeze: true,
    });
    const current = await services.statistics.forDevice(device.id, start, end, {
      asOf: iso(0, 1100),
    });
    expect(refrozen.faultCount).toBe(1);
    expect(current.faultCount).toBe(2);
  });

  it('handles two crews submitting the same device concurrently as ordered event processing', async () => {
    const servicesA = await createTestServices();
    const { device } = await setupDevice(servicesA);
    const crew1 = servicesA.events.submit(event('fault', device.id, 10, 'FAULT', 0));
    const crew2 = servicesA.events.submit(event('start', device.id, 20, 'REPAIR_START', 0));
    const crew3 = servicesA.events.submit(event('fault', device.id, 10, 'FAULT', 0));
    const [, , duplicate] = await Promise.all([crew1, crew2, crew3]);
    expect(duplicate.duplicate).toBe(true);
    const timeline = await servicesA.timeline.getTimeline(device.id, {
      start: new Date(0).toISOString(),
      end: iso(0, 30),
    });
    expect(timeline.segments.map((segment) => segment.state)).toEqual(['UP', 'WAITING_REPAIR', 'REPAIR']);
  });
});
