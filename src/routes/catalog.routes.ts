import { Router } from 'express';
import type { Services } from '../container.js';
import { asyncHandler } from './async-handler.js';

export function catalogRouter(services: Services): Router {
  const router = Router();

  router.get('/categories', asyncHandler(async (_req, res) => {
    res.json(await services.catalog.listCategories());
  }));

  router.post('/categories', asyncHandler(async (req, res) => {
    const { name, plannedIsDowntime } = req.body ?? {};
    if (typeof name !== 'string' || !name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (typeof plannedIsDowntime !== 'boolean') {
      res.status(400).json({ error: 'plannedIsDowntime must be boolean' });
      return;
    }
    res.status(201).json(await services.catalog.createCategory({ name, plannedIsDowntime }));
  }));

  router.get('/devices', asyncHandler(async (_req, res) => {
    res.json(await services.catalog.listDevices());
  }));

  router.post('/devices', asyncHandler(async (req, res) => {
    const { code, name, categoryId } = req.body ?? {};
    if (!code || !name || !categoryId) {
      res.status(400).json({ error: 'code, name and categoryId are required' });
      return;
    }
    res.status(201).json(await services.catalog.createDevice({ code, name, categoryId }));
  }));

  router.get('/devices/:id', asyncHandler(async (req, res) => {
    res.json(await services.catalog.getDevice(req.params.id));
  }));

  return router;
}
