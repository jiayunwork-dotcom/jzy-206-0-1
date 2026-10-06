import type { Collection, Db, MongoClient } from 'mongodb';
import type { EventRepository, EquipmentRepository, StructureRepository } from './types.js';
import type {
  CategoryRecord,
  EquipmentRecord,
  StoredEvent,
  StructureVersion
} from '../types.js';

export class MongoEventRepository implements EventRepository {
  private readonly collection: Collection<StoredEvent>;

  constructor(db: Db) {
    this.collection = db.collection<StoredEvent>('events');
  }

  static async indexes(db: Db): Promise<void> {
    await db.collection('events').createIndex({ eventId: 1 }, { unique: true });
    await db.collection('events').createIndex({ equipmentId: 1, time: 1 });
    await db.collection('events').createIndex({ recordedAt: 1 });
  }

  async insertEvent(event: StoredEvent): Promise<void> {
    try {
      await this.collection.insertOne(event);
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 11000) {
        throw new Error(`duplicate event ${event.eventId}`);
      }
      throw error;
    }
  }

  async replaceEvent(event: StoredEvent): Promise<void> {
    await this.collection.replaceOne({ eventId: event.eventId }, event, { upsert: true });
  }

  async getEvent(eventId: string): Promise<StoredEvent | null> {
    return this.collection.findOne({ eventId });
  }

  async listAllEvents(): Promise<StoredEvent[]> {
    return this.collection.find().toArray();
  }

  async listEventsForEquipment(equipmentId: string): Promise<StoredEvent[]> {
    return this.collection.find({ equipmentId }).toArray();
  }
}

export class MongoEquipmentRepository implements EquipmentRepository {
  private readonly categoriesCollection: Collection<CategoryRecord>;
  private readonly equipmentCollection: Collection<EquipmentRecord>;

  constructor(db: Db) {
    this.categoriesCollection = db.collection<CategoryRecord>('categories');
    this.equipmentCollection = db.collection<EquipmentRecord>('equipment');
  }

  static async indexes(db: Db): Promise<void> {
    await db.collection('categories').createIndex({ id: 1, createdAt: -1 }, { unique: true });
    await db.collection('equipment').createIndex({ id: 1, createdAt: -1 }, { unique: true });
  }

  async insertCategory(category: CategoryRecord): Promise<void> {
    await this.categoriesCollection.insertOne(category);
  }

  async replaceCategory(category: CategoryRecord): Promise<void> {
    await this.categoriesCollection.insertOne(category);
  }

  async getCategory(id: string): Promise<CategoryRecord | null> {
    return this.categoriesCollection.findOne({ id, supersededAt: { $exists: false } });
  }

  async getCategoryAt(id: string, asOf: number): Promise<CategoryRecord | null> {
    const records = await this.categoriesCollection
      .find({
        id,
        createdAt: { $lte: asOf },
        $or: [{ supersededAt: { $exists: false } }, { supersededAt: { $gt: asOf } }]
      })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    return records[0] ?? null;
  }

  async listCategories(): Promise<CategoryRecord[]> {
    return this.categoriesCollection.find({ supersededAt: { $exists: false } }).toArray();
  }

  async insertEquipment(equipment: EquipmentRecord): Promise<void> {
    await this.equipmentCollection.insertOne(equipment);
  }

  async replaceEquipment(equipment: EquipmentRecord): Promise<void> {
    await this.equipmentCollection.insertOne(equipment);
  }

  async getEquipment(id: string): Promise<EquipmentRecord | null> {
    return this.equipmentCollection.find({ id, supersededAt: { $exists: false } }).next();
  }

  async getEquipmentAt(id: string, asOf: number): Promise<EquipmentRecord | null> {
    const records = await this.equipmentCollection
      .find({
        id,
        createdAt: { $lte: asOf },
        $or: [{ supersededAt: { $exists: false } }, { supersededAt: { $gt: asOf } }]
      })
      .sort({ createdAt: -1 })
      .limit(1)
      .toArray();
    return records[0] ?? null;
  }

  async listEquipment(): Promise<EquipmentRecord[]> {
    return this.equipmentCollection.find({ supersededAt: { $exists: false } }).toArray();
  }
}

export class MongoStructureRepository implements StructureRepository {
  private readonly collection: Collection<StructureVersion>;

  constructor(db: Db) {
    this.collection = db.collection<StructureVersion>('structure_versions');
  }

  static async indexes(db: Db): Promise<void> {
    await db.collection('structure_versions').createIndex({ id: 1 }, { unique: true });
    await db.collection('structure_versions').createIndex({ systemId: 1, effectiveFrom: 1 });
  }

  async insertVersion(version: StructureVersion): Promise<void> {
    await this.collection.insertOne(version);
  }

  async getVersion(id: string): Promise<StructureVersion | null> {
    return this.collection.findOne({ id });
  }

  async listVersions(systemId: string): Promise<StructureVersion[]> {
    return this.collection.find({ systemId }).sort({ effectiveFrom: 1 }).toArray();
  }

  async closeOpenVersion(systemId: string, effectiveTo: number, closedAt: number): Promise<void> {
    await this.collection.updateOne(
      { systemId, effectiveTo: null },
      { $set: { effectiveTo } }
    );
  }
}

export async function createMongoRepositories(client: MongoClient, dbName: string) {
  const db = client.db(dbName);
  await Promise.all([
    MongoEventRepository.indexes(db),
    MongoEquipmentRepository.indexes(db),
    MongoStructureRepository.indexes(db)
  ]);
  return {
    events: new MongoEventRepository(db),
    equipment: new MongoEquipmentRepository(db),
    structures: new MongoStructureRepository(db)
  };
}
