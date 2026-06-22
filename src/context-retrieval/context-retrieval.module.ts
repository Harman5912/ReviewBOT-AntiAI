import { Module } from '@nestjs/common';
import { ContextRetrievalService } from './context-retrieval.service';

@Module({
  providers: [ContextRetrievalService],
  exports: [ContextRetrievalService],
})
export class ContextRetrievalModule {}
