import { Module } from '@nestjs/common';
import { PostProcessorService } from './post-processor.service';

@Module({
  providers: [PostProcessorService],
  exports: [PostProcessorService],
})
export class PostProcessorModule {}
