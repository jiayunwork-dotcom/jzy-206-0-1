import { describe, expect, it } from 'vitest';
import { createTestServices, event, iso, setupDevice, submitEvents } from './helpers.js';

describe('timeline contradictions', () => {
  it('lists duplicate fault and out-of-order repair end with deterministic actions', async () => {
    const services = await createTestServices();
    const { device } = await setupDevice(services);
    await submitEvents(services, [
      event('f1', device.id, 10, 'FAULT', 0),
      event('f2', device.id, 20, 'FAULT', 0),
      event('bad-end', device.id, 30, 'REPAIR_END', 0),
    ]);
    const result = await services.timeline.getTimeline(device.id, {
      start: new Date(0).toISOString(),
      end: iso(0, 40),
    });
    expect(result.contradictions.map((item) => item.code)).toEqual([
      'FAULT_WHILE_DOWN',
    ]);
    // REPAIR_END in WAITING_REPAIR is accepted as a no-wait fault closure.
    expect(result.segments.at(-1)?.state).toBe('UP');
    expect(result.contradictions[0].action).toMatch(/Ignore/);
  });

  it('reports repair end before repair start as unmatched when running', async () => {
    const services = await createTestServices();
    const { device } = await setupDevice(services);
    await submitEvents(services, [event('end', device.id, 10, 'REPAIR_END', 0)]);
    const result = await services.timeline.getTimeline(device.id, {
      start: new Date(0).toISOString(),
      end: iso(0, 20),
    });
    expect(result.contradictions.map((item) => item.code)).toEqual(['REPAIR_END_WITHOUT_REPAIR']);
    expect(result.segments.every((segment) => segment.state === 'UP')).toBe(true);
  });
});
