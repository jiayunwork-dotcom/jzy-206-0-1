import { Router } from 'express';
import type { Services } from '../container.js';
import { asyncHandler } from './async-handler.js';

export function structureRouter(services: Services): Router {
  const router = Router();

  router.get('/systems', asyncHandler(async (_req, res) => {
    res.json(await services.repo.listSystems());
  }));

  router.get('/systems/:systemId/versions', asyncHandler(async (req, res) => {
    res.json(await services.structures.listVersions(
      req.params.systemId,
      typeof req.query.asOf === 'string' ? req.query.asOf : undefined,
    ));
  }));

  router.post('/systems/:systemId/versions', asyncHandler(async (req, res) => {
    const version = await services.structures.createVersion(req.params.systemId, req.body);
    res.status(201).json(version);
  }));

  router.get('/systems/:systemId/availability', asyncHandler(async (req, res) => {
    const { start, end, asOf, method } = req.query;
    if (typeof start !== 'string' || typeof end !== 'string') {
      res.status(400).json({ error: 'start and end query parameters are required' });
      return;
    }
    const asOfValue = typeof asOf === 'string' ? asOf : undefined;
    const stats = await services.statistics.forAll(start, end, {
      asOf: asOfValue,
      method: method === 'drop' ? 'drop' : 'right_censored',
    });
    res.json(await services.structures.systemAvailability(
      req.params.systemId,
      start,
      end,
      stats,
      asOfValue,
    ));
  }));

  return router;
}
