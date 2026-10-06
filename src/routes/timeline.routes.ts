import { Router } from 'express';
import type { Services } from '../container.js';
import { asyncHandler } from './async-handler.js';

export function timelineRouter(services: Services): Router {
  const router = Router();

  router.get('/devices/:id/timeline', asyncHandler(async (req, res) => {
    const { start, end, asOf } = req.query;
    res.json(
      await services.timeline.getTimeline(req.params.id, {
        start: typeof start === 'string' ? start : undefined,
        end: typeof end === 'string' ? end : undefined,
        asOf: typeof asOf === 'string' ? asOf : undefined,
      }),
    );
  }));

  router.get('/contradictions', asyncHandler(async (req, res) => {
    const { start, end, asOf } = req.query;
    res.json(
      await services.timeline.listContradictions({
        start: typeof start === 'string' ? start : undefined,
        end: typeof end === 'string' ? end : undefined,
        asOf: typeof asOf === 'string' ? asOf : undefined,
      }),
    );
  }));

  return router;
}
