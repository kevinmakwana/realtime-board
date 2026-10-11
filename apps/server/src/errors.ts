import type { Card, ErrorCode } from '@board/shared';

/** A failure the client should see (as opposed to a bug). */
export class ServiceError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly current?: Card,
  ) {
    super(message);
  }
}
