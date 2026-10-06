import { AvailabilityService } from '../src/service.js';
import {
  InMemoryEquipmentRepository,
  InMemoryEventRepository,
  InMemoryStructureRepository,
  type InMemoryDatabase
} from '../src/repositories/memory.js';
import type { EventInput, MaintenanceEvent } from '../src/types.js';

export const H = 3_600_000;

export function makeService(db: InMemoryDatabase = createDb()) {
  let now = 10_000_000_000_000;
  return new AvailabilityService(
    new InMemoryEventRepository(db),
    new InMemoryEquipmentRepository(db),
    new InMemoryStructureRepository(db),
    () => {
      now += 1;
      return now;
    }
  );
}

export function createDb(): InMemoryDatabase {
  return {
    events: new Map(),
    categories: new Map(),
    equipment: new Map(),
    structures: new Map()
  };
}

export async function createPump(service: AvailabilityService, id = 'pump-1', plannedAsDowntime = true) {
  const category = await service.createCategory({
    id: `${id}-cat`,
    name: 'pump',
    plannedMaintenanceAsDowntime: plannedAsDowntime,
    createdAt: 0
  });
  return service.createEquipment({ id, name: id, categoryId: category.id, createdAt: 0 });
}

export function event(
  eventId: string,
  equipmentId: string,
  time: number,
  type: EventInput['type'],
  recordedAt = time + 1_000,
  targetEventId?: string
): EventInput {
  const base = { eventId, equipmentId, time, type, recordedAt };
  return targetEventId ? { ...base, targetEventId } : base;
}

export function effectiveEvent(input: EventInput): MaintenanceEvent {
  if (input.type === 'void_event') throw new Error('void_event cannot be a maintenance event');
  return {
    eventId: input.eventId,
    equipmentId: input.equipmentId,
    time: input.time,
    type: input.type,
    recordedAt: input.recordedAt!,
    revision: 1,
    revisions: []
  };
}

export function equipmentNode(equipmentId: string) {
  return { type: 'equipment' as const, equipmentId };
}
