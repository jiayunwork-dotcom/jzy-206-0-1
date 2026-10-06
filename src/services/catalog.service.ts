import { notFound } from '../core/errors.js';
import type { DeviceRepository } from '../storage/repository.js';
import type { Category, CategoryInput, Device, DeviceInput } from '../core/types.js';

export class CatalogService {
  constructor(private readonly repo: DeviceRepository) {}

  createCategory(input: CategoryInput): Promise<Category> {
    return this.repo.createCategory(input);
  }

  listCategories(): Promise<Category[]> {
    return this.repo.listCategories();
  }

  createDevice(input: DeviceInput): Promise<Device> {
    return this.repo.createDevice(input);
  }

  async getDevice(id: string): Promise<Device> {
    const device = await this.repo.getDevice(id);
    if (!device) throw notFound('Device not found');
    return device;
  }

  listDevices(): Promise<Device[]> {
    return this.repo.listDevices();
  }
}
