import { MongoClient, type Collection, type Db } from 'mongodb';
import { newId, type DeviceRepository } from './repository.js';
import { conflict, notFound } from '../core/errors.js';
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

export class MongoRepository implements DeviceRepository {
  private client: MongoClient;
  private db!: Db;
  private categoriesCollection!: Collection<Category>;
  private devicesCollection!: Collection<Device>;
  private eventsCollection!: Collection<StoredEvent>;
  private structuresCollection!: Collection<StructureVersion>;
  private snapshotsCollection!: Collection<DerivedSnapshot>;

  constructor(private readonly url: string, private readonly databaseName = 'availability') {
    this.client = new MongoClient(url);
  }

  async init(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.databaseName);
    this.categoriesCollection = this.db.collection('categories');
    this.devicesCollection = this.db.collection('devices');
    this.eventsCollection = this.db.collection('maintenance_events');
    this.structuresCollection = this.db.collection('structure_versions');
    this.snapshotsCollection = this.db.collection('derived_snapshots');

    await this.categoriesCollection.createIndex({ name: 1 }, { unique: true });
    await this.devicesCollection.createIndex({ code: 1 }, { unique: true });
    await this.eventsCollection.createIndex({ eventId: 1 }, { unique: true });
    await this.structuresCollection.createIndex(
      { systemId: 1, version: 1 },
      { unique: true },
    );
    await this.snapshotsCollection.createIndex(
      { scope: 1, scopeId: 1, windowStart: 1, windowEnd: 1, asOf: 1, method: 1, frozen: 1 },
      { unique: true },
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async createCategory(input: CategoryInput): Promise<Category> {
    const category: Category = { ...input, id: newId(), createdAt: new Date().toISOString() };
    try {
      await this.categoriesCollection.insertOne(category);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw conflict(`Category ${input.name} already exists`);
      }
      throw error;
    }
    return category;
  }

  async listCategories(): Promise<Category[]> {
    return this.categoriesCollection.find({}, { projection: { _id: 0 } }).toArray() as Promise<Category[]>;
  }

  async getCategory(id: string): Promise<Category | null> {
    return (await this.categoriesCollection.findOne({ id }, { projection: { _id: 0 } })) ?? null;
  }

  async createDevice(input: DeviceInput): Promise<Device> {
    if (!(await this.getCategory(input.categoryId))) throw notFound('Unknown category');
    const device: Device = { ...input, id: newId(), createdAt: new Date().toISOString() };
    try {
      await this.devicesCollection.insertOne(device);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw conflict(`Device code ${input.code} already exists`);
      }
      throw error;
    }
    return device;
  }

  async getDevice(id: string): Promise<Device | null> {
    return (await this.devicesCollection.findOne({ id }, { projection: { _id: 0 } })) ?? null;
  }

  async listDevices(): Promise<Device[]> {
    return this.devicesCollection.find({}, { projection: { _id: 0 } }).toArray() as Promise<Device[]>;
  }

  async insertEvent(event: StoredEvent): Promise<StoredEvent | null> {
    try {
      await this.eventsCollection.insertOne(event);
      return event;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) return null;
      throw error;
    }
  }

  async getEvent(eventId: string): Promise<StoredEvent | null> {
    return (await this.eventsCollection.findOne({ eventId }, { projection: { _id: 0 } })) ?? null;
  }

  async listEvents(asOf?: string): Promise<StoredEvent[]> {
    const filter = asOf ? { recordedAt: { $lte: asOf } } : {};
    return this.eventsCollection.find(filter, { projection: { _id: 0 } }).toArray() as Promise<StoredEvent[]>;
  }

  async listEventsForDevice(deviceId: string, asOf?: string): Promise<StoredEvent[]> {
    const filter: Record<string, unknown> = { $or: [{ deviceId }, { type: 'VOID' }] };
    if (asOf) filter.recordedAt = { $lte: asOf };
    return this.eventsCollection.find(filter, { projection: { _id: 0 } }).toArray() as Promise<StoredEvent[]>;
  }

  async listEventsForDevices(deviceIds: string[], asOf?: string): Promise<StoredEvent[]> {
    const filter: Record<string, unknown> = { deviceId: { $in: deviceIds } };
    if (asOf) filter.recordedAt = { $lte: asOf };
    return this.eventsCollection.find(filter, { projection: { _id: 0 } }).toArray() as Promise<StoredEvent[]>;
  }

  async listVoidEvents(asOf?: string): Promise<StoredEvent[]> {
    const filter: Record<string, unknown> = { type: 'VOID' };
    if (asOf) filter.recordedAt = { $lte: asOf };
    return this.eventsCollection.find(filter, { projection: { _id: 0 } }).toArray() as Promise<StoredEvent[]>;
  }

  async createStructureVersion(
    systemId: string,
    input: StructureVersionInput,
  ): Promise<StructureVersion> {
    const version: StructureVersion = {
      ...input,
      systemId,
      id: newId(),
      recordedAt: input.recordedAt ?? new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    try {
      await this.structuresCollection.insertOne(version);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        throw conflict(`Structure version ${input.version} already exists`);
      }
      throw error;
    }
    return version;
  }

  async listStructureVersions(systemId: string, asOf?: string): Promise<StructureVersion[]> {
    const filter: Record<string, unknown> = { systemId };
    if (asOf) filter.recordedAt = { $lte: asOf };
    return this.structuresCollection.find(filter, { projection: { _id: 0 } }).toArray() as Promise<StructureVersion[]>;
  }

  async listSystems(): Promise<string[]> {
    const rows = await this.structuresCollection.distinct('systemId');
    return rows as string[];
  }

  async saveSnapshot(snapshot: DerivedSnapshot): Promise<void> {
    const filter = {
      scope: snapshot.scope,
      scopeId: snapshot.scopeId,
      windowStart: snapshot.windowStart,
      windowEnd: snapshot.windowEnd,
      asOf: snapshot.asOf,
      method: snapshot.method,
    };
    await this.snapshotsCollection.replaceOne(filter, snapshot, { upsert: true });
  }

  async getSnapshot(
    key: Omit<DerivedSnapshot, 'payload' | 'calculatedAt' | 'id'>,
  ): Promise<DerivedSnapshot | null> {
    return (await this.snapshotsCollection.findOne(key, { projection: { _id: 0 } })) ?? null;
  }

  async getFrozenSnapshot(
    key: { scope: DerivedSnapshot['scope']; scopeId: string; windowStart: string; windowEnd: string; asOf: string; method: DerivedSnapshot['method'] },
  ): Promise<DerivedSnapshot | null> {
    return (await this.snapshotsCollection.findOne({ ...key, frozen: true }, { projection: { _id: 0 } })) ?? null;
  }
}
