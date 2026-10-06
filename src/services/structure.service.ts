import { badRequest } from '../core/errors.js';
import { validateBlock } from '../core/block-diagram.js';
import type {
  StructureVersion,
  StructureVersionInput,
  SystemAvailabilityResult,
  WindowStatistics,
} from '../core/types.js';
import {
  activeStructureVersions,
  evaluateStructureWindow,
} from '../core/structure-version.js';
import type { DeviceRepository } from '../storage/repository.js';

export class StructureService {
  constructor(private readonly repo: DeviceRepository) {}

  async createVersion(systemId: string, input: StructureVersionInput): Promise<StructureVersion> {
    if (!systemId || !input.version) throw badRequest('systemId and version are required');
    if (Number.isNaN(Date.parse(input.validFrom))) throw badRequest('Invalid validFrom');
    const devices = new Set((await this.repo.listDevices()).map((device) => device.id));
    validateBlock(input.root, devices);
    const versions = await this.repo.listStructureVersions(systemId);
    if (versions.some((version) => Date.parse(version.validFrom) === Date.parse(input.validFrom))) {
      throw badRequest('Two structure versions cannot have the same effective time');
    }
    return this.repo.createStructureVersion(systemId, input);
  }

  async listVersions(systemId: string, asOf?: string): Promise<StructureVersion[]> {
    return activeStructureVersions(await this.repo.listStructureVersions(systemId, asOf), asOf);
  }

  async systemAvailability(
    systemId: string,
    windowStart: string,
    windowEnd: string,
    stats: WindowStatistics[],
    asOf?: string,
  ): Promise<SystemAvailabilityResult> {
    if (Date.parse(windowEnd) <= Date.parse(windowStart)) {
      throw badRequest('Window end must be later than window start');
    }
    const versions = await this.listVersions(systemId, asOf);
    const deviceAvailability: Record<string, number> = {};
    for (const stat of stats) deviceAvailability[stat.deviceId] = stat.observedAvailability;
    const { availability, segments } = evaluateStructureWindow(
      versions,
      windowStart,
      windowEnd,
      deviceAvailability,
    );
    return {
      systemId,
      windowStart,
      windowEnd,
      asOf,
      availability,
      segments,
      deviceAvailability,
    };
  }
}
