import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { TerminusModule } from '@nestjs/terminus';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import * as Sentry from '@sentry/nestjs';

import { CommonConfigModule } from './common/config/config.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { QueueModule } from './queue/queue.module';
import { OrchestratorModule } from './orchestrator/orchestrator.module';
import { DiffParserModule } from './diff-parser/diff-parser.module';
import { ContextRetrievalModule } from './context-retrieval/context-retrieval.module';
import { StaticFiltersModule } from './static-filters/static-filters.module';
import { LlmEngineModule } from './llm-engine/llm-engine.module';
import { PostProcessorModule } from './post-processor/post-processor.module';
import { PublisherModule } from './publisher/publisher.module';
import { GithubModule } from './github/github.module';
import { HealthModule } from './health/health.module';
import { DashboardModule } from './dashboard/dashboard.module';


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    // Sentry initialized in main.ts
    ThrottlerModule.forRoot([
      {
        ttl: 60000,
        limit: 100,
      },
    ]),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: {
          age: 86400,
          count: 1000,
        },
        removeOnFail: {
          age: 259200,
          count: 5000,
        },
      },
    } as any),
    ScheduleModule.forRoot(),
    TerminusModule,
    CommonConfigModule,
    IngestionModule,
    QueueModule,
    OrchestratorModule,
    DiffParserModule,
    ContextRetrievalModule,
    StaticFiltersModule,
    LlmEngineModule,
    PostProcessorModule,
    PublisherModule,
    GithubModule,
    HealthModule,
    DashboardModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      serveRoot: '/',
    }),
  ],
})
export class AppModule {}
