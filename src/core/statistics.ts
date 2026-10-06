import {
  deriveIncidents,
  deriveTimeline,
  effectiveEvents,
  hoursBetween,
} from './timeline.js';
import type {
  CensoringMethod,
  StoredEvent,
  WindowStatistics,
} from './types.js';

const HOUR_MS = 3_600_000;

interface Aggregates {
  operatingHours: number;
  waitingHours: number;
  repairHours: number;
  plannedHours: number;
}

function aggregateTimeline(timeline: ReturnType<typeof deriveTimeline>): Aggregates {
  const result: Aggregates = {
    operatingHours: 0,
    waitingHours: 0,
    repairHours: 0,
    plannedHours: 0,
  };
  for (const segment of timeline.segments) {
    if (segment.state === 'UP') result.operatingHours += segment.durationHours;
    if (segment.state === 'WAITING_REPAIR') result.waitingHours += segment.durationHours;
    if (segment.state === 'REPAIR') result.repairHours += segment.durationHours;
    if (segment.state === 'PLANNED') result.plannedHours += segment.durationHours;
  }
  return result;
}

function overlapHours(from: Date, to: Date, start: Date, end: Date): number {
  const left = from.getTime() > start.getTime() ? from : start;
  const right = to.getTime() < end.getTime() ? to : end;
  return Math.max(0, (right.getTime() - left.getTime()) / HOUR_MS);
}

function plannedHoursInRange(
  plannedSegments: readonly (readonly [Date, Date])[],
  from: Date,
  to: Date,
): number {
  return plannedSegments.reduce(
    (sum, [plannedFrom, plannedTo]) => sum + overlapHours(plannedFrom, plannedTo, from, to),
    0,
  );
}

export function calculateWindowStatistics(input: {
  deviceId: string;
  events: StoredEvent[];
  windowStart: string;
  windowEnd: string;
  plannedIsDowntime: boolean;
  method?: CensoringMethod;
}): WindowStatistics {
  const method = input.method ?? 'right_censored';
  const start = new Date(input.windowStart);
  const end = new Date(input.windowEnd);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Invalid statistics window date');
  }
  if (end.getTime() <= start.getTime()) {
    throw new Error('Window end must be later than window start');
  }

  const events = effectiveEvents(input.events);
  const timeline = deriveTimeline(input.deviceId, events, input.windowStart, input.windowEnd);
  const aggregates = aggregateTimeline(timeline);
  const plannedSegments = timeline.segments
    .filter((segment) => segment.state === 'PLANNED')
    .map((segment) => [new Date(segment.from), new Date(segment.to)] as const);
  const incidents = deriveIncidents(events);

  const censoredRepairs = incidents.filter(
    (incident) =>
      !incident.closed &&
      incident.faultAt.getTime() < end.getTime() &&
      incident.faultAt.getTime() >= start.getTime(),
  ).length;

  let faultCount = incidents.filter(
    (incident) =>
      incident.faultAt.getTime() >= start.getTime() &&
      incident.faultAt.getTime() < end.getTime(),
  ).length;
  let completedRepairCount = incidents.filter(
    (incident) =>
      incident.closed &&
      incident.endAt &&
      incident.endAt.getTime() >= start.getTime() &&
      incident.endAt.getTime() <= end.getTime(),
  ).length;

  let operatingHours = aggregates.operatingHours;
  let repairDownHours = aggregates.waitingHours + aggregates.repairHours;

  if (method === 'drop') {
    operatingHours = 0;
    repairDownHours = 0;
    faultCount = 0;
    completedRepairCount = 0;

    // Complete operating intervals only: repair-end -> next fault, entirely
    // inside [start,end). The initial and final intervals touch a boundary.
    for (let i = 1; i < incidents.length; i += 1) {
      const previous = incidents[i - 1];
      const current = incidents[i];
      if (
        previous.closed &&
        previous.endAt &&
        previous.endAt.getTime() >= start.getTime() &&
        current.faultAt.getTime() < end.getTime()
      ) {
        operatingHours += overlapHours(previous.endAt, current.faultAt, start, end);
        operatingHours -= plannedHoursInRange(
          plannedSegments,
          new Date(Math.max(previous.endAt.getTime(), start.getTime())),
          new Date(Math.min(current.faultAt.getTime(), end.getTime())),
        );
        faultCount += 1;
      }
    }

    // Complete repair intervals include fault->repair-end and must start and
    // close inside the window.
    for (const incident of incidents) {
      if (
        incident.closed &&
        incident.endAt &&
        incident.faultAt.getTime() >= start.getTime() &&
        incident.endAt.getTime() <= end.getTime()
      ) {
        repairDownHours += hoursBetween(incident.faultAt, incident.endAt);
        completedRepairCount += 1;
      }
    }
  }

  const activeRepairIncidents =
    method === 'right_censored'
      ? incidents.filter(
          (incident) =>
            incident.faultAt.getTime() < end.getTime() &&
            (!incident.endAt || incident.endAt.getTime() > start.getTime()),
        ).length
      : completedRepairCount;

  const mtbf = faultCount > 0 ? operatingHours / faultCount : null;
  const mttr = activeRepairIncidents > 0 ? repairDownHours / activeRepairIncidents : null;
  const availableClock =
    aggregates.operatingHours +
    aggregates.waitingHours +
    aggregates.repairHours +
    (input.plannedIsDowntime ? aggregates.plannedHours : 0);
  const observedAvailability =
    availableClock === 0 ? 1 : aggregates.operatingHours / availableClock;
  const steadyStateAvailability =
    mtbf === null || mttr === null ? null : mtbf / (mtbf + mttr);

  const endState = timeline.segments.at(-1)?.state ?? 'UP';

  return {
    deviceId: input.deviceId,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    method,
    plannedIsDowntime: input.plannedIsDowntime,
    operatingHours,
    waitingHours: aggregates.waitingHours,
    repairHours: aggregates.repairHours,
    plannedHours: aggregates.plannedHours,
    faultCount,
    completedRepairCount,
    censoredFaults: endState === 'UP' ? 1 : 0,
    censoredRepairs,
    mtbf,
    mttr,
    observedAvailability,
    steadyStateAvailability,
  };
}
