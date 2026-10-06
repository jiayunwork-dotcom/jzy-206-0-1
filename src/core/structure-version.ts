import { hoursBetween } from './timeline.js';
import { evaluateBlock } from './block-diagram.js';
import type {
  StructureSegmentResult,
  StructureVersion,
} from './types.js';

export function activeStructureVersions(
  versions: StructureVersion[],
  asOf?: string,
): StructureVersion[] {
  const cutoff = asOf ? Date.parse(asOf) : Number.POSITIVE_INFINITY;
  return versions
    .filter((version) => Date.parse(version.recordedAt) <= cutoff)
    .sort(
      (a, b) =>
        Date.parse(a.validFrom) - Date.parse(b.validFrom) ||
        a.version.localeCompare(b.version),
    );
}

export function splitWindowByStructure(
  versions: StructureVersion[],
  windowStart: string,
  windowEnd: string,
): Array<{ from: Date; to: Date; version: StructureVersion | null }> {
  const start = new Date(windowStart);
  const end = new Date(windowEnd);
  const boundaryTimes = [start.getTime()];
  for (const version of versions) {
    const at = Date.parse(version.validFrom);
    if (at > start.getTime() && at < end.getTime()) boundaryTimes.push(at);
  }
  boundaryTimes.push(end.getTime());
  boundaryTimes.sort((a, b) => a - b);

  return boundaryTimes.slice(0, -1).map((fromMs, index) => {
    const toMs = boundaryTimes[index + 1];
    const active =
      versions
        .filter((version) => Date.parse(version.validFrom) <= fromMs)
        .at(-1) ?? null;
    return { from: new Date(fromMs), to: new Date(toMs), version: active };
  });
}

export function evaluateStructureWindow(
  versions: StructureVersion[],
  windowStart: string,
  windowEnd: string,
  availabilityByDevice: Record<string, number>,
): { availability: number; segments: StructureSegmentResult[] } {
  const slices = splitWindowByStructure(versions, windowStart, windowEnd);
  const segments: StructureSegmentResult[] = [];
  let weighted = 0;
  let totalHours = 0;

  for (const slice of slices) {
    const hours = hoursBetween(slice.from, slice.to);
    const availability = slice.version
      ? evaluateBlock(slice.version.root, availabilityByDevice)
      : null;
    segments.push({
      from: slice.from.toISOString(),
      to: slice.to.toISOString(),
      hours,
      version: slice.version?.version ?? null,
      availability,
    });
    if (availability !== null) {
      weighted += availability * hours;
      totalHours += hours;
    }
  }

  return { availability: totalHours === 0 ? 0 : weighted / totalHours, segments };
}
