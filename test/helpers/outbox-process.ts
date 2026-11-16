import { spawn } from 'node:child_process';
interface Checkpoint {
  checkpoint: string;
  pid: number;
  id?: string;
}
export function worker(environment: NodeJS.ProcessEnv, mode: string) {
  const child = spawn(process.execPath, ['run', 'test/fixtures/outbox-publish-worker.ts', mode], {
    cwd: process.cwd(),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events: Checkpoint[] = [];
  const waiters: Array<{
    event: string;
    resolve: (value: Checkpoint) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  let buffered = '';
  child.stdout.on('data', (data: Buffer) => {
    buffered += data.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop()!;
    for (const line of lines) {
      let event: Checkpoint;
      try {
        event = JSON.parse(line) as Checkpoint;
      } catch {
        continue;
      }
      events.push(event);
      for (const waiter of [...waiters])
        if (waiter.event === event.checkpoint) {
          clearTimeout(waiter.timer);
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(event);
        }
    }
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('WORKER_EXITED_BEFORE_CHECKPOINT'));
      }
      resolve({ code, signal });
    }),
  );
  child.once('error', () => {
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('WORKER_START_FAILED'));
    }
  });
  const wait = (event: string) => {
    const seen = events.find((value) => value.checkpoint === event);
    if (seen) return Promise.resolve(seen);
    return new Promise<Checkpoint>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MISSING_CHECKPOINT_${event}`)), 15000);
      waiters.push({ event, resolve, reject, timer });
    });
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.kill('SIGTERM');
    await exited;
    clearTimeout(timeout);
  };
  return { child, wait, exited, stop };
}
