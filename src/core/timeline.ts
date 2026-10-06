import type {
  DeviceState,
  DeviceTimeline,
  EventType,
  StoredEvent,
  TimelineContradiction,
  TimelineSegment,
} from './types.js';

const HOUR_MS = 3_600_000;

/**
 * Same-timestamp events are intentionally not silently repaired.  This order is
 * only the deterministic tie-breaker; FAULT before REPAIR_START etc. is the
 * physically meaningful order.
 */
const TYPE_ORDER: Record<EventType, number> = {
  FAULT: 1,
  REPAIR_START: 2,
  REPAIR_END: 3,
  PLANNED_START: 4,
  PLANNED_END: 5,
  VOID: 6,
};

export function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / HOUR_MS;
}

export function effectiveEvents(events: StoredEvent[]): StoredEvent[] {
  const byId = new Map();
  for (const event of events) if (!byId.has(event.eventId)) byId.set(event.eventId, event);

  // Determine whether an event is voided. A VOID event applies only if it is
  // not itself voided by another effective VOID. Memoized DFS supports chains
  // such as "void the void", which reinstates the original target.
  const voided = new Set<string>();
  const states = new Map<string, 'visiting' | 'active' | 'inactive'>();
  const voidersOf = (targetId: string): StoredEvent[] =>
    events.filter((item) => item.type === 'VOID' && item.targetEventId === targetId);
  const isVoidActive = (voidEvent: StoredEvent): boolean => {
    const known = states.get(voidEvent.eventId);
    if (known === 'active') return true;
    if (known === 'inactive') return false;
    if (known === 'visiting') return false;
    states.set(voidEvent.eventId, 'visiting');
    const active = voidersOf(voidEvent.eventId).every((voider) => !isVoidActive(voider));
    states.set(voidEvent.eventId, active ? 'active' : 'inactive');
    return active;
  };
  for (const item of events) {
    if (item.type === 'VOID' && isVoidActive(item) && byId.has(item.targetEventId!)) {
      voided.add(item.targetEventId!);
    }
  }

  const inactive = new Set(voided);
  for (const event of events) {
    if (event.type === 'VOID' || !event.supersedesEventId || voided.has(event.eventId)) continue;
    const predecessor = byId.get(event.supersedesEventId);
    // Correction is represented as "void original + replacement". Before the
    // void is applied, suppress the replacement so exactly one copy is active.
    if (predecessor && !voided.has(predecessor.eventId)) inactive.add(event.eventId);
  }

  const seen = new Set<string>();
  return events
    .filter((event) => {
      if (seen.has(event.eventId)) return false;
      seen.add(event.eventId);
      return (
        event.type !== 'VOID' &&
        !inactive.has(event.eventId) &&
        event.deviceId !== null
      );
    })
    .sort(
      (a, b) =>
        Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
        TYPE_ORDER[a.type] - TYPE_ORDER[b.type] ||
        a.eventId.localeCompare(b.eventId),
    );
}

function contradiction(
  index: number,
  event: StoredEvent,
  state: DeviceState,
  code: TimelineContradiction['code'],
  message: string,
  action: string,
): TimelineContradiction {
  return {
    index,
    eventId: event.eventId,
    occurredAt: event.occurredAt,
    state,
    type: event.type,
    code,
    message,
    action,
  };
}

interface Transition {
  state: DeviceState;
  issue?: Omit<TimelineContradiction, 'index' | 'eventId' | 'occurredAt' | 'state' | 'type'>;
}

