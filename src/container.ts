import { InMemoryRepository, type DeviceRepository } from './storage/repository.js';
import { MongoRepository } from './storage/mongo-repository.js';
import { CatalogService } from './services/catalog.service.js';
import { EventService } from './services/event.service.js';
import { TimelineService } from './services/timeline.service.js';
import { StatisticsService } from './services/statistics.service.js';
import { StructureService } from './services/structure.service.js';
import { AsOfService } from './services/asof.service.js';

export interface Services {
  repo: DeviceRepository;
  catalog: CatalogService;
  events: EventService;
  timeline: TimelineService;
  statistics: StatisticsService;
  structures: StructureService;
  asOf: AsOfService;
}

export async function createServices(repository?: DeviceRepository): Promise<Services> {
  const repo =
    repository ??
    (process.env.MONGO_URL
      ? new MongoRepository(process.env.MONGO_URL, process.env.MONGO_DB)
      : new InMemoryRepository());
  await repo.init();
  return {
    repo,
    catalog: new CatalogService(repo),
    events: new EventService(repo),
    timeline: new TimelineService(repo),
    statistics: new StatisticsService(repo),
    structures: new StructureService(repo),
    asOf: new AsOfService(repo),
  };
}
