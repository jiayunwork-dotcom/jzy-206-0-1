import { describe, expect, it } from 'vitest';
import { H, createPump, event, makeService } from './helpers.js';

describe('truncation handling', () => {
  it('uses censored exposure by default and shows the bias from direct discard', async () => {
    const makeDataset = async () => {
      const service = makeService();
      await createPump(service, 'pump');
      await service.submitEvent(event('f1', 'pump', 0, 'failure', 1 * H));
      await service.submitEvent(event('rs1', 'pump', 0, 'repair_start', 2 * H));
      await service.submitEvent(event('re1', 'pump', 2 * H, 'repair_end', 3 * H));
      await service.submitEvent(event('f2', 'pump', 5 * H, 'failure', 6 * H));
      await service.submitEvent(event('rs2', 'pump', 5 * H, 'repair_start', 7 * H));
      // Second repair order is still open at the quarter boundary.
      return service;
    };

    const window = { equipmentId: 'pump', windowStart: 0, windowEnd: 20 * H };
    const censoredService = await makeDataset();
    const discardService = await makeDataset();
    const censored = await censoredService.getWindowStatistics({ ...window, truncationMethod: 'censored' });
    const discard = await discardService.getWindowStatistics({ ...window, truncationMethod: 'discard' });

    // Direct discard keeps only the complete 2h repair. Censored MLE includes both
    // repairs' observed exposure: completed 2h plus open 15h, over two repairs.
    expect(discard.mttrHours).toBeCloseTo(2);
    expect(censored.mttrHours).toBeCloseTo(8.5);
    expect(censored.rightCensoredRepairCount).toBe(1);

    // The observed availability still includes the actual down time; it is not discarded.
    expect(censored.steadyStateAvailability).toBeCloseTo(0.15);
    expect(discard.steadyStateAvailability).toBeCloseTo(0.15);
  });

  it('counts a running interval cut by the right boundary as censored MTBF exposure', async () => {
    const makeDataset = async () => {
      const service = makeService();
      await createPump(service, 'pump');
      await service.submitEvent(event('f1', 'pump', 5 * H, 'failure', 6 * H));
      await service.submitEvent(event('rs1', 'pump', 5 * H, 'repair_start', 7 * H));
      await service.submitEvent(event('re1', 'pump', 6 * H, 'repair_end', 8 * H));
      await service.submitEvent(event('f2', 'pump', 10 * H, 'failure', 9 * H));
      await service.submitEvent(event('rs2', 'pump', 10 * H, 'repair_start', 10 * H));
      await service.submitEvent(event('re2', 'pump', 11 * H, 'repair_end', 11 * H));
      // Final running interval is open from 11h to at least the window end at 20h.
      return service;
    };
    const input = { equipmentId: 'pump', windowStart: 0, windowEnd: 20 * H };
    const censored = await (await makeDataset()).getWindowStatistics({ ...input, truncationMethod: 'censored' });
    const discard = await (await makeDataset()).getWindowStatistics({ ...input, truncationMethod: 'discard' });

    // Censored: running exposure 5h + 4h + right-censored 9h / two failures = 9h.
    expect(censored.mtbfHours).toBeCloseTo(9);
    // Direct discard keeps the two fully observed pre-failure runs: 5h and 4h.
    expect(discard.mtbfHours).toBeCloseTo(4.5);
  });
});
