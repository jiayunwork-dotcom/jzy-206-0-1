import { conflict, invalidRequest, notFound } from './errors.js';
import { evaluateRbd, requiredEquipmentIds, validateRbd } from './rbd.js';
import {
  isMaintenanceEvent,
  type EquipmentRepository,
  type EventRepository,
  type StructureRepository
} from './repositories/types.js';
import { calculateWindowStatistics } from './statistics.js';
import { deriveTimeline } from './timeline.js';
import { hours } from './time.js';
import { EVENT_TYPES, validateWindow } from './validation.js';
import type {
  Category,
  CategoryRecord,
  EffectiveEventDifference,
  Equipment,
  EquipmentRecord,
  EventInput,
  MaintenanceEvent,
  RecalculationComparison,
  RbdNode,
  StoredEvent,
  StructureVersion,
  SystemAvailabilityResult,
  Timeline,
  TruncationMethod,
  VoidEvent,
  WindowStatistics
} from './types.js';

interface EventAtOptions {
  asOf?: number;
}

export class AvailabilityService {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly events: EventRepository,
    private readonly equipmentRepo: EquipmentRepository,
    private readonly structures: StructureRepository,
    private readonly clock: () => number = () => Date.now()
  ) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ------------------------------
  // Equipment and category master data
  // ------------------------------

  async createCategory(input: Omit<Category, 'id'> & { id?: string; createdAt?: number }): Promise<CategoryRecord> {
    return this.exclusive(async () => {
      const id = input.id ?? `cat-${this.clock()}-${Math.random().toString(36).slice(2, 10)}`;
      const existing = await this.equipmentRepo.getCategory(id);
      if (existing) throw conflict(`Category ${id} already exists`);
      const record: CategoryRecord = {
        id,
        name: input.name,
        plannedMaintenanceAsDowntime: input.plannedMaintenanceAsDowntime,
        createdAt: input.createdAt ?? this.clock()
      };
      await this.equipmentRepo.insertCategory(record);
      return record;
    });
  }

  async updateCategory(id: string, patch: Partial<Pick<Category, 'name' | 'plannedMaintenanceAsDowntime'>>): Promise<CategoryRecord> {
    return this.exclusive(async () => {
      const current = await this.equipmentRepo.getCategory(id);
      if (!current) throw notFound(`Category ${id} not found`);
      const now = this.clock();
      await this.equipmentRepo.replaceCategory({ ...current, supersededAt: now });
      const next: CategoryRecord = {
        id,
        name: patch.name ?? current.name,
        plannedMaintenanceAsDowntime:
          patch.plannedMaintenanceAsDowntime ?? current.plannedMaintenanceAsDowntime,
        createdAt: now
      };
      await this.equipmentRepo.insertCategory(next);
      return next;
    });
  }

  async listCategories(): Promise<CategoryRecord[]> {
    return this.equipmentRepo.listCategories();
  }

  async createEquipment(input: Omit<Equipment, 'id'> & { id?: string; createdAt?: number }): Promise<EquipmentRecord> {
    return this.exclusive(async () => {
      const category = await this.equipmentRepo.getCategory(input.categoryId);
      if (!category) throw invalidRequest(`Category ${input.categoryId} does not exist`);
      const id = input.id ?? `eq-${this.clock()}-${Math.random().toString(36).slice(2, 10)}`;
      const existing = await this.equipmentRepo.getEquipment(id);
      if (existing) throw conflict(`Equipment ${id} already exists`);
      const record: EquipmentRecord = {
        id,
        name: input.name,
        categoryId: input.categoryId,
        createdAt: input.createdAt ?? this.clock()
      };
      await this.equipmentRepo.insertEquipment(record);
      return record;
    });
  }

  async updateEquipment(
    id: string,
    patch: Partial<Pick<Equipment, 'name' | 'categoryId'>>
  ): Promise<EquipmentRecord> {
    return this.exclusive(async () => {
      const current = await this.equipmentRepo.getEquipment(id);
      if (!current) throw notFound(`Equipment ${id} not found`);
      const nextCategoryId = patch.categoryId ?? current.categoryId;
      if (!(await this.equipmentRepo.getCategory(nextCategoryId))) {
        throw invalidRequest(`Category ${nextCategoryId} does not exist`);
      }
      const now = this.clock();
      await this.equipmentRepo.replaceEquipment({ ...current, supersededAt: now });
      const next: EquipmentRecord = {
        id,
        name: patch.name ?? current.name,
        categoryId: nextCategoryId,
        createdAt: now
      };
      await this.equipmentRepo.insertEquipment(next);
      return next;
    });
  }

  async listEquipment(): Promise<EquipmentRecord[]> {
    return this.equipmentRepo.listEquipment();
  }

  // ------------------------------
  // Event submission, idempotency, corrections and voiding
  // ------------------------------

  private async requireExistingEquipment(equipmentId: string): Promise<void> {
    if (!(await this.equipmentRepo.getEquipment(equipmentId))) {
      throw invalidRequest(`Equipment ${equipmentId} does not exist`);
    }
  }

  private async storeNewEvent(input: EventInput): Promise<StoredEvent> {
    if (!EVENT_TYPES.has(input.type)) throw invalidRequest(`Unknown event type: ${String(input.type)}`);
    await this.requireExistingEquipment(input.equipmentId);
    if (input.type === 'void_event') {
      const target = await this.events.getEvent(input.targetEventId!);
      if (!target) throw notFound(`Cannot void non-existent event ${input.targetEventId}`);
      if (!isMaintenanceEvent(target)) throw invalidRequest('A void event cannot void another void event');
      if (target.voided) throw conflict(`Event ${input.targetEventId} is already void`);
      const stored: VoidEvent = {
        eventId: input.eventId,
        equipmentId: input.equipmentId,
        time: input.time,
        type: 'void_event',
        recordedAt: input.recordedAt!,
        targetEventId: input.targetEventId!
      };
      await this.events.insertEvent(stored);
      await this.events.replaceEvent({ ...target, voided: true, voidedAt: input.recordedAt });
      return stored;
    }

    const stored: MaintenanceEvent = {
      eventId: input.eventId,
      equipmentId: input.equipmentId,
      time: input.time,
      type: input.type,
      recordedAt: input.recordedAt!,
      revision: 1,
      revisions: [
        {
          revision: 1,
          equipmentId: input.equipmentId,
          time: input.time,
          type: input.type,
          recordedAt: input.recordedAt!
        }
      ]
    };
    await this.events.insertEvent(stored);
    return stored;
  }

  async submitEvent(input: EventInput): Promise<{ stored: StoredEvent; duplicate: boolean }> {
    return this.exclusive(async () => {
      const existing = await this.events.getEvent(input.eventId);
      if (existing) {
        if (existing.type !== input.type || existing.equipmentId !== input.equipmentId) {
          throw conflict(`Event ${input.eventId} already exists with different type or equipment`);
        }
        if (existing.type === 'void_event' && existing.targetEventId !== input.targetEventId) {
          throw conflict(`Void event ${input.eventId} already targets another event`);
        }
        if (existing.type !== 'void_event' && existing.time === input.time) {
          return { stored: existing, duplicate: true };
        }
        throw conflict(`Event ${input.eventId} already exists; use correction to change its time`);
      }
      return { stored: await this.storeNewEvent(input), duplicate: false };
    });
  }

  async submitBatch(inputs: EventInput[]): Promise<Array<{ eventId: string; duplicate: boolean }>> {
    return this.exclusive(async () => {
      const requestIds = new Set<string>();
      for (const input of inputs) {
        if (requestIds.has(input.eventId)) throw invalidRequest(`Duplicate eventId in batch: ${input.eventId}`);
        requestIds.add(input.eventId);
        if (!EVENT_TYPES.has(input.type)) throw invalidRequest(`Unknown event type: ${String(input.type)}`);
        await this.requireExistingEquipment(input.equipmentId);
        if (input.type === 'void_event') {
          const target = await this.events.getEvent(input.targetEventId!);
          if (!target) throw notFound(`Cannot void non-existent event ${input.targetEventId}`);
          if (!isMaintenanceEvent(target) || target.voided) {
            throw invalidRequest(`Event ${input.targetEventId} cannot be voided`);
          }
        }
        const existing = await this.events.getEvent(input.eventId);
        if (
          existing &&
          (existing.type !== input.type ||
            existing.equipmentId !== input.equipmentId ||
            (existing.type !== 'void_event' && existing.time !== input.time))
        ) {
          throw conflict(`Conflicting duplicate event ${input.eventId}`);
        }
      }

      const ordered = [...inputs].sort((a, b) =>
        a.type === 'void_event' && b.type !== 'void_event'
          ? 1
          : b.type === 'void_event' && a.type !== 'void_event'
            ? -1
            : a.eventId.localeCompare(b.eventId)
      );
      const output: Array<{ eventId: string; duplicate: boolean }> = [];
      for (const input of ordered) {
        const existing = await this.events.getEvent(input.eventId);
        if (existing) {
          output.push({ eventId: input.eventId, duplicate: true });
          continue;
        }
        const result = await this.storeNewEvent(input);
        output.push({ eventId: result.eventId, duplicate: false });
      }
      return output.sort((a, b) => a.eventId.localeCompare(b.eventId));
    });
  }

  async correctEvent(
    eventId: string,
    patch: { time?: number; equipmentId?: string; type?: MaintenanceEvent['type'] },
    recordedAt = this.clock()
  ): Promise<MaintenanceEvent> {
    return this.exclusive(async () => {
      const existing = await this.events.getEvent(eventId);
      if (!existing) throw notFound(`Event ${eventId} not found`);
      if (!isMaintenanceEvent(existing)) throw invalidRequest('Void events cannot be corrected');
      if (existing.voided) throw conflict(`Voided event ${eventId} cannot be corrected`);
      const equipmentId = patch.equipmentId ?? existing.equipmentId;
      await this.requireExistingEquipment(equipmentId);
      const type = patch.type ?? existing.type;
      const time = patch.time ?? existing.time;
      const next: MaintenanceEvent = {
        ...existing,
        equipmentId,
        type,
        time,
        recordedAt,
        revision: existing.revision + 1,
        revisions: [
          ...existing.revisions,
          { revision: existing.revision + 1, equipmentId, time, type, recordedAt }
        ]
      };
      await this.events.replaceEvent(next);
      return next;
    });
  }

  private snapshotAt(event: MaintenanceEvent, asOf: number): MaintenanceEvent | null {
    const revisions = event.revisions.filter((revision) => revision.recordedAt <= asOf);
    const revision = revisions.at(-1);
    if (!revision) return null;
    if (event.voidedAt !== undefined && event.voidedAt <= asOf) return null;
    return {
      eventId: event.eventId,
      equipmentId: revision.equipmentId,
      time: revision.time,
      type: revision.type,
      recordedAt: revision.recordedAt,
      revision: revision.revision,
      revisions: event.revisions
    };
  }

  async effectiveEventsForEquipment(equipmentId: string, options: EventAtOptions = {}): Promise<MaintenanceEvent[]> {
    const asOf = options.asOf ?? this.clock();
    const stored = await this.events.listEventsForEquipment(equipmentId);
    const voids = new Map<string, VoidEvent>();
    for (const event of stored) {
      if (event.type === 'void_event' && event.recordedAt <= asOf) voids.set(event.targetEventId, event);
    }
    return stored
      .filter(isMaintenanceEvent)
      .map((event) => this.snapshotAt(event, asOf))
      .filter((event): event is MaintenanceEvent => event !== null)
      .filter((event) => !voids.has(event.eventId))
      .sort((a, b) => a.time - b.time || a.eventId.localeCompare(b.eventId));
  }

  async effectiveEventsForTimeline(equipmentId: string, options: EventAtOptions = {}): Promise<MaintenanceEvent[]> {
    const asOf = options.asOf ?? this.clock();
    const all = await this.events.listAllEvents();
    const voids = new Map<string, VoidEvent>();
    for (const event of all) {
      if (event.type === 'void_event' && event.recordedAt <= asOf) voids.set(event.targetEventId, event);
    }
    return all
      .filter(isMaintenanceEvent)
      .map((event) => this.snapshotAt(event, asOf))
      .filter((event): event is MaintenanceEvent => event !== null)
      .filter((event) => event.equipmentId === equipmentId && !voids.has(event.eventId))
      .sort((a, b) => a.time - b.time || a.eventId.localeCompare(b.eventId));
  }

  async getTimeline(equipmentId: string, options: EventAtOptions = {}): Promise<Timeline> {
    if (!(await this.equipmentRepo.getEquipment(equipmentId))) throw notFound(`Equipment ${equipmentId} not found`);
    const effective = await this.effectiveEventsForTimeline(equipmentId, options);
    return deriveTimeline(equipmentId, effective);
  }

  // ------------------------------
  // Window statistics
  // ------------------------------

  private async categoryAt(equipmentId: string, asOf: number) {
    const equipment = await this.equipmentRepo.getEquipmentAt(equipmentId, asOf);
    if (!equipment) throw notFound(`Equipment ${equipmentId} did not exist at asOf ${asOf}`);
    const category = await this.equipmentRepo.getCategoryAt(equipment.categoryId, asOf);
    if (!category) throw notFound(`Category ${equipment.categoryId} did not exist at asOf ${asOf}`);
    return { equipment, category };
  }

  async getWindowStatistics(input: {
    equipmentId: string;
    windowStart: number;
    windowEnd: number;
    truncationMethod?: TruncationMethod;
    asOf?: number;
  }): Promise<WindowStatistics> {
    const window = validateWindow(input.windowStart, input.windowEnd);
    const asOf = input.asOf ?? this.clock();
    const { category } = await this.categoryAt(input.equipmentId, asOf);
    const effective = await this.effectiveEventsForTimeline(input.equipmentId, { asOf });
    const timeline = deriveTimeline(input.equipmentId, effective);
    return calculateWindowStatistics({
      equipmentId: input.equipmentId,
      timeline,
      events: effective,
      windowStart: window.start,
      windowEnd: window.end,
      plannedMaintenanceAsDowntime: category.plannedMaintenanceAsDowntime,
      truncationMethod: input.truncationMethod
    });
  }

  private diffEffectiveEvents(earlier: MaintenanceEvent[], later: MaintenanceEvent[]): EffectiveEventDifference {
    const byIdEarlier = new Map(earlier.map((event) => [event.eventId, event]));
    const byIdLater = new Map(later.map((event) => [event.eventId, event]));
    const added: MaintenanceEvent[] = [];
    const removed: MaintenanceEvent[] = [];
    const changed: EffectiveEventDifference['changed'] = [];
    const unchanged: MaintenanceEvent[] = [];

    for (const laterEvent of byIdLater.values()) {
      const earlierEvent = byIdEarlier.get(laterEvent.eventId);
      if (!earlierEvent) added.push(laterEvent);
      else if (
        earlierEvent.time !== laterEvent.time ||
        earlierEvent.type !== laterEvent.type ||
        earlierEvent.equipmentId !== laterEvent.equipmentId
      ) {
        changed.push({ from: earlierEvent, to: laterEvent });
      } else {
        unchanged.push(laterEvent);
      }
    }
    for (const earlierEvent of byIdEarlier.values()) {
      if (!byIdLater.has(earlierEvent.eventId)) removed.push(earlierEvent);
    }
    return { added, removed, changed, unchanged };
  }

  async compareWindowAt(input: {
    equipmentId: string;
    windowStart: number;
    windowEnd: number;
    earlierAsOf: number;
    asOf?: number;
    truncationMethod?: TruncationMethod;
  }): Promise<RecalculationComparison<WindowStatistics>> {
    const asOf = input.asOf ?? this.clock();
    const [earlier, current] = await Promise.all([
      this.getWindowStatistics({
        equipmentId: input.equipmentId,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        truncationMethod: input.truncationMethod,
        asOf: input.earlierAsOf
      }),
      this.getWindowStatistics({
        equipmentId: input.equipmentId,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
        truncationMethod: input.truncationMethod,
        asOf
      })
    ]);
    const [earlierEvents, currentEvents] = await Promise.all([
      this.effectiveEventsForTimeline(input.equipmentId, { asOf: input.earlierAsOf }),
      this.effectiveEventsForTimeline(input.equipmentId, { asOf })
    ]);
    return {
      earlierAsOf: input.earlierAsOf,
      asOf,
      earlier,
      current,
      effectiveEventDifference: this.diffEffectiveEvents(earlierEvents, currentEvents)
    };
  }

  // ------------------------------
  // Reliability block diagrams and versions
  // ------------------------------

  async addStructureVersion(input: {
    systemId: string;
    root: unknown;
    effectiveFrom?: number | null;
    id?: string;
    asOf?: number;
  }): Promise<StructureVersion> {
    return this.exclusive(async () => {
      const equipmentList = await this.equipmentRepo.listEquipment();
      const equipmentIds = new Set(equipmentList.map((item) => item.id));
      const root = validateRbd(input.root, equipmentIds);
      const versions = await this.structures.listVersions(input.systemId);
      const knownAt = versions.filter((version) => version.createdAt <= (input.asOf ?? this.clock()));
      const effectiveFrom = input.effectiveFrom === undefined ? null : input.effectiveFrom;
      for (const version of knownAt) {
        const from = version.effectiveFrom ?? Number.NEGATIVE_INFINITY;
        const to = version.effectiveTo ?? Number.POSITIVE_INFINITY;
        const newFrom = effectiveFrom ?? Number.NEGATIVE_INFINITY;
        if (newFrom >= from && newFrom < to) {
          if (version.effectiveTo === null) {
            const closedEffectiveTo = effectiveFrom ?? Number.MIN_SAFE_INTEGER;
            await this.structures.closeOpenVersion(input.systemId, closedEffectiveTo, this.clock());
            version.effectiveTo = closedEffectiveTo;
          } else {
            throw conflict('New structure version starts inside a closed non-open version interval');
          }
        } else if (newFrom < from) {
          throw conflict('Cannot insert a structure version before an existing effective interval');
        }
      }
      const record: StructureVersion = {
        id: input.id ?? `str-${this.clock()}-${Math.random().toString(36).slice(2, 10)}`,
        systemId: input.systemId,
        effectiveFrom,
        effectiveTo: null,
        root,
        createdAt: input.asOf ?? this.clock()
      };
      await this.structures.insertVersion(record);
      return record;
    });
  }

  private async versionsAt(systemId: string, asOf: number): Promise<StructureVersion[]> {
    return (await this.structures.listVersions(systemId))
      .filter((version) => version.createdAt <= asOf)
      .map((version) => {
        if (version.effectiveFrom === null) {
          return { ...version, effectiveFrom: null, effectiveTo: version.effectiveTo };
        }
        return version;
      })
      .sort((a, b) => (a.effectiveFrom ?? Number.NEGATIVE_INFINITY) - (b.effectiveFrom ?? Number.NEGATIVE_INFINITY));
  }

  async getSystemAvailability(input: {
    systemId: string;
    windowStart: number;
    windowEnd: number;
    asOf?: number;
    truncationMethod?: TruncationMethod;
  }): Promise<SystemAvailabilityResult> {
    const window = validateWindow(input.windowStart, input.windowEnd);
    const asOf = input.asOf ?? this.clock();
    const versions = await this.versionsAt(input.systemId, asOf);
    const equipmentIds = new Set<string>();
    versions.forEach((version) => requiredEquipmentIds(version.root).forEach((id) => equipmentIds.add(id)));
    const timelineByEquipment = new Map(
      await Promise.all(
        [...equipmentIds].map(async (equipmentId) => [equipmentId, await this.getTimeline(equipmentId, { asOf })] as const)
      )
    );
    const equipmentBoundaries = new Set<number>();
    timelineByEquipment.forEach((timeline) => {
      timeline.intervals.forEach((interval) => {
        if (interval.start > window.start && interval.start < window.end) equipmentBoundaries.add(interval.start);
        if (Number.isFinite(interval.end) && interval.end! > window.start && interval.end! < window.end) {
          equipmentBoundaries.add(interval.end!);
        }
      });
    });
    const segments: SystemAvailabilityResult['segments'] = [];

    let cursor = window.start;
    while (cursor < window.end) {
      const version = versions.find((item) => {
        const from = item.effectiveFrom ?? Number.NEGATIVE_INFINITY;
        const to = item.effectiveTo ?? Number.POSITIVE_INFINITY;
        return cursor >= from && cursor < to;
      });
      const structureBoundaries = versions
        .map((item) => item.effectiveFrom ?? Number.NEGATIVE_INFINITY)
        .filter((time) => time > cursor && time < window.end);
      const futureEquipmentBoundaries = [...equipmentBoundaries].filter((time) => time > cursor);
      const nextBoundary = Math.min(
        window.end,
        ...(structureBoundaries.length > 0 ? structureBoundaries : [window.end]),
        ...(futureEquipmentBoundaries.length > 0 ? futureEquipmentBoundaries : [window.end])
      );
      const segmentEnd = nextBoundary;

      let availability: number | null = null;
      if (version) {
        const ids = requiredEquipmentIds(version.root);
        const availabilityById = new Map<string, number>();
        let allEquipmentAvailable = true;
        for (const equipmentId of ids) {
          const stats = await this.getWindowStatistics({
            equipmentId,
            windowStart: cursor,
            windowEnd: segmentEnd,
            asOf,
            truncationMethod: input.truncationMethod
          });
          if (stats.steadyStateAvailability === null) {
            allEquipmentAvailable = false;
            break;
          }
          availabilityById.set(equipmentId, stats.steadyStateAvailability);
        }
        if (allEquipmentAvailable) {
          availability = evaluateRbd(version.root, availabilityById);
        }
      }

      segments.push({
        structureVersionId: version?.id ?? null,
        start: cursor,
        end: segmentEnd,
        durationHours: hours(segmentEnd - cursor),
        availability
      });
      cursor = segmentEnd;
    }

    const totalHours = hours(window.end - window.start);
    const anyMissing = segments.some((segment) => segment.availability === null);
    const availability = anyMissing
      ? null
      : segments.reduce(
          (sum, segment) => sum + segment.availability! * segment.durationHours,
          0
        ) / totalHours;

    return {
      systemId: input.systemId,
      windowStart: window.start,
      windowEnd: window.end,
      availability,
      segments
    };
  }
}
