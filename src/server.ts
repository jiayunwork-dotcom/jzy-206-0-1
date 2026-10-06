import { MongoClient } from 'mongodb';
import { createApp } from './app.js';
import { createMongoRepositories } from './repositories/mongo.js';
import { AvailabilityService } from './service.js';

const port = Number(process.env.PORT ?? 3000);
const mongoUrl = process.env.MONGO_URL ?? 'mongodb://mongo:27017';
const dbName = process.env.MONGO_DB ?? 'availability';

async function main(): Promise<void> {
  const client = new MongoClient(mongoUrl, {
    serverSelectionTimeoutMS: 10_000
  });
  await client.connect();
  const repositories = await createMongoRepositories(client, dbName);
  const service = new AvailabilityService(
    repositories.events,
    repositories.equipment,
    repositories.structures
  );
  const app = createApp(service);

  const server = app.listen(port, () => {
    console.log(`Availability service listening on port ${port}, database ${dbName}`);
  });

  const shutdown = async () => {
    server.close(() => {
      void client.close().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('Failed to start service', error);
  process.exit(1);
});
