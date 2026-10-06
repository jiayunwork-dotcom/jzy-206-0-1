export type EventType =
  | 'FAULT'
  | 'REPAIR_START'
  | 'REPAIR_END'
  | 'PLANNED_START'
  | 'PLANNED_END'
  | 'VOID';

export type DeviceState = 'UP' | 'WAITING_REPAIR' | 'REPAIR' | 'PLANNED';

export type CensoringMethod = 'right_censored' | 'drop';

export type BlockType = 'series' | 'parallel' | 'k_of_n' | 'device';

export interface CategoryInput {
  name: string;
  plannedIsDowntime: boolean;
}

export interface Category extends CategoryInput {
  id: string;
  createdAt: string;
}

export interface DeviceInput {
  code: string;
  name: string;
  categoryId: string;
}

export interface Device extends DeviceInput {
  id: string;
  createdAt: string;
}

export interface MaintenanceEventInput {
  eventId: string;
  deviceId: string;
  occurredAt: string;
  type: Exclude<EventType, 'VOID'>;
  recordedAt?: string;
  /** Required for VOID; may be present as a guard on void events. */
  targetEventId?: string;
}

export interface VoidEventInput {
  eventId: string;
  targetEventId: string;
  occurredAt: string;
  type: 'VOID';
  deviceId?: string;
  recordedAt?: string;
}

export type AnyEventInput = MaintenanceEventInput | VoidEventInput;

export interface StoredEvent {
  _id?: string;
  eventId: string;
  deviceId: string | null;
  occurredAt: string;
  recordedAt: string;
  type: EventType;
  targetEventId: string | null;
  supersedesEventId?: string | null;
}

export interface TimelineSegment {
  state: DeviceState;
  from: string;
  to: string;
  durationHours: number;
}

export interface TimelineContradiction {
  index: number;
  eventId: string;
  occurredAt: string;
  state: DeviceState;
  type: EventType;
  code:
    | 'FAULT_WHILE_DOWN'
    | 'REPAIR_START_WITHOUT_FAULT'
    | 'REPAIR_START_WHILE_REPAIRING'
    | 'REPAIR_START_WHILE_PLANNED'
    | 'REPAIR_END_WITHOUT_REPAIR'
    | 'REPAIR_END_WHILE_PLANNED'
    | 'PLANNED_START_NOT_UP'
    | 'PLANNED_END_NOT_PLANNED';
  message: string;
  action: string;
}

export interface DeviceTimeline {
  deviceId: string;
  segments: TimelineSegment[];
  contradictions: TimelineContradiction[];
}

export interface WindowStatistics {
  deviceId: string;
  windowStart: string;
  windowEnd: string;
  method: CensoringMethod;
  plannedIsDowntime: boolean;
  operatingHours: number;
  waitingHours: number;
  repairHours: number;
  plannedHours: number;
  faultCount: number;
  completedRepairCount: number;
  censoredFaults: number;
  censoredRepairs: number;
  mtbf: number | null;
  mttr: number | null;
  observedAvailability: number;
  steadyStateAvailability: number | null;
}

export interface DeviceBlock {
  type: 'device';
  deviceId: string;
}

export interface CombinationBlock {
  type: 'series' | 'parallel' | 'k_of_n';
  children: ReliabilityBlock[];
  k?: number;
}

export type ReliabilityBlock = DeviceBlock | CombinationBlock;

export interface StructureVersionInput {
  version: string;
  validFrom: string;
  root: ReliabilityBlock;
  note?: string;
  recordedAt?: string;
}

export interface StructureVersion extends StructureVersionInput {
  id: string;
  systemId: string;
  recordedAt: string;
  createdAt: string;
}

export interface StructureSegmentResult {
  from: string;
  to: string;
  hours: number;
  version: string | null;
  availability: number | null;
}

export interface SystemAvailabilityResult {
  systemId: string;
  windowStart: string;
  windowEnd: string;
  asOf?: string;
  availability: number;
  segments: StructureSegmentResult[];
  deviceAvailability: Record<string, number>;
}

export interface DerivedSnapshot {
  id: string;
  scope: 'device' | 'system';
  scopeId: string;
  windowStart: string;
  windowEnd: string;
  asOf: string;
  method: CensoringMethod;
  payload: WindowStatistics | SystemAvailabilityResult;
  calculatedAt: string;
  frozen?: boolean;
}

export interface EventChange {
  kind: 'added' | 'removed' | 'voided' | 'replacement_activated';
  event: StoredEvent;
}

export interface RecalculationDiff {
  windowStart: string;
  windowEnd: string;
  baselineAsOf: string;
  currentAsOf: string;
  baseline: Record<string, WindowStatistics>;
  current: Record<string, WindowStatistics>;
  changedEvents: StoredEvent[];
  eventChanges: EventChange[];
}
