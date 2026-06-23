import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { FeedbackService } from './feedback.service';
import { RepoConfigService } from './repo-config.service';
import { OrchestratorModule } from '../orchestrator/orchestrator.module';
import { GithubModule } from '../github/github.module';

@Module({
  imports: [OrchestratorModule, GithubModule],
  controllers: [DashboardController],
  providers: [DashboardService, FeedbackService, RepoConfigService],
})
export class DashboardModule {}
