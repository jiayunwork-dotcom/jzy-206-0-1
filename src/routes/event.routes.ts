import { Router } from 'express';
import type { Services } from '../container.js';
import { asyncHandler } from './async-handler.js';

export function eventRouter(services: Services): Router {
  const router = Router();

  router.post('/events', asyncHandler(async (req, res) => {
    const result = await services.events.submit(req.body);
    res.status(result.duplicate ? 200 : 201).json(result);
  }));

  router.post('/events/batch', asyncHandler(async (req, res) => {
    if (!Array.isArray(req.body?.events)) {
      res.status(400).json({ error: 'events array is required' });
      return;
    }
    const results = await services.events.submitBatch(req.body.events);
    const rejected = results.some((item) => item.error);
    res.status(rejected ? 207 : 201).json({ results });
  }));

  router.post('/events/:id/corrections', asyncHandler(async (req, res) => {
    const event = await services.events.correctEvent(req.params.id, req.body);
    res.status(201).json(event);
  }));

  router.get('/events/:id', asyncHandler(async (req, res) => {
    const event = await services.repo.getEvent(req.params.id);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    res.json(event);
  }));

  return router;
}
