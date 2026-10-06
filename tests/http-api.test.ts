import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../src/app.js';
import { InMemoryRepository } from '../src/storage/repository.js';
import { createServices, type Services } from '../src/container.js';

describe('HTTP API and rejection rules', () => {
  let app: Express;
  let services: Services;

  beforeAll(async () => {
    services = await createServices(new InMemoryRepository());
    app = createApp(services);
  });

  afterAll(() => undefined);

  it('maintains devices and categories', async () => {
    const category = await request(app).post('/api/categories').send({
      name: 'api-pump',
      plannedIsDowntime: false,
    });
    expect(category.status).toBe(201);
    const device = await request(app).post('/api/devices').send({
      code: 'API-1',
      name: 'Pump',
      categoryId: category.body.id,
    });
    expect(device.status).toBe(201);
    expect(device.body.id).toBeTruthy();
  });

  it('accepts single and batch events, timeline, contradictions and statistics', async () => {
    const category = await request(app).post('/api/categories').send({ name: 'api-pump-2', plannedIsDowntime: true });
    const device = await request(app).post('/api/devices').send({ code: 'API-2', name: 'P', categoryId: category.body.id });
    const start = new Date(0).toISOString();
    const end = new Date(100 * 3_600_000).toISOString();
    const batch = await request(app).post('/api/events/batch').send({
      events: [
        { eventId: 'api-f', deviceId: device.body.id, occurredAt: new Date(10 * 3_600_000).toISOString(), recordedAt: new Date(11 * 3_600_000).toISOString(), type: 'FAULT' },
        { eventId: 'api-r', deviceId: device.body.id, occurredAt: new Date(20 * 3_600_000).toISOString(), recordedAt: new Date(21 * 3_600_000).toISOString(), type: 'REPAIR_END' },
      ],
    });
    expect(batch.status).toBe(201);
    const repeat = await request(app).post('/api/events').send(batch.body.results[0].event);
    expect(repeat.status).toBe(200);
    expect(repeat.body.duplicate).toBe(true);

    const timeline = await request(app).get(`/api/devices/${device.body.id}/timeline?start=${start}&end=${end}`);
    expect(timeline.status).toBe(200);
    const contradictions = await request(app).get(`/api/contradictions?start=${start}&end=${end}`);
    expect(contradictions.status).toBe(200);
    const stats = await request(app).get(`/api/statistics/windows?start=${start}&end=${end}`);
    expect(stats.status).toBe(200);
    expect(Array.isArray(stats.body)).toBe(true);
  });

  it('rejects all specified invalid inputs', async () => {
    const knownCategory = await request(app).post('/api/categories').send({ name: 'bad-input-category', plannedIsDowntime: false });
    const device = await request(app).post('/api/devices').send({ code: 'BAD-1', name: 'P', categoryId: knownCategory.body.id });

    const reversedWindow = request(app).get(
      `/api/statistics/windows?start=2026-02-01T00:00:00.000Z&end=2026-01-01T00:00:00.000Z`,
    );
    const unknownType = request(app).post('/api/events').send({
      eventId: 'bad-type', deviceId: device.body.id, occurredAt: new Date().toISOString(), type: 'EXPLOSION',
    });
    const voidMissing = request(app).post('/api/events').send({
      eventId: 'bad-void', targetEventId: 'missing', occurredAt: new Date().toISOString(), type: 'VOID',
    });
    const invalidK = request(app).post('/systems/x/versions'.replace('/systems', '/api/systems')).send({
      version: 'bad', validFrom: new Date(0).toISOString(),
      root: { type: 'k_of_n', k: 2, children: [{ type: 'device', deviceId: device.body.id }] },
    });
    const unknownDeviceBlock = request(app).post('/api/systems/x/versions').send({
      version: 'bad2', validFrom: new Date(0).toISOString(),
      root: { type: 'series', children: [{ type: 'device', deviceId: 'missing-device' }] },
    });
    const duplicatedBlock = request(app).post('/api/systems/x/versions').send({
      version: 'bad3', validFrom: new Date(0).toISOString(),
      root: { type: 'parallel', children: [
        { type: 'device', deviceId: device.body.id },
        { type: 'device', deviceId: device.body.id },
      ] },
    });
    const results = await Promise.all([
      reversedWindow, unknownType, voidMissing, invalidK, unknownDeviceBlock, duplicatedBlock,
    ]);
    expect(results.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400]);
  });
});
