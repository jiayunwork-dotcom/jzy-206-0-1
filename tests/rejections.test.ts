import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors.js';
import { validateRbdShape } from '../src/validation.js';
import { AvailabilityService } from '../src/service.js';
import { createDb, createPump, equipmentNode, event, makeService } from './helpers.js';
import {
  InMemoryEquipmentRepository,
  InMemoryEventRepository,
  InMemoryStructureRepository
} from '../src/repositories/memory.js';

async function assertRejected(fn: () => Promise<unknown>, code = 'INVALID_REQUEST') {
  await expect(fn).rejects.toMatchObject({ status: 400, code });
}

describe('rejected input', () => {
  it('rejects invalid k-of-n parameters', () => {
    expect(() => validateRbdShape({ type: 'k_of_n', k: 3, n: 2, children: [] })).toThrow(AppError);
    expect(() =>
      validateRbdShape({ type: 'k_of_n', k: 0, n: 2, children: [equipmentNode('a'), equipmentNode('b')] })
    ).toThrow(AppError);
  });

  it('rejects RBD references to missing equipment and duplicate equipment in one structure', async () => {
    const service = makeService();
    await createPump(service, 'p1');
    await assertRejected(() =>
      service.addStructureVersion({
        systemId: 'line',
        root: { type: 'series', children: [equipmentNode('p1'), equipmentNode('missing')] }
      })
    );
    await assertRejected(() =>
      service.addStructureVersion({
        systemId: 'line',
        root: { type: 'parallel', children: [equipmentNode('p1'), equipmentNode('p1')] }
      })
    );
  });

  it('rejects reversed windows', async () => {
    const service = makeService();
    await createPump(service, 'p1');
    await assertRejected(() =>
      service.getWindowStatistics({ equipmentId: 'p1', windowStart: 20, windowEnd: 10 })
    );
  });

  it('rejects unknown event types', async () => {
    const service = makeService();
    await createPump(service, 'p1');
    await expect(
      service.submitEvent(event('bad', 'p1', 1, 'mystery' as never, 2))
    ).rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
  });

  it('rejects voiding a non-existent event', async () => {
    const service = makeService();
    await createPump(service, 'p1');
    await expect(
      service.submitEvent(event('v1', 'p1', 1, 'void_event', 2, 'does-not-exist'))
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('rejects events for non-existent equipment', async () => {
    const service = makeService();
    await assertRejected(() => service.submitEvent(event('f1', 'missing', 1, 'failure', 2)));
  });
});
