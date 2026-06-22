import { Module } from '@nestjs/common';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';
import { QueueModule } from '../queue/queue.module';
import { GithubModule } from '../github/github.module';

@Module({
  imports: [QueueModule, GithubModule],
  controllers: [IngestionController],
  providers: [IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
