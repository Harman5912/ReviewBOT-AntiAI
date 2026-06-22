import { Module } from '@nestjs/common';
import { PublisherService } from './publisher.service';
import { GithubModule } from '../github/github.module';

@Module({
  imports: [GithubModule],
  providers: [PublisherService],
  exports: [PublisherService],
})
export class PublisherModule {}
