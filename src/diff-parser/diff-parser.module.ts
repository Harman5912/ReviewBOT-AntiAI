import { Module } from '@nestjs/common';
import { DiffParserService } from './diff-parser.service';

@Module({
  providers: [DiffParserService],
  exports: [DiffParserService],
})
export class DiffParserModule {}
