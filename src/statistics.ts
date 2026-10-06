import { hours } from './time.js';
import type {
  DurationSummary,
  EquipmentState,
  MaintenanceEvent,
  Timeline,
  TimelineInterval,
  TruncationMethod,
  WindowStatistics
} from './types.js';

function clippedIntervalHours(interval: TimelineInterval, windowStart: number, windowEnd: number): number {
  const start = Math.max(interval.start, windowStart);
  const end = Math.min(interval.end, windowEnd);
  return end > start ? hours(end - start) : 0;
}

function summarizeDurations(
  timeline: Timeline,
  plannedAsDowntime: boolean,
  windowStart: number,
  windowEnd: number
): DurationSummary {
  const durations: DurationSummary = {
    runningHours: 0,
    waitingRepairHours: 0,
    underRepairHours: 0,
    plannedMaintenanceHours: 0,
    unavailableHours: 0,
    windowHours: hours(windowEnd - windowStart)
  };

  let knownHours = 0;
  for (const interval of timeline.intervals) {
    const duration = clippedIntervalHours(interval, windowStart, windowEnd);
    knownHours += duration;
    if (interval.state === 'running') durations.runningHours += duration;
    if (interval.state === 'waiting_repair') durations.waitingRepairHours += duration;
    if (interval.state === 'under_repair') durations.underRepairHours += duration;
    if (interval.state === 'planned_maintenance') durations.plannedMaintenanceHours += duration;
  }

  // Time before the first known event and after the last event is assumed running.
  durations.runningHours += Math.max(0, durations.windowHours - knownHours);

  durations.unavailableHours =
    durations.waitingRepairHours +
    durations.underRepairHours +
    (plannedAsDowntime ? durations.plannedMaintenanceHours : 0);

  return durations;
}

function acceptedFailureEvents(timeline: Timeline, events: MaintenanceEvent[], windowStart: number, windowEnd: number) {
  const ignored = new Set(timeline.ignoredEventIds);
  return events.filter(
    (event) =>
      !event.voided &&
      !ignored.has(event.eventId) &&
      event.type === 'failure' &&
      event.time >= windowStart &&
      event.time < windowEnd
  );
}

function estimateCensored(
  timeline: Timeline,
  events: MaintenanceEvent[],
  durations: DurationSummary,
  windowStart: number,
  windowEnd: number
) {
  const failures = acceptedFailureEvents(timeline, events, windowStart, windowEnd);

  let completedRepairs = 0;
  for (const interval of timeline.intervals) {
    if (
      interval.state === 'under_repair' &&
      Number.isFinite(interval.end) &&
      interval.end > interval.start &&
      interval.end <= windowEnd &&
      interval.end > windowStart &&
      interval.start < windowEnd
    ) {
      completedRepairs += 1;
    }
  }

  const openRepairs = timeline.intervals.filter(
    (interval) =>
      interval.state === 'under_repair' &&
      interval.open &&
      interval.end > interval.start &&
      interval.start < windowEnd &&
      (Number.isFinite(interval.end) ? interval.end > windowStart : true)
  ).length;

  // Type I right censoring: an open repair contributes its observed exposure and
  // one item at risk. Its eventual duration is unknown, so it is not treated complete.
  const repairItemsAtRisk = completedRepairs + openRepairs;

  return {
    failureCount: failures.length,
    completedRepairCount: completedRepairs,
    rightCensoredRepairCount: openRepairs,
    mtbf: failures.length > 0 ? durations.runningHours / failures.length : null,
    mttr: repairItemsAtRisk > 0 ? durations.underRepairHours / repairItemsAtRisk : null
  };
}

