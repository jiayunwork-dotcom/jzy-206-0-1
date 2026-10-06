import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';
import { makeService } from './helpers.js';

const H = 3_600_000;

const json = async <T>(response: Response): Promise<T> => (await response.json()) as T;

describe('HTTP API', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const service = makeService();
    server = createApp(service).listen(0);
    await new Promise<void>((resolve) => server.on('listening', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP server');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it('maintains equipment, accepts events, and returns statistics', async () => {
    const category = await fetch(`${baseUrl}/categories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'pump-cat', name: 'Pump', plannedMaintenanceAsDowntime: true })
    }).then((response) => json<{ id: string }>(response));
    expect(category.id).toBe('pump-cat');

    const equipment = await fetch(`${baseUrl}/equipment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'p1', name: 'Pump 1', categoryId: 'pump-cat' })
    }).then((response) => json<{ id: string }>(response));
    expect(equipment.id).toBe('p1');

    const postEvent = async (event: unknown) =>
      fetch(`${baseUrl}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(event)
      });

    for (const event of [
      { eventId: 'f1', equipmentId: 'p1', time: 900 * H, type: 'failure', recordedAt: 901 * H },
      { eventId: 'rs1', equipmentId: 'p1', time: 900 * H, type: 'repair_start', recordedAt: 902 * H },
      { eventId: 're1', equipmentId: 'p1', time: 1000 * H, type: 'repair_end', recordedAt: 1001 * H }
    ]) {
      const response = await postEvent(event);
      expect(response.status).toBe(201);
    }

    const stats = await fetch(`${baseUrl}/equipment/p1/statistics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ windowStart: 0, windowEnd: 1000 * H })
    }).then((response) =>
      json<{ mtbfHours: number; mttrHours: number; steadyStateAvailability: number }>(response)
    );
    expect(stats.mtbfHours).toBeCloseTo(900);
    expect(stats.mttrHours).toBeCloseTo(100);
    expect(stats.steadyStateAvailability).toBeCloseTo(0.9);

    const timeline = await fetch(`${baseUrl}/equipment/p1/timeline`).then((response) =>
      json<{ intervals: Array<{ end: number | null }> }>(response)
    );
    expect(timeline.intervals.at(-1)?.end).toBeNull();
  });
});