function transition(state: DeviceState, event: StoredEvent): Transition {
  switch (event.type) {
    case 'FAULT':
      if (state === 'UP') return { state: 'WAITING_REPAIR' };
      return {
        state,
        issue: {
          code: 'FAULT_WHILE_DOWN',
          message: `A fault was reported while equipment was already ${state}.`,
          action: 'Ignore the duplicate fault and retain the existing unclosed failure.',
        },
      };
    case 'REPAIR_START':
      if (state === 'UP')
        return {
          state: 'REPAIR',
          issue: {
            code: 'REPAIR_START_WITHOUT_FAULT',
            message: 'Repair started without a preceding waiting-for-repair fault.',
            action: 'Treat the repair start as a fault occurring at the same time.',
          },
        };
      if (state === 'WAITING_REPAIR') return { state: 'REPAIR' };
      if (state === 'REPAIR')
        return {
          state,
          issue: {
            code: 'REPAIR_START_WHILE_REPAIRING',
            message: 'Repair started again before the prior repair was closed.',
            action: 'Ignore the duplicate repair start.',
          },
        };
      return {
        state,
        issue: {
          code: 'REPAIR_START_WHILE_PLANNED',
          message: 'Repair started during a planned-maintenance interval.',
          action: 'Ignore the repair start and finish the planned interval first.',
        },
      };
    case 'REPAIR_END':
      if (state === 'WAITING_REPAIR') return { state: 'UP' };
      if (state === 'REPAIR') return { state: 'UP' };
      if (state === 'PLANNED')
        return {
          state,
          issue: {
            code: 'REPAIR_END_WHILE_PLANNED',
            message: 'Repair ended during an active planned-maintenance interval.',
            action: 'Ignore the event; the planned interval remains active.',
          },
        };
      return {
        state,
        issue: {
          code: 'REPAIR_END_WITHOUT_REPAIR',
          message: 'Repair ended while no failure repair was active.',
          action: 'Ignore the unmatched repair-end event.',
        },
      };
    case 'PLANNED_START':
      if (state === 'UP') return { state: 'PLANNED' };
      return {
        state,
        issue: {
          code: 'PLANNED_START_NOT_UP',
          message: 'Planned maintenance started while equipment was not running.',
          action: 'Ignore the planned-start event and retain the current state.',
        },
      };
    case 'PLANNED_END':
      if (state === 'PLANNED') return { state: 'UP' };
      return {
        state,
        issue: {
          code: 'PLANNED_END_NOT_PLANNED',
          message: 'Planned maintenance ended while no planned interval was active.',
          action: 'Ignore the unmatched planned-end event.',
        },
      };
    default:
      return { state };
  }
}

export function stateAfterEvents(events: StoredEvent[], atIso: string): DeviceState {
  const at = Date.parse(atIso);
  let state: DeviceState = 'UP';
  for (const event of events) {
    if (Date.parse(event.occurredAt) >= at) break;
    state = transition(state, event).state;
  }
  return state;
}

export function deriveTimeline(
  deviceId: string,
  sortedEvents: StoredEvent[],
  windowStart: string,
  windowEnd: string,
): DeviceTimeline {
  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  let state = stateAfterEvents(sortedEvents, windowStart);
  let segmentStart = start;
  const segments: TimelineSegment[] = [];
  const contradictions: TimelineContradiction[] = [];

  const closeSegment = (at: Date) => {
    const duration = hoursBetween(segmentStart, at);
    if (duration > 0) {
      segments.push({
        state,
        from: segmentStart.toISOString(),
        to: at.toISOString(),
        durationHours: duration,
      });
    }
  };

  sortedEvents.forEach((event, index) => {
    const at = new Date(event.occurredAt);
    if (at < start || at > end) return;
    const result = transition(state, event);
    if (result.issue) {
      contradictions.push(
        contradiction(
          index,
          event,
          state,
          result.issue.code,
          result.issue.message,
          result.issue.action,
        ),
      );
    }
    if (result.state !== state) {
      closeSegment(at);
      state = result.state;
      segmentStart = at;
    }
  });

  closeSegment(end);
  return { deviceId, segments, contradictions };
}

export interface FailureIncident {
  faultAt: Date;
  repairStartAt: Date | null;
  endAt: Date | null;
  closed: boolean;
}

export function deriveIncidents(sortedEvents: StoredEvent[]): FailureIncident[] {
  const incidents: FailureIncident[] = [];
  let current: FailureIncident | null = null;

  for (const event of sortedEvents) {
    const at = new Date(event.occurredAt);
    const stateBefore = current
      ? current.closed
        ? 'UP'
        : current.repairStartAt
          ? 'REPAIR'
          : 'WAITING_REPAIR'
      : 'UP';

    if (event.type === 'FAULT' && stateBefore === 'UP') {
      current = { faultAt: at, repairStartAt: null, endAt: null, closed: false };
      incidents.push(current);
    } else if (event.type === 'REPAIR_START') {
      if (stateBefore === 'UP') {
        current = {
          faultAt: at,
          repairStartAt: at,
          endAt: null,
          closed: false,
        };
        incidents.push(current);
      } else if (stateBefore === 'WAITING_REPAIR' && current) {
        current.repairStartAt = at;
      }
    } else if (event.type === 'REPAIR_END' && current && !current.closed) {
      current.repairStartAt ??= at;
      current.endAt = at;
      current.closed = true;
      current = null;
    }
  }
  return incidents;
}
