import type {
  CategoryRecord,
  EquipmentRecord,
  MaintenanceEvent,
  StoredEvent,
  StructureVersion,
  VoidEvent
} from '../types.js';

export interface EventRepository {
  insertEvent(event: StoredEvent): Promise<void>;
  replaceEvent(event: StoredEvent): Promise<void>;
  getEvent(eventId: string): Promise<StoredEvent | null>;
  listAllEvents(): Promise<StoredEvent[]>;
  listEventsForEquipment(equipmentId: string): Promise<StoredEvent[]>;
}

export interface EquipmentRepository {
  insertCategory(category: CategoryRecord): Promise<void>;
  replaceCategory(category: CategoryRecord): Promise<void>;
  getCategory(id: string): Promise<CategoryRecord | null>;
  getCategoryAt(id: string, asOf: number): Promise<CategoryRecord | null>;
  listCategories(): Promise<CategoryRecord[]>;

  insertEquipment(equipment: EquipmentRecord): Promise<void>;
  replaceEquipment(equipment: EquipmentRecord): Promise<void>;
  getEquipment(id: string): Promise<EquipmentRecord | null>;
  getEquipmentAt(id: string, asOf: number): Promise<EquipmentRecord | null>;
  listEquipment(): Promise<EquipmentRecord[]>;
}

export interface StructureRepository {
  insertVersion(version: StructureVersion): Promise<void>;
  getVersion(id: string): Promise<StructureVersion | null>;
  listVersions(systemId: string): Promise<StructureVersion[]>;
  closeOpenVersion(systemId: string, effectiveTo: number, closedAt: number): Promise<void>;
}

export type MaintenanceOrVoid = MaintenanceEvent | VoidEvent;

export function isMaintenanceEvent(event: StoredEvent): event is MaintenanceEvent {
  return event.type !== 'void_event';
}

export function isVoidEvent(event: StoredEvent): event is VoidEvent {
  return event.type === 'void_event';
}
