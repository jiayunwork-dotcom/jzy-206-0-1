import { Router } from 'express';
import type { Services } from '../container.js';
import { asyncHandler } from './async-handler.js';

export function asOfRouter(services: Services): Router {
  const router = Router();

  router.get('/recalculations', asyncHandler(async (req, res) => {
    const { start, end, asOf, method } = req.query;
    if (typeof start !== 'string' || typeof end !== 'string' || typeof asOf !== 'string') {
      res.status(400).json({ error: 'start, end and asOf are required' });
      return;
    }
    res.json(await services.asOf.recalculateWindow(
      start,
      end,
      asOf,
      method === 'drop' ? 'drop' : 'right_censored',
    ));
  }));

  router.get('/recalculations/diff', asyncHandler(async (req, res) => {
    const { start, end, baselineAsOf, currentAsOf, method } = req.query;
    if (
      typeof start !== 'string' ||
      typeof end !== 'string' ||
      typeof baselineAsOf !== 'string' ||
      typeof currentAsOf !== 'string'
    ) {
      res.status(400).json({ error: 'start, end, baselineAsOf and currentAsOf are required' });
      return;
    }
    res.json(await services.asOf.compare(
      start,
      end,
      baselineAsOf,
      currentAsOf,
      method === 'drop' ? 'drop' : 'right_censored',
    ));
  }));

  return router;
}
