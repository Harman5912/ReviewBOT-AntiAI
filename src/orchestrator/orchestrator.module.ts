import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OrchestratorService } from './orchestrator.service';
import { ReviewProcessor } from './review.processor';
import { DiffParserModule } from '../diff-parser/diff-parser.module';
import { ContextRetrievalModule } from '../context-retrieval/context-retrieval.module';
import { StaticFiltersModule } from '../static-filters/static-filters.module';
import { LlmEngineModule } from '../llm-engine/llm-engine.module';
import { PostProcessorModule } from '../post-processor/post-processor.module';
import { PublisherModule } from '../publisher/publisher.module';
import { GithubModule } from '../github/github.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'review' }),
    DiffParserModule,
    ContextRetrievalModule,
    StaticFiltersModule,
    LlmEngineModule,
    PostProcessorModule,
    PublisherModule,
    GithubModule,
    QueueModule,
  ],
  providers: [OrchestratorService, ReviewProcessor],
  exports: [OrchestratorService],
})
export class OrchestratorModule {}
