import type {
  EquipmentState,
  MaintenanceEvent,
  Timeline,
  TimelineContradiction,
  TimelineInterval
} from './types.js';

type RankedEvent = MaintenanceEvent & { rank: number };

/**
 * Events at the same timestamp are processed in this deterministic order.
 * Completions precede a new failure; a failure precedes its repair start;
 * an active repair takes precedence over a planned-maintenance start.
 */
const EVENT_RANK: Record<MaintenanceEvent['type'], number> = {
  repair_end: 1,
  planned_end: 2,
  failure: 3,
  repair_start: 4,
  planned_start: 5
};

const CONTRADICTION_MESSAGES = {
  failure_already_failed: 'A failure was already open and repair had not started.',
  failure_during_repair: 'A failure was reported while an active repair was already open.',
  repair_start_without_failure: 'Repair started while the equipment was already running.',
  repair_start_while_repairing: 'Repair started while a repair was already in progress.',
  repair_end_without_repair: 'Repair ended without an in-progress repair.',
  planned_start_while_planned: 'Planned maintenance started while planned maintenance was already open.',
  planned_start_during_repair: 'Planned maintenance cannot start while corrective repair is active.',
  planned_start_while_failed: 'Planned maintenance cannot start while a failure is waiting for repair.',
  planned_end_without_planned: 'Planned maintenance ended without an open planned-maintenance interval.',
  planned_end_during_repair: 'The planned interval was preempted by corrective repair; its end event is ignored.'
} as const;

type AcceptedTransition =
  | { accepted: true; next: EquipmentState }
  | { accepted: false; code: TimelineContradiction['code'] };

function transition(state: EquipmentState, type: MaintenanceEvent['type']): AcceptedTransition {
  switch (state) {
    case 'running':
      if (type === 'failure') return { accepted: true, next: 'waiting_repair' };
      if (type === 'planned_start') return { accepted: true, next: 'planned_maintenance' };
      if (type === 'repair_start')
        return { accepted: false, code: 'repair_start_without_failure' };
      if (type === 'repair_end') return { accepted: false, code: 'repair_end_without_repair' };
      return { accepted: false, code: 'planned_end_without_planned' };
    case 'waiting_repair':
      if (type === 'repair_start') return { accepted: true, next: 'under_repair' };
      if (type === 'failure') return { accepted: false, code: 'failure_already_failed' };
      if (type === 'planned_start') return { accepted: false, code: 'planned_start_while_failed' };
      if (type === 'repair_end') return { accepted: false, code: 'repair_end_without_repair' };
      return { accepted: false, code: 'planned_end_without_planned' };
    case 'under_repair':
      if (type === 'repair_end') return { accepted: true, next: 'running' };
      if (type === 'failure') return { accepted: false, code: 'failure_during_repair' };
      if (type === 'repair_start') return { accepted: false, code: 'repair_start_while_repairing' };
      if (type === 'planned_start') return { accepted: false, code: 'planned_start_during_repair' };
      return { accepted: false, code: 'planned_end_during_repair' };
    case 'planned_maintenance':
      if (type === 'planned_end') return { accepted: true, next: 'running' };
      // Corrective work takes priority over planned work. The planned interval is closed
      // at this timestamp; any later planned_end is contradictory and ignored.
      if (type === 'failure') return { accepted: true, next: 'waiting_repair' };
      if (type === 'repair_start') return { accepted: true, next: 'under_repair' };
      if (type === 'repair_end') return { accepted: false, code: 'repair_end_without_repair' };
      return { accepted: false, code: 'planned_start_while_planned' };
  }
}

function sortEffectiveEvents(events: MaintenanceEvent[]): RankedEvent[] {
  return [...events]
    .filter((event) => !event.voided)
    .sort((a, b) =>
      a.time - b.time ||
      EVENT_RANK[a.type] - EVENT_RANK[b.type] ||
      a.recordedAt - b.recordedAt ||
      a.eventId.localeCompare(b.eventId)
    )
    .map((event) => ({ ...event, rank: EVENT_RANK[event.type] }));
}

function closeInterval(intervals: TimelineInterval[], end: number): void {
  const current = intervals.at(-1);
  if (current && current.open) {
    current.end = end;
    current.open = false;
  }
}

/**
 * Pure reconstruction. The result is always equivalent to taking all currently
 * effective events, sorting them by timestamp, and replaying them from scratch.
 */
export function deriveTimeline(equipmentId: string, effectiveEvents: MaintenanceEvent[]): Timeline {
  const intervals: TimelineInterval[] = [];
  const contradictions: TimelineContradiction[] = [];
  const ignoredEventIds: string[] = [];
  let state: EquipmentState | null = null;

  for (const event of sortEffectiveEvents(effectiveEvents)) {
    if (state === null) {
      state = 'running';
      intervals.push({ state, start: event.time, end: event.time, open: true });
    }

    const result = transition(state, event.type);
    if (!result.accepted) {
      contradictions.push({
        code: result.code,
        eventId: event.eventId,
        equipmentId,
        time: event.time,
        state,
        message: CONTRADICTION_MESSAGES[result.code]
      });
      ignoredEventIds.push(event.eventId);
      continue;
    }

    closeInterval(intervals, event.time);
    state = result.next;
    intervals.push({ state, start: event.time, end: event.time, open: true });
  }

  const last = intervals.at(-1);
  if (last?.open) {
    last.end = Number.POSITIVE_INFINITY;
  }

  return { equipmentId, intervals, contradictions, ignoredEventIds };
}
