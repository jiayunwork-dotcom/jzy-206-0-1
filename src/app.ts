import express, { type Application, type Request, type Response, type NextFunction } from 'express';
import { AppError } from './errors.js';
import { AvailabilityService } from './service.js';
import {
  normalizeEventBatch,
  normalizeEventInput,
  requireBoolean,
  requireString,
  requireTimestamp,
  validateWindow
} from './validation.js';
import type { Timeline, TruncationMethod } from './types.js';

const asyncHandler = (handler: (request: Request, response: Response) => Promise<unknown>) =>
  (request: Request, response: Response, next: NextFunction) => {
    handler(request, response).catch(next);
  };

function serializeTimeline(timeline: Timeline) {
  return {
    ...timeline,
    intervals: timeline.intervals.map((interval) => ({
      ...interval,
      end: interval.open ? null : interval.end
    }))
  };
}

function parseWindow(body: Request['body']) {
  return validateWindow(body.windowStart, body.windowEnd);
}

function parseOptionalAsOfQuery(request: Request): number | undefined {
  if (request.query.asOf === undefined) return undefined;
  return requireTimestamp(Number(request.query.asOf), 'asOf');
}

function parseTruncation(value: unknown): TruncationMethod | undefined {
  if (value === undefined) return undefined;
  if (value === 'censored' || value === 'discard') return value;
  throw new AppError(400, 'INVALID_REQUEST', 'truncationMethod must be censored or discard');
}

