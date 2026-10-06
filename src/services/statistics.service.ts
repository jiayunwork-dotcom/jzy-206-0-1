import { badRequest, notFound } from '../core/errors.js';
import { calculateWindowStatistics } from '../core/statistics.js';
import type { CensoringMethod, WindowStatistics } from '../core/types.js';
import type { DeviceRepository } from '../storage/repository.js';
import { newId } from '../storage/repository.js';

export class StatisticsService {
  constructor(private readonly repo: DeviceRepository) {}

  async forDevice(
    deviceId: string,
    windowStart: string,
    windowEnd: string,
    options: { asOf?: string; method?: CensoringMethod; plannedIsDowntime?: boolean; freeze?: boolean } = {},
  ): Promise<WindowStatistics> {
    this.validateWindow(windowStart, windowEnd);
    const device = await this.repo.getDevice(deviceId);
    if (!device) throw notFound('Device not found');
    const category = await this.repo.getCategory(device.categoryId);
    if (!category) throw notFound('Device category not found');
    if (options.freeze && options.asOf) {
      const frozen = await this.repo.getFrozenSnapshot({
        scope: 'device',
        scopeId: deviceId,
        windowStart,
        windowEnd,
        asOf: options.asOf,
        method: options.method ?? 'right_censored',
      });
      if (frozen) return frozen.payload as WindowStatistics;
    }
    const events = await this.repo.listEventsForDevice(deviceId, options.asOf);
    const stats = calculateWindowStatistics({
      deviceId,
      events,
      windowStart,
      windowEnd,
      plannedIsDowntime: options.plannedIsDowntime ?? category.plannedIsDowntime,
      method: options.method,
    });
    await this.repo.saveSnapshot({
      id: newId(),
      scope: 'device',
      scopeId: deviceId,
      windowStart,
      windowEnd,
      asOf: options.asOf ?? new Date().toISOString(),
      method: stats.method,
      payload: stats,
      calculatedAt: new Date().toISOString(),
      frozen: options.freeze === true,
    });
    return stats;
  }

  async forAll(
    windowStart: string,
    windowEnd: string,
    options: { asOf?: string; method?: CensoringMethod; freeze?: boolean } = {},
  ): Promise<WindowStatistics[]> {
    this.validateWindow(windowStart, windowEnd);
    const devices = await this.repo.listDevices();
    return Promise.all(
      devices.map((device) =>
        this.forDevice(device.id, windowStart, windowEnd, options),
      ),
    );
  }

  private validateWindow(windowStart: string, windowEnd: string) {
    if (Number.isNaN(Date.parse(windowStart)) || Number.isNaN(Date.parse(windowEnd))) {
      throw badRequest('Invalid window date');
    }
    if (Date.parse(windowEnd) <= Date.parse(windowStart)) {
      throw badRequest('Window end must be later than window start');
    }
  }
}
