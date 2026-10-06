export type EventType =
  | 'failure'
  | 'repair_start'
  | 'repair_end'
  | 'planned_start'
  | 'planned_end'
  | 'void_event';

export type EquipmentState = 'running' | 'waiting_repair' | 'under_repair' | 'planned_maintenance';

export type TruncationMethod = 'censored' | 'discard';

export type MaintenanceTreatment = 'downtime' | 'available';

export type RbdNode =
  | { type: 'equipment'; equipmentId: string }
  | { type: 'series'; children: RbdNode[] }
  | { type: 'parallel'; children: RbdNode[] }
  | { type: 'k_of_n'; k: number; n: number; children: RbdNode[] };

export interface Category {
  id: string;
  name: string;
  plannedMaintenanceAsDowntime: boolean;
}

export interface CategoryRecord extends Category {
  createdAt: number;
  supersededAt?: number;
}

export interface Equipment {
  id: string;
  name: string;
  categoryId: string;
}

export interface EquipmentRecord extends Equipment {
  createdAt: number;
  supersededAt?: number;
}

export interface EventRevision {
  revision: number;
  equipmentId: string;
  time: number;
  type: Exclude<EventType, 'void_event'>;
  recordedAt: number;
}

export interface MaintenanceEvent {
  eventId: string;
  equipmentId: string;
  time: number;
  type: Exclude<EventType, 'void_event'>;
  recordedAt: number;
  revision: number;
  revisions: EventRevision[];
  voided?: boolean;
  voidedAt?: number;
  originalEventId?: string;
}

export interface VoidEvent {
  eventId: string;
  equipmentId: string;
  time: number;
  type: 'void_event';
  recordedAt: number;
  targetEventId: string;
}

export type StoredEvent = MaintenanceEvent | VoidEvent;

export interface EventInput {
  eventId: string;
  equipmentId: string;
  time: number;
  type: EventType;
  recordedAt?: number;
  targetEventId?: string;
}

export interface TimelineInterval {
  state: EquipmentState;
  start: number;
  end: number;
  /** End is absent when the state remains open at the end of the known event stream. */
  open?: boolean;
}

export type ContradictionCode =
  | 'failure_already_failed'
  | 'failure_during_repair'
  | 'repair_start_without_failure'
  | 'repair_start_while_repairing'
  | 'repair_end_without_repair'
  | 'planned_start_while_failed'
  | 'planned_start_while_planned'
  | 'planned_start_during_repair'
  | 'planned_end_without_planned'
  | 'planned_end_during_repair';

export interface TimelineContradiction {
  code: ContradictionCode;
  eventId: string;
  equipmentId: string;
  time: number;
  state: EquipmentState;
  message: string;
}

export interface Timeline {
  equipmentId: string;
  intervals: TimelineInterval[];
  contradictions: TimelineContradiction[];
  ignoredEventIds: string[];
}

export interface DurationSummary {
  runningHours: number;
  waitingRepairHours: number;
  underRepairHours: number;
  plannedMaintenanceHours: number;
  unavailableHours: number;
  windowHours: number;
}

export interface WindowStatistics {
  equipmentId: string;
  windowStart: number;
  windowEnd: number;
  truncationMethod: TruncationMethod;
  mtbfHours: number | null;
  mttrHours: number | null;
  meanWaitingTimeHours: number | null;
  steadyStateAvailability: number | null;
  inherentAvailability: number | null;
  failureCount: number;
  completedRepairCount: number;
  rightCensoredRepairCount: number;
  durations: DurationSummary;
}

export interface StructureVersion {
  id: string;
  systemId: string;
  effectiveFrom: number | null;
  effectiveTo: number | null;
  root: RbdNode;
  createdAt: number;
}

export interface SystemAvailabilityResult {
  systemId: string;
  windowStart: number;
  windowEnd: number;
  availability: number | null;
  segments: Array<{
    structureVersionId: string | null;
    start: number;
    end: number;
    durationHours: number;
    availability: number | null;
  }>;
}

export interface EffectiveEventDifference {
  added: MaintenanceEvent[];
  removed: MaintenanceEvent[];
  changed: Array<{ from: MaintenanceEvent; to: MaintenanceEvent }>;
  unchanged: MaintenanceEvent[];
}

export interface RecalculationComparison<T> {
  asOf: number;
  earlierAsOf: number;
  earlier: T;
  current: T;
  effectiveEventDifference: EffectiveEventDifference;
}
