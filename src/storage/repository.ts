import { randomUUID } from 'node:crypto';
import type {
  Category,
  CategoryInput,
  Device,
  DeviceInput,
  StoredEvent,
  StructureVersion,
  StructureVersionInput,
  DerivedSnapshot,
} from '../core/types.js';
import { conflict, notFound } from '../core/errors.js';

export interface DeviceRepository {
  init(): Promise<void>;
  createCategory(input: CategoryInput): Promise<Category>;
  listCategories(): Promise<Category[]>;
  getCategory(id: string): Promise<Category | null>;
  createDevice(input: DeviceInput): Promise<Device>;
  getDevice(id: string): Promise<Device | null>;
  listDevices(): Promise<Device[]>;
  insertEvent(event: StoredEvent): Promise<StoredEvent | null>;
  getEvent(eventId: string): Promise<StoredEvent | null>;
  listEvents(asOf?: string): Promise<StoredEvent[]>;
  listEventsForDevice(deviceId: string, asOf?: string): Promise<StoredEvent[]>;
  listEventsForDevices(deviceIds: string[], asOf?: string): Promise<StoredEvent[]>;
  listVoidEvents(asOf?: string): Promise<StoredEvent[]>;
  createStructureVersion(systemId: string, input: StructureVersionInput): Promise<StructureVersion>;
  listStructureVersions(systemId: string, asOf?: string): Promise<StructureVersion[]>;
  listSystems(): Promise<string[]>;
  saveSnapshot(snapshot: DerivedSnapshot): Promise<void>;
  getSnapshot(key: Omit<DerivedSnapshot, 'payload' | 'calculatedAt' | 'id'>): Promise<DerivedSnapshot | null>;
  getFrozenSnapshot(key: {
    scope: DerivedSnapshot['scope'];
    scopeId: string;
    windowStart: string;
    windowEnd: string;
    asOf: string;
    method: DerivedSnapshot['method'];
  }): Promise<DerivedSnapshot | null>;
}

export function newId(): string {
  return randomUUID();
}

export class InMemoryRepository implements DeviceRepository {
  private categories = new Map<string, Category>();
  private devices = new Map<string, Device>();
  private events = new Map<string, StoredEvent>();
  private structures: StructureVersion[] = [];
  private snapshots = new Map<string, DerivedSnapshot>();

  async init(): Promise<void> {}

  async createCategory(input: CategoryInput): Promise<Category> {
    if ([...this.categories.values()].some((item) => item.name === input.name)) {
      throw conflict(`Category ${input.name} already exists`);
    }
    const category: Category = { ...input, id: newId(), createdAt: new Date().toISOString() };
    this.categories.set(category.id, category);
    return category;
  }

  async listCategories(): Promise<Category[]> {
    return [...this.categories.values()];
  }

  async getCategory(id: string): Promise<Category | null> {
    return this.categories.get(id) ?? null;
  }

  async createDevice(input: DeviceInput): Promise<Device> {
    if (!this.categories.has(input.categoryId)) throw notFound('Unknown category');
    if ([...this.devices.values()].some((item) => item.code === input.code)) {
      throw conflict(`Device code ${input.code} already exists`);
    }
    const device: Device = { ...input, id: newId(), createdAt: new Date().toISOString() };
    this.devices.set(device.id, device);
    return device;
  }

  async getDevice(id: string): Promise<Device | null> {
    return this.devices.get(id) ?? null;
  }

  async listDevices(): Promise<Device[]> {
    return [...this.devices.values()];
  }

  async insertEvent(event: StoredEvent): Promise<StoredEvent | null> {
    const existing = this.events.get(event.eventId);
    if (existing) return null;
    const stored: StoredEvent = { ...event, _id: newId() };
    this.events.set(event.eventId, stored);
    return stored;
  }

  async getEvent(eventId: string): Promise<StoredEvent | null> {
    return this.events.get(eventId) ?? null;
  }

  async listEvents(asOf?: string): Promise<StoredEvent[]> {
    return this.filterAsOf([...this.events.values()], asOf);
  }

  async listEventsForDevice(deviceId: string, asOf?: string): Promise<StoredEvent[]> {
    return this.filterAsOf(
      [...this.events.values()].filter(
        (event) => event.deviceId === deviceId || event.type === 'VOID',
      ),
      asOf,
    );
  }

  async listEventsForDevices(deviceIds: string[], asOf?: string): Promise<StoredEvent[]> {
    const wanted = new Set(deviceIds);
    return this.filterAsOf(
      [...this.events.values()].filter(
        (event) => event.deviceId !== null && wanted.has(event.deviceId),
      ),
      asOf,
    );
  }

  async listVoidEvents(asOf?: string): Promise<StoredEvent[]> {
    return this.filterAsOf(
      [...this.events.values()].filter((event) => event.type === 'VOID'),
      asOf,
    );
  }

  async createStructureVersion(
    systemId: string,
    input: StructureVersionInput,
  ): Promise<StructureVersion> {
    if (this.structures.some((item) => item.systemId === systemId && item.version === input.version)) {
      throw conflict(`Structure version ${input.version} already exists`);
    }
    const version: StructureVersion = {
      ...input,
      systemId,
      id: newId(),
      recordedAt: input.recordedAt ?? new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    this.structures.push(version);
    return version;
  }

  async listStructureVersions(systemId: string, asOf?: string): Promise<StructureVersion[]> {
    const cutoff = asOf ? Date.parse(asOf) : Number.POSITIVE_INFINITY;
    return this.structures
      .filter((item) => item.systemId === systemId && Date.parse(item.recordedAt) <= cutoff)
      .map((item) => structuredClone(item));
  }

  async listSystems(): Promise<string[]> {
    return [...new Set(this.structures.map((item) => item.systemId))];
  }

  async saveSnapshot(snapshot: DerivedSnapshot): Promise<void> {
    this.snapshots.set(this.snapshotKey(snapshot), structuredClone(snapshot));
  }

  async getSnapshot(
    key: Omit<DerivedSnapshot, 'payload' | 'calculatedAt' | 'id'>,
  ): Promise<DerivedSnapshot | null> {
    return this.snapshots.get(this.snapshotKey(key)) ?? null;
  }

  async getFrozenSnapshot(
    key: { scope: DerivedSnapshot['scope']; scopeId: string; windowStart: string; windowEnd: string; asOf: string; method: DerivedSnapshot['method'] },
  ): Promise<DerivedSnapshot | null> {
    return this.snapshots.get(this.snapshotKey({ ...key, frozen: true })) ?? null;
  }

  private snapshotKey(
    snapshot: Omit<DerivedSnapshot, 'payload' | 'calculatedAt' | 'id'>,
  ): string {
    return [
      snapshot.scope,
      snapshot.scopeId,
      snapshot.windowStart,
      snapshot.windowEnd,
      snapshot.asOf,
      snapshot.method,
      snapshot.frozen ? 'frozen' : 'current',
    ].join('|');
  }

  private filterAsOf(events: StoredEvent[], asOf?: string): StoredEvent[] {
    const cutoff = asOf ? Date.parse(asOf) : Number.POSITIVE_INFINITY;
    return events
      .filter((event) => Date.parse(event.recordedAt) <= cutoff)
      .map((event) => structuredClone(event));
  }
}
