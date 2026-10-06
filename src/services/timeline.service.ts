import { badRequest, notFound } from '../core/errors.js';
import { deriveTimeline, effectiveEvents } from '../core/timeline.js';
import type { DeviceRepository } from '../storage/repository.js';
import type { DeviceTimeline } from '../core/types.js';

export class TimelineService {
  constructor(private readonly repo: DeviceRepository) {}

  async getTimeline(deviceId: string, query: { start?: string; end?: string; asOf?: string }) {
    const device = await this.repo.getDevice(deviceId);
    if (!device) throw notFound('Device not found');
    const events = effectiveEvents(await this.repo.listEventsForDevice(deviceId, query.asOf));
    if (events.length === 0 && (!query.start || !query.end)) {
      return { deviceId, segments: [], contradictions: [] } satisfies DeviceTimeline;
    }
    const start = query.start ?? events[0]?.occurredAt;
    const end = query.end ?? events.at(-1)?.occurredAt;
    if (!start || !end) throw badRequest('Timeline query requires start and end for empty event set');
    if (Date.parse(end) <= Date.parse(start)) throw badRequest('end must be later than start');
    return deriveTimeline(deviceId, events, start, end);
  }

  async listContradictions(query: { start?: string; end?: string; asOf?: string }) {
    const devices = await this.repo.listDevices();
    const result = await Promise.all(
      devices.map(async (device) => {
        const timeline = await this.getTimeline(device.id, query);
        return {
          deviceId: device.id,
          deviceCode: device.code,
          contradictions: timeline.contradictions,
        };
      }),
    );
    return result.filter((item) => item.contradictions.length > 0);
  }
}