export function createApp(service: AvailabilityService): Application {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_request, response) => response.json({ ok: true }));

  // Categories
  app.post(
    '/categories',
    asyncHandler(async (request, response) => {
      const name = requireString(request.body.name, 'name');
      const plannedMaintenanceAsDowntime = requireBoolean(
        request.body.plannedMaintenanceAsDowntime,
        'plannedMaintenanceAsDowntime'
      );
      const id = request.body.id === undefined ? undefined : requireString(request.body.id, 'id');
      response.status(201).json(await service.createCategory({ id, name, plannedMaintenanceAsDowntime }));
    })
  );

  app.get('/categories', asyncHandler(async (_request, response) => response.json(await service.listCategories())));

  app.patch(
    '/categories/:id',
    asyncHandler(async (request, response) => {
      const patch: { name?: string; plannedMaintenanceAsDowntime?: boolean } = {};
      if (request.body.name !== undefined) patch.name = requireString(request.body.name, 'name');
      if (request.body.plannedMaintenanceAsDowntime !== undefined) {
        patch.plannedMaintenanceAsDowntime = requireBoolean(
          request.body.plannedMaintenanceAsDowntime,
          'plannedMaintenanceAsDowntime'
        );
      }
      response.json(await service.updateCategory(request.params.id!, patch));
    })
  );

  // Equipment
  app.post(
    '/equipment',
    asyncHandler(async (request, response) => {
      const name = requireString(request.body.name, 'name');
      const categoryId = requireString(request.body.categoryId, 'categoryId');
      const id = request.body.id === undefined ? undefined : requireString(request.body.id, 'id');
      response.status(201).json(await service.createEquipment({ id, name, categoryId }));
    })
  );

  app.get('/equipment', asyncHandler(async (_request, response) => response.json(await service.listEquipment())));

  app.patch(
    '/equipment/:id',
    asyncHandler(async (request, response) => {
      const patch: { name?: string; categoryId?: string } = {};
      if (request.body.name !== undefined) patch.name = requireString(request.body.name, 'name');
      if (request.body.categoryId !== undefined) {
        patch.categoryId = requireString(request.body.categoryId, 'categoryId');
      }
      response.json(await service.updateEquipment(request.params.id!, patch));
    })
  );

  // Events
  app.post(
    '/events',
    asyncHandler(async (request, response) => {
      const input = normalizeEventInput(request.body, Date.now());
      const result = await service.submitEvent(input);
      response.status(201).json(result);
    })
  );

  app.post(
    '/events/batch',
    asyncHandler(async (request, response) => {
      const inputs = normalizeEventBatch(request.body.events, Date.now());
      response.status(201).json({ results: await service.submitBatch(inputs) });
    })
  );

  app.patch(
    '/events/:eventId/correction',
    asyncHandler(async (request, response) => {
      const patch: { time?: number; equipmentId?: string; type?: 'failure' | 'repair_start' | 'repair_end' | 'planned_start' | 'planned_end' } = {
        ...(request.body.time === undefined ? {} : { time: requireTimestamp(request.body.time, 'time') }),
        ...(request.body.equipmentId === undefined
          ? {}
          : { equipmentId: requireString(request.body.equipmentId, 'equipmentId') }),
        ...(request.body.type === undefined
          ? {}
          : (() => {
              if (typeof request.body.type !== 'string' || !['failure', 'repair_start', 'repair_end', 'planned_start', 'planned_end'].includes(request.body.type)) {
                throw new AppError(400, 'INVALID_REQUEST', 'unknown event type');
              }
              return { type: request.body.type as 'failure' | 'repair_start' | 'repair_end' | 'planned_start' | 'planned_end' };
            })())
      };
      const recordedAt =
        request.body.recordedAt === undefined ? undefined : requireTimestamp(request.body.recordedAt, 'recordedAt');
      response.json(await service.correctEvent(request.params.eventId!, patch, recordedAt));
    })
  );

  app.get(
    '/equipment/:equipmentId/timeline',
    asyncHandler(async (request, response) => {
      const asOf = parseOptionalAsOfQuery(request);
      response.json(serializeTimeline(await service.getTimeline(request.params.equipmentId!, { asOf })));
    })
  );

  app.get(
    '/equipment/:equipmentId/contradictions',
    asyncHandler(async (request, response) => {
      const asOf = parseOptionalAsOfQuery(request);
      const timeline = await service.getTimeline(request.params.equipmentId!, { asOf });
      response.json({ contradictions: timeline.contradictions });
    })
  );

  // Statistics
  app.post(
    '/equipment/:equipmentId/statistics',
    asyncHandler(async (request, response) => {
      const window = parseWindow(request.body);
      const asOf = request.body.asOf === undefined ? undefined : requireTimestamp(request.body.asOf, 'asOf');
      response.json(
        await service.getWindowStatistics({
          equipmentId: request.params.equipmentId!,
          windowStart: window.start,
          windowEnd: window.end,
          asOf,
          truncationMethod: parseTruncation(request.body.truncationMethod)
        })
      );
    })
  );

  app.post(
    '/equipment/:equipmentId/recalculation-comparison',
    asyncHandler(async (request, response) => {
      const window = parseWindow(request.body);
      const earlierAsOf = requireTimestamp(request.body.earlierAsOf, 'earlierAsOf');
      const asOf = request.body.asOf === undefined ? undefined : requireTimestamp(request.body.asOf, 'asOf');
      response.json(
        await service.compareWindowAt({
          equipmentId: request.params.equipmentId!,
          windowStart: window.start,
          windowEnd: window.end,
          earlierAsOf,
          asOf,
          truncationMethod: parseTruncation(request.body.truncationMethod)
        })
      );
    })
  );

  // Reliability block diagrams
  app.post(
    '/systems/:systemId/structure-versions',
    asyncHandler(async (request, response) => {
      const effectiveFrom =
        request.body.effectiveFrom === undefined || request.body.effectiveFrom === null
          ? null
          : requireTimestamp(request.body.effectiveFrom, 'effectiveFrom');
      const id = request.body.id === undefined ? undefined : requireString(request.body.id, 'id');
      const asOf = request.body.asOf === undefined ? undefined : requireTimestamp(request.body.asOf, 'asOf');
      response
        .status(201)
        .json(
          await service.addStructureVersion({
            systemId: request.params.systemId!,
            root: request.body.root,
            effectiveFrom,
            id,
            asOf
          })
        );
    })
  );

  app.post(
    '/systems/:systemId/availability',
    asyncHandler(async (request, response) => {
      const window = parseWindow(request.body);
      const asOf = request.body.asOf === undefined ? undefined : requireTimestamp(request.body.asOf, 'asOf');
      response.json(
        await service.getSystemAvailability({
          systemId: request.params.systemId!,
          windowStart: window.start,
          windowEnd: window.end,
          asOf,
          truncationMethod: parseTruncation(request.body.truncationMethod)
        })
      );
    })
  );

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
      return;
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    response.status(500).json({ error: { code: 'INTERNAL_ERROR', message } });
  });

  return app;
}
