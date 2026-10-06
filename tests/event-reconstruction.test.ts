import { describe, expect, it } from 'vitest';
import { effectiveEvents } from '../src/core/timeline.js';
import type { StoredEvent } from '../src/core/types.js';
import { event, iso } from './helpers.js';

const baseEvent = (overrides: Partial<StoredEvent>): StoredEvent => ({
  eventId: overrides.eventId ?? 'e',
  deviceId: 'd',
  occurredAt: overrides.occurredAt ?? new Date(0).toISOString(),
  recordedAt: overrides.recordedAt ?? new Date(0).toISOString(),
  type: overrides.type ?? 'FAULT',
  targetEventId: overrides.targetEventId ?? null,
});

describe('event stream reconstruction', () => {
  it('makes out-of-order arrival identical to chronological processing', () => {
    const events = [
      event('end', 'd', 30, 'REPAIR_END', 0),
      event('start', 'd', 20, 'REPAIR_START', 0),
      event('fault', 'd', 10, 'FAULT', 0),
    ];
    const ids = effectiveEvents(events as unknown as StoredEvent[]).map((item) => item.eventId);
    expect(ids).toEqual(['fault', 'start', 'end']);
  });

  it('deduplicates identical event ids and applies void events', () => {
    const one = baseEvent({ eventId: 'same', occurredAt: iso(0, 1) });
    const duplicate = baseEvent({ eventId: 'same', occurredAt: iso(0, 1) });
    expect(effectiveEvents([one, duplicate])).toHaveLength(1);

    const fault = baseEvent({ eventId: 'f', occurredAt: iso(0, 1), type: 'FAULT' });
    const voidEvent = baseEvent({
      eventId: 'v',
      deviceId: null,
      type: 'VOID',
      targetEventId: 'f',
      occurredAt: iso(0, 2),
    });
    expect(effectiveEvents([fault, voidEvent])).toHaveLength(0);

    const restoreVoid = baseEvent({
      eventId: 'vv',
      deviceId: null,
      type: 'VOID',
      targetEventId: 'v',
      occurredAt: iso(0, 3),
    });
    expect(effectiveEvents([fault, voidEvent, restoreVoid]).map((item) => item.eventId)).toEqual(['f']);
  });

  it('uses corrections until their original event is voided', () => {
    const original = baseEvent({ eventId: 'f', occurredAt: iso(0, 10) });
    const replacement = {
      ...baseEvent({ eventId: 'f2', occurredAt: iso(0, 20) }),
      supersedesEventId: 'f',
    };
    expect(effectiveEvents([original, replacement]).map((item) => item.eventId)).toEqual(['f']);
    const voidOriginal = baseEvent({
      eventId: 'v',
      deviceId: null,
      type: 'VOID',
      targetEventId: 'f',
      occurredAt: iso(0, 30),
    });
    expect(effectiveEvents([original, replacement, voidOriginal]).map((item) => item.eventId)).toEqual(['f2']);
  });
});
