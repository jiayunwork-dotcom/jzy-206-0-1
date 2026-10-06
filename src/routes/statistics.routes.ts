import { Router } from 'express';
import type { Services } from '../container.js';
import type { CensoringMethod } from '../core/types.js';
import { asyncHandler } from './async-handler.js';

export function statisticsRouter(services: Services): Router {
  const router = Router();

  router.get('/statistics/windows', asyncHandler(async (req, res) => {
    const { start, end, asOf, method, freeze } = req.query;
    if (typeof start !== 'string' || typeof end !== 'string') {
      res.status(400).json({ error: 'start and end query parameters are required' });
      return;
    }
    const censoring: CensoringMethod | undefined =
      method === 'right_censored' || method === 'drop' ? method : undefined;
    res.json(await services.statistics.forAll(start, end, {
      asOf: typeof asOf === 'string' ? asOf : undefined,
      method: censoring,
      freeze: freeze === 'true' && typeof asOf === 'string',
    }));
  }));

  router.get('/devices/:id/statistics', asyncHandler(async (req, res) => {
    const { start, end, asOf, method, plannedIsDowntime, freeze } = req.query;
    if (typeof start !== 'string' || typeof end !== 'string') {
      res.status(400).json({ error: 'start and end query parameters are required' });
      return;
    }
    res.json(
      await services.statistics.forDevice(req.params.id, start, end, {
        asOf: typeof asOf === 'string' ? asOf : undefined,
        method: method === 'drop' ? 'drop' : 'right_censored',
        plannedIsDowntime:
          plannedIsDowntime === 'true'
            ? true
            : plannedIsDowntime === 'false'
              ? false
              : undefined,
        freeze: freeze === 'true',
      }),
    );
  }));

  return router;
}