function estimateDiscard(
  timeline: Timeline,
  events: MaintenanceEvent[],
  windowStart: number,
  windowEnd: number
) {
  const failures = acceptedFailureEvents(timeline, events, windowStart, windowEnd);
  let runningTerminatedByFailureHours = 0;
  let runningTerminatedByFailureCount = 0;
  let completeRepairHours = 0;
  let completeRepairCount = 0;

  if (
    timeline.intervals[0]?.state === 'waiting_repair' &&
    timeline.intervals[0].start > windowStart &&
    events.some(
      (event) =>
        event.type === 'failure' &&
        event.time === timeline.intervals[0]!.start &&
        !timeline.ignoredEventIds.includes(event.eventId)
    )
  ) {
    runningTerminatedByFailureHours += hours(timeline.intervals[0].start - windowStart);
    runningTerminatedByFailureCount += 1;
  }

  if (
    timeline.intervals[0]?.state === 'running' &&
    timeline.intervals[1]?.state === 'waiting_repair' &&
    timeline.intervals[0].start > windowStart
  ) {
    runningTerminatedByFailureHours += hours(timeline.intervals[0].end - windowStart);
    runningTerminatedByFailureCount += 1;
  }

  for (let index = 0; index < timeline.intervals.length; index += 1) {
    const interval = timeline.intervals[index]!;
    const next = timeline.intervals[index + 1];

    if (
      interval.state === 'running' &&
      next?.state === 'waiting_repair' &&
      interval.end > interval.start &&
      interval.start >= windowStart &&
      interval.end < windowEnd
    ) {
      runningTerminatedByFailureHours += hours(interval.end - interval.start);
      runningTerminatedByFailureCount += 1;
    }

    if (
      interval.state === 'under_repair' &&
      next?.state === 'running' &&
      interval.end > interval.start &&
      interval.start >= windowStart &&
      interval.end < windowEnd
    ) {
      completeRepairHours += hours(interval.end - interval.start);
      completeRepairCount += 1;
    }
  }

  return {
    failureCount: failures.length,
    completedRepairCount: completeRepairCount,
    rightCensoredRepairCount: timeline.intervals.filter(
      (interval) =>
        interval.state === 'under_repair' &&
        interval.open &&
        interval.start < windowEnd &&
        (Number.isFinite(interval.end) ? interval.end > windowStart : true)
    ).length,
    mtbf:
      runningTerminatedByFailureCount > 0
        ? runningTerminatedByFailureHours / runningTerminatedByFailureCount
        : null,
    mttr: completeRepairCount > 0 ? completeRepairHours / completeRepairCount : null
  };
}

function completedWaitingCount(timeline: Timeline, windowStart: number, windowEnd: number): number {
  let count = 0;
  for (const interval of timeline.intervals) {
    if (
      interval.state === 'waiting_repair' &&
      Number.isFinite(interval.end) &&
      interval.end > interval.start &&
      interval.end > windowStart &&
      interval.end <= windowEnd
    ) {
      count += 1;
    }
  }
  return count;
}

export function calculateWindowStatistics(input: {
  equipmentId: string;
  timeline: Timeline;
  events: MaintenanceEvent[];
  windowStart: number;
  windowEnd: number;
  plannedMaintenanceAsDowntime: boolean;
  truncationMethod?: TruncationMethod;
}): WindowStatistics {
  const method = input.truncationMethod ?? 'censored';
  const durations = summarizeDurations(
    input.timeline,
    input.plannedMaintenanceAsDowntime,
    input.windowStart,
    input.windowEnd
  );

  const estimates =
    method === 'discard'
      ? estimateDiscard(input.timeline, input.events, input.windowStart, input.windowEnd)
      : estimateCensored(input.timeline, input.events, durations, input.windowStart, input.windowEnd);

  // Availability is an observed state proportion over the whole window and is never
  // computed by discarding the censored edge. The truncation option affects MTBF/MTTR.
  const steadyStateAvailability =
    durations.windowHours > 0
      ? (durations.runningHours +
          (input.plannedMaintenanceAsDowntime ? 0 : durations.plannedMaintenanceHours)) /
        durations.windowHours
      : null;

  const inherentAvailability =
    estimates.mtbf !== null && estimates.mttr !== null && estimates.mtbf + estimates.mttr > 0
      ? estimates.mtbf / (estimates.mtbf + estimates.mttr)
      : null;

  const waitsCompleted = completedWaitingCount(input.timeline, input.windowStart, input.windowEnd);

  return {
    equipmentId: input.equipmentId,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    truncationMethod: method,
    mtbfHours: estimates.mtbf === null ? null : Math.max(0, estimates.mtbf),
    mttrHours: estimates.mttr === null ? null : Math.max(0, estimates.mttr),
    meanWaitingTimeHours:
      waitsCompleted > 0 ? durations.waitingRepairHours / waitsCompleted : null,
    steadyStateAvailability:
      steadyStateAvailability === null ? null : Math.min(1, Math.max(0, steadyStateAvailability)),
    inherentAvailability,
    failureCount: estimates.failureCount,
    completedRepairCount: estimates.completedRepairCount,
    rightCensoredRepairCount: estimates.rightCensoredRepairCount,
    durations
  };
}
