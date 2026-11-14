import { MikroORM } from '@mikro-orm/postgresql';
import mikroOrmConfig from '../../src/infrastructure/database/mikro-orm.config';
import {
  SubmitInput,
  WagerProcessingService,
} from '../../src/application/wager-processing.service';

const [keyPrefix, inputJson, countText] = process.argv.slice(2);
const input = JSON.parse(inputJson) as SubmitInput;
const count = Number(countText ?? '1');

async function main(): Promise<void> {
  const orm = await MikroORM.init({ ...mikroOrmConfig, pool: { min: 0, max: 1 } });
  const results = await Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const service = new WagerProcessingService(orm.em.fork());
      try {
        const key = keyPrefix === '__same__' ? 'concurrent-same-key' : `${keyPrefix}-${index}`;
        return await service.process(key, input);
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          code:
            typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
        };
      }
    }),
  );
  process.stdout.write(JSON.stringify(results));
  await orm.close(true);
}

void main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
