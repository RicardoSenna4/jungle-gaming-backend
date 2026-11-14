import { Module } from '@nestjs/common';

/** Reserved module boundary; worker providers currently live in AppModule and use feature flags. */
@Module({})
export class WorkerModule {}
