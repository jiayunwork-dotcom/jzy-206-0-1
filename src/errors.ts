export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const invalidRequest = (message: string, details?: unknown) =>
  new AppError(400, 'INVALID_REQUEST', message, details);

export const notFound = (message: string, details?: unknown) =>
  new AppError(404, 'NOT_FOUND', message, details);

export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);
