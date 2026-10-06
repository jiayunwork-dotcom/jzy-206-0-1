import { calculateWindowStatistics } from '../core/statistics.js';
import { effectiveEvents } from '../core/timeline.js';
import type {
  EventChange,
  RecalculationDiff,
  StoredEvent,
  WindowStatistics,
} from '../core/types.js';
import type { DeviceRepository } from '../storage/repository.js';

export class AsOfService {
  constructor(private readonly repo: DeviceRepository) {}

  async recalculateWindow(
    windowStart: string,
    windowEnd: string,
    asOf: string,
    method: 'right_censored' | 'drop' = 'right_censored',
  ): Promise<Record<string, WindowStatistics>> {
    const devices = await this.repo.listDevices();
    const result: Record<string, WindowStatistics> = {};
    for (const device of devices) {
      const category = await this.repo.getCategory(device.categoryId);
      const events = await this.repo.listEventsForDevice(device.id, asOf);
      result[device.id] = calculateWindowStatistics({
        deviceId: device.id,
        events,
        windowStart,
        windowEnd,
        plannedIsDowntime: category?.plannedIsDowntime ?? false,
        method,
      });
    }
    return result;
  }

  async compare(
    windowStart: string,
    windowEnd: string,
    baselineAsOf: string,
    currentAsOf: string,
    method: 'right_censored' | 'drop' = 'right_censored',
  ): Promise<RecalculationDiff> {
    const baseline = await this.recalculateWindow(windowStart, windowEnd, baselineAsOf, method);
    const current = await this.recalculateWindow(windowStart, windowEnd, currentAsOf, method);
    const allCurrent = await this.repo.listEvents(currentAsOf);
    const baselineCutoff = Date.parse(baselineAsOf);
    const currentCutoff = Date.parse(currentAsOf);
    const changedEvents = allCurrent
      .map((event) => event)
      .filter((event) => {
        const recordedAt = Date.parse(event.recordedAt);
        return recordedAt > baselineCutoff && recordedAt <= currentCutoff;
      })
      .sort(
        (a, b) =>
          Date.parse(a.recordedAt) - Date.parse(b.recordedAt) ||
          a.eventId.localeCompare(b.eventId),
      );

    const baselineEvents = effectiveEvents(await this.repo.listEvents(baselineAsOf));
    const currentEvents = effectiveEvents(await this.repo.listEvents(currentAsOf));
    const baselineIds = new Set(baselineEvents.map((event) => event.eventId));
    const currentIds = new Set(currentEvents.map((event) => event.eventId));
    const eventChanges: EventChange[] = changedEvents.flatMap((event) => {
      const changes: EventChange[] = [];
      if (event.type === 'VOID') {
        const target = allCurrent.find((item) => item.eventId === event.targetEventId);
        if (target && baselineIds.has(target.eventId) && !currentIds.has(target.eventId)) {
          changes.push({ kind: 'voided', event: target });
        }
        return changes;
      }
      if (!baselineIds.has(event.eventId) && currentIds.has(event.eventId)) {
        changes.push({
          kind: event.supersedesEventId ? 'replacement_activated' : 'added',
          event,
        });
      }
      return changes;
    });
    for (const event of baselineEvents) {
      if (!currentIds.has(event.eventId) && !eventChanges.some((change) => change.event.eventId === event.eventId)) {
        eventChanges.push({ kind: 'removed', event });
      }
    }

    return {
      windowStart,
      windowEnd,
      baselineAsOf,
      currentAsOf,
      baseline,
      current,
      changedEvents,
      eventChanges,
    };
  }

  eventsAffectingResult(events: StoredEvent[]): StoredEvent[] {
    return [...events].sort(
      (a, b) =>
        Date.parse(a.recordedAt) - Date.parse(b.recordedAt) ||
        a.eventId.localeCompare(b.eventId),
    );
  }
}
