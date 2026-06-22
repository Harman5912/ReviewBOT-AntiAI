import { Module } from '@nestjs/common';
import { StaticFiltersService } from './static-filters.service';

@Module({
  providers: [StaticFiltersService],
  exports: [StaticFiltersService],
})
export class StaticFiltersModule {}
