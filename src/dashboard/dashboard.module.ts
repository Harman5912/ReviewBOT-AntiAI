import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { SettingsService } from './settings.service';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { GithubModule } from '../github/github.module';
import { QueueModule } from '../queue/queue.module';
import { PublisherModule } from '../publisher/publisher.module';
import { LlmEngineModule } from '../llm-engine/llm-engine.module';
import { DiffParserModule } from '../diff-parser/diff-parser.module';
import { ContextRetrievalModule } from '../context-retrieval/context-retrieval.module';
import { StaticFiltersModule } from '../static-filters/static-filters.module';
import { PostProcessorModule } from '../post-processor/post-processor.module';

@Module({
  imports: [
    OrchestratorModule, GithubModule, QueueModule, PublisherModule, LlmEngineModule,
    DiffParserModule, ContextRetrievalModule, StaticFiltersModule, PostProcessorModule,
  ],
  controllers: [DashboardController],
  providers: [DashboardService, SettingsService],
})
export class DashboardModule {}
