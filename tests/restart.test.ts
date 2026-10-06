import { afterAll, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoRepository } from '../src/storage/mongo-repository.js';

const mongoUrl = process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
const databaseName = `availability_test_${process.env.VITEST_WORKER_ID ?? '0'}_${Date.now()}`;

describe.skipIf(!process.env.RUN_MONGO_TESTS)('Mongo restart recovery', () => {
  afterAll(async () => {
    const client = new MongoClient(mongoUrl);
    await client.connect();
    await client.db(databaseName).dropDatabase();
    await client.close();
  });

  it('rebuilds state entirely from persisted events after reconnect', async () => {
    const first = new MongoRepository(mongoUrl, databaseName);
    await first.init();
    const category = await first.createCategory({ name: 'recovery', plannedIsDowntime: false });
    const device = await first.createDevice({ code: 'recover-pump', name: 'P', categoryId: category.id });
    await first.insertEvent({
      eventId: 'recover-fault',
      deviceId: device.id,
      occurredAt: new Date(10 * 3_600_000).toISOString(),
      recordedAt: new Date(11 * 3_600_000).toISOString(),
      type: 'FAULT',
      targetEventId: null,
    });
    await first.close();

    const second = new MongoRepository(mongoUrl, databaseName);
    await second.init();
    const recoveredDevice = await second.getDevice(device.id);
    const recoveredEvent = await second.getEvent('recover-fault');
    expect(recoveredDevice?.code).toBe('recover-pump');
    expect(recoveredEvent?.type).toBe('FAULT');
    await second.close();
  });
});
