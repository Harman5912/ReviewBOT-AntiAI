import { Module } from '@nestjs/common';
import { LlmEngineService } from './llm-engine.service';
import { OpenRouterProvider } from './providers/openrouter.provider';
import { SettingsModule } from '../dashboard/settings.module';

@Module({
  imports: [SettingsModule],
  providers: [LlmEngineService, OpenRouterProvider],
  exports: [LlmEngineService],
})
export class LlmEngineModule {}
