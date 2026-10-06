import type { EventRepository, EquipmentRepository, StructureRepository } from './types.js';
import type {
  CategoryRecord,
  EquipmentRecord,
  StoredEvent,
  StructureVersion
} from '../types.js';

export interface InMemoryDatabase {
  events: Map<string, StoredEvent>;
  categories: Map<string, CategoryRecord[]>;
  equipment: Map<string, EquipmentRecord[]>;
  structures: Map<string, StructureVersion[]>;
}

export const createInMemoryDatabase = (): InMemoryDatabase => ({
  events: new Map(),
  categories: new Map(),
  equipment: new Map(),
  structures: new Map()
});

export class InMemoryEventRepository implements EventRepository {
  private readonly events: Map<string, StoredEvent>;

  constructor(db: InMemoryDatabase = createInMemoryDatabase()) {
    this.events = db.events;
  }

  async insertEvent(event: StoredEvent): Promise<void> {
    if (this.events.has(event.eventId)) {
      throw new Error(`duplicate event ${event.eventId}`);
    }
    this.events.set(event.eventId, structuredClone(event));
  }

  async replaceEvent(event: StoredEvent): Promise<void> {
    this.events.set(event.eventId, structuredClone(event));
  }

  async getEvent(eventId: string): Promise<StoredEvent | null> {
    const event = this.events.get(eventId);
    return event ? structuredClone(event) : null;
  }

  async listAllEvents(): Promise<StoredEvent[]> {
    return [...this.events.values()].map((event) => structuredClone(event));
  }

  async listEventsForEquipment(equipmentId: string): Promise<StoredEvent[]> {
    return [...this.events.values()]
      .filter((event) => event.equipmentId === equipmentId)
      .map((event) => structuredClone(event));
  }
}

export class InMemoryEquipmentRepository implements EquipmentRepository {
  private readonly categories: Map<string, CategoryRecord[]>;
  private readonly equipment: Map<string, EquipmentRecord[]>;

  constructor(db: InMemoryDatabase = createInMemoryDatabase()) {
    this.categories = db.categories;
    this.equipment = db.equipment;
  }

  async insertCategory(category: CategoryRecord): Promise<void> {
    const history = this.categories.get(category.id) ?? [];
    if (history.some((item) => item.supersededAt === undefined)) {
      throw new Error(`duplicate category ${category.id}`);
    }
    history.push(structuredClone(category));
    this.categories.set(category.id, history);
  }

  async replaceCategory(category: CategoryRecord): Promise<void> {
    const history = this.categories.get(category.id) ?? [];
    history.push(structuredClone(category));
    this.categories.set(category.id, history);
  }

  async getCategory(id: string): Promise<CategoryRecord | null> {
    const history = this.categories.get(id) ?? [];
    const current = history.find((item) => item.supersededAt === undefined);
    return current ? structuredClone(current) : null;
  }

  async getCategoryAt(id: string, asOf: number): Promise<CategoryRecord | null> {
    const history = this.categories.get(id) ?? [];
    const match = history.find(
      (item) => item.createdAt <= asOf && (item.supersededAt === undefined || item.supersededAt > asOf)
    );
    return match ? structuredClone(match) : null;
  }

  async listCategories(): Promise<CategoryRecord[]> {
    return [...this.categories.values()]
      .map((history) => history.find((item) => item.supersededAt === undefined))
      .filter((item): item is CategoryRecord => item !== undefined)
      .map((item) => structuredClone(item));
  }

  async insertEquipment(equipment: EquipmentRecord): Promise<void> {
    const history = this.equipment.get(equipment.id) ?? [];
    if (history.some((item) => item.supersededAt === undefined)) {
      throw new Error(`duplicate equipment ${equipment.id}`);
    }
    history.push(structuredClone(equipment));
    this.equipment.set(equipment.id, history);
  }

  async replaceEquipment(equipment: EquipmentRecord): Promise<void> {
    const history = this.equipment.get(equipment.id) ?? [];
    history.push(structuredClone(equipment));
    this.equipment.set(equipment.id, history);
  }

  async getEquipment(id: string): Promise<EquipmentRecord | null> {
    const history = this.equipment.get(id) ?? [];
    const current = history.find((item) => item.supersededAt === undefined);
    return current ? structuredClone(current) : null;
  }

  async getEquipmentAt(id: string, asOf: number): Promise<EquipmentRecord | null> {
    const history = this.equipment.get(id) ?? [];
    const match = history.find(
      (item) => item.createdAt <= asOf && (item.supersededAt === undefined || item.supersededAt > asOf)
    );
    return match ? structuredClone(match) : null;
  }

  async listEquipment(): Promise<EquipmentRecord[]> {
    return [...this.equipment.values()]
      .map((history) => history.find((item) => item.supersededAt === undefined))
      .filter((item): item is EquipmentRecord => item !== undefined)
      .map((item) => structuredClone(item));
  }
}

export class InMemoryStructureRepository implements StructureRepository {
  private readonly versions: Map<string, StructureVersion[]>;

  constructor(db: InMemoryDatabase = createInMemoryDatabase()) {
    this.versions = db.structures;
  }

  async insertVersion(version: StructureVersion): Promise<void> {
    const list = this.versions.get(version.systemId) ?? [];
    if (list.some((item) => item.id === version.id)) {
      throw new Error(`duplicate structure version ${version.id}`);
    }
    list.push(structuredClone(version));
    this.versions.set(version.systemId, list);
  }

  async getVersion(id: string): Promise<StructureVersion | null> {
    for (const list of this.versions.values()) {
      const match = list.find((item) => item.id === id);
      if (match) return structuredClone(match);
    }
    return null;
  }

  async listVersions(systemId: string): Promise<StructureVersion[]> {
    return (this.versions.get(systemId) ?? []).map((item) => structuredClone(item));
  }

  async closeOpenVersion(systemId: string, effectiveTo: number): Promise<void> {
    const list = this.versions.get(systemId) ?? [];
    const open = list.find((item) => item.effectiveTo === null);
    if (open) open.effectiveTo = effectiveTo;
  }
}
