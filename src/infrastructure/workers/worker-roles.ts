export type WorkerRole = 'api' | 'consumer' | 'outbox-publisher' | 'pending-reference';

export function workerRoleFromEnvironment(): WorkerRole {
  const role = process.env.WORKER_ROLE ?? 'api';
  if (
    role === 'api' ||
    role === 'consumer' ||
    role === 'outbox-publisher' ||
    role === 'pending-reference'
  ) {
    return role;
  }
  throw new Error(`Unsupported WORKER_ROLE: ${role}`);
}
