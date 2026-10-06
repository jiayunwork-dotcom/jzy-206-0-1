import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { ApiError } from './core/errors.js';
import { createServices, type Services } from './container.js';
import { catalogRouter } from './routes/catalog.routes.js';
import { eventRouter } from './routes/event.routes.js';
import { timelineRouter } from './routes/timeline.routes.js';
import { statisticsRouter } from './routes/statistics.routes.js';
import { structureRouter } from './routes/structure.routes.js';
import { asOfRouter } from './routes/asof.routes.js';

export function createApp(services: Services): Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use('/api', catalogRouter(services));
  app.use('/api', eventRouter(services));
  app.use('/api', timelineRouter(services));
  app.use('/api', statisticsRouter(services));
  app.use('/api', structureRouter(services));
  app.use('/api', asOfRouter(services));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.status).json({ error: error.message, details: error.details });
      return;
    }
    const message = error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ error: message });
  });

  return app;
}

export async function createApplicationWithServices(): Promise<{ app: Express; services: Services }> {
  const services = await createServices();
  return { app: createApp(services), services };
}
