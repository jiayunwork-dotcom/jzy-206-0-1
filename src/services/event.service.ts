import { badRequest, conflict, notFound } from '../core/errors.js';
import type {
  AnyEventInput,
  StoredEvent,
} from '../core/types.js';
import { effectiveEvents } from '../core/timeline.js';
import type { DeviceRepository } from '../storage/repository.js';

const EVENT_TYPES = new Set([
  'FAULT',
  'REPAIR_START',
  'REPAIR_END',
  'PLANNED_START',
  'PLANNED_END',
  'VOID',
]);

export class EventService {
  constructor(private readonly repo: DeviceRepository) {}

  async submit(input: AnyEventInput): Promise<{ event: StoredEvent; duplicate?: boolean }> {
    this.validateInput(input);
    const existing = await this.repo.getEvent(input.eventId);
    if (existing) {
      if (!this.isSame(existing, input)) throw conflict('eventId already used by another event');
      return { event: existing, duplicate: true };
    }

    if (input.type === 'VOID') {
      const target = await this.repo.getEvent(input.targetEventId);
      if (!target) throw badRequest('Cannot void a non-existent event');
      return this.storeEvent(input, target.deviceId);
    }
    const device = await this.repo.getDevice(input.deviceId);
    if (!device) throw notFound('Unknown device');
    return this.storeEvent(input, input.deviceId);
  }

  private async storeEvent(input: AnyEventInput, targetDeviceId: string | null) {
    const event: StoredEvent = {
      eventId: input.eventId,
      deviceId: input.type === 'VOID' ? targetDeviceId : (input as { deviceId: string }).deviceId,
      occurredAt: new Date(input.occurredAt).toISOString(),
      recordedAt: new Date(input.recordedAt ?? new Date()).toISOString(),
      type: input.type,
      targetEventId: input.type === 'VOID' ? (input as { targetEventId: string }).targetEventId : null,
      supersedesEventId: null,
    };
    const inserted = await this.repo.insertEvent(event);
    return { event: inserted ?? event, duplicate: inserted === null };
  }

  async submitBatch(inputs: AnyEventInput[]): Promise<Array<{ event: StoredEvent; duplicate?: boolean; error?: string }>> {
    // All request-level validation happens before writing. The repository's
    // unique eventId index makes interleaved concurrent batches safe.
    for (const input of inputs) this.validateInput(input);
    const seen = new Set<string>();
    for (const input of inputs) {
      if (seen.has(input.eventId)) throw conflict('Duplicate eventId within batch');
      seen.add(input.eventId);
    }
    const results: Array<{ event: StoredEvent; duplicate?: boolean; error?: string }> = [];
    // Batches are applied in request order so a void in the same batch can
    // target an event submitted earlier in that batch. Each insert is still
    // protected by the repository's unique eventId index.
    for (const input of inputs) {
      try {
        results.push(await this.submit(input));
      } catch (error) {
        results.push({
          event: {
            eventId: input.eventId,
            deviceId: 'deviceId' in input && input.deviceId ? input.deviceId : null,
            occurredAt: input.occurredAt,
            recordedAt: new Date().toISOString(),
            type: input.type,
            targetEventId: 'targetEventId' in input ? input.targetEventId ?? null : null,
            supersedesEventId: null,
          },
          error: error instanceof Error ? error.message : 'Rejected',
        });
      }
    }
    return results;
  }

  async correctEvent(
    eventId: string,
    patch: { newEventId: string; occurredAt?: string; type?: AnyEventInput['type']; recordedAt?: string },
  ): Promise<StoredEvent> {
    const original = await this.repo.getEvent(eventId);
    if (!original) throw notFound('Event not found');
    if (original.type === 'VOID') throw badRequest('Only maintenance events can be corrected');
    if (await this.repo.getEvent(patch.newEventId)) {
      throw conflict('Correction event id already exists');
    }
    const type = patch.type ?? original.type;
    if (!EVENT_TYPES.has(type) || type === 'VOID') throw badRequest('Unknown event type');
    const occurredAt = new Date(patch.occurredAt ?? original.occurredAt).toISOString();

    const voidEvent: StoredEvent = {
      eventId: `${patch.newEventId}:void`,
      deviceId: original.deviceId,
      occurredAt: new Date().toISOString(),
      recordedAt: new Date(patch.recordedAt ?? new Date()).toISOString(),
      type: 'VOID',
      targetEventId: original.eventId,
      supersedesEventId: null,
    };
    const replacement: StoredEvent = {
      eventId: patch.newEventId,
      deviceId: original.deviceId,
      occurredAt,
      recordedAt: voidEvent.recordedAt,
      type: type as Exclude<AnyEventInput['type'], 'VOID'>,
      targetEventId: null,
      supersedesEventId: original.eventId,
    };
    await this.repo.insertEvent(voidEvent);
    const inserted = await this.repo.insertEvent(replacement);
    if (!inserted) throw conflict('Correction event id already exists');
    return inserted;
  }

  async listEffectiveEvents(deviceId: string, asOf?: string): Promise<StoredEvent[]> {
    return effectiveEvents(await this.repo.listEventsForDevice(deviceId, asOf));
  }

  private validateInput(input: AnyEventInput): void {
    if (!input?.eventId || typeof input.eventId !== 'string') throw badRequest('eventId is required');
    if (!EVENT_TYPES.has(input.type)) throw badRequest('Unknown event type');
    if (Number.isNaN(Date.parse(input.occurredAt))) throw badRequest('Invalid occurredAt');
    if (input.recordedAt !== undefined && Number.isNaN(Date.parse(input.recordedAt))) {
      throw badRequest('Invalid recordedAt');
    }
    if (input.type === 'VOID') {
      if (!input.targetEventId) throw badRequest('VOID event requires targetEventId');
    } else if (!input.deviceId) {
      throw badRequest('Maintenance event requires deviceId');
    }
  }

  private isSame(stored: StoredEvent, input: AnyEventInput): boolean {
    if (stored.type !== input.type) return false;
    if (input.type === 'VOID') return stored.targetEventId === input.targetEventId;
    return (
      stored.deviceId === input.deviceId &&
      new Date(stored.occurredAt).getTime() === new Date(input.occurredAt).getTime()
    );
  }
}
