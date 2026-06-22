import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface LlmProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
}

export interface ReviewBotSettings {
  providers: LlmProvider[];
  activeProviderId: string;
  activeModel: string;
}

const SETTINGS_FILE = path.join(process.cwd(), '.reviewbot-settings.json');

const DEFAULT_SETTINGS: ReviewBotSettings = {
  providers: [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: process.env.OPENROUTER_API_KEY || '',
      models: [
        'openrouter/owl-alpha',
        'google/gemini-2.5-flash',
        'google/gemini-2.5-pro',
        'anthropic/claude-sonnet-4',
        'anthropic/claude-opus-4',
        'openai/gpt-4o',
        'openai/gpt-4o-mini',
        'openai/o1',
        'openai/o1-mini',
        'deepseek/deepseek-chat',
        'deepseek/deepseek-coder',
        'meta-llama/llama-4-maverick',
        'meta-llama/llama-4-scout',
        'qwen/qwen3-235b',
        'mistralai/mistral-large',
        'x-ai/grok-3',
        'perplexity/sonar-reasoning',
      ],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY || '',
      models: [
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4-turbo',
        'gpt-4',
        'gpt-3.5-turbo',
        'o1',
        'o1-mini',
        'o1-pro',
        'o3',
        'o3-mini',
        'o4-mini',
      ],
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com/v1',
      apiKey: process.env.ANTHROPIC_API_KEY || '',
      models: [
        'claude-sonnet-4-20250514',
        'claude-opus-4-20250514',
        'claude-3-7-sonnet-20250219',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
        'claude-3-haiku-20240307',
      ],
    },
    {
      id: 'google',
      name: 'Google Gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: process.env.GOOGLE_API_KEY || '',
      models: [
        'gemini-2.5-pro',
        'gemini-2.5-flash',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite',
        'gemini-1.5-pro',
        'gemini-1.5-flash',
      ],
    },
  ],
  activeProviderId: 'openrouter',
  activeModel: process.env.OPENROUTER_REVIEW_MODEL || 'openrouter/owl-alpha',
};

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private settings: ReviewBotSettings;

  constructor() {
    this.settings = this.loadSettings();
  }

  private loadSettings(): ReviewBotSettings {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        // Merge with defaults so new providers/models are added automatically
        return this.mergeWithDefaults(parsed);
      }
    } catch (error) {
      this.logger.warn(`Failed to load settings: ${(error as Error).message}`);
    }
    return { ...DEFAULT_SETTINGS };
  }

  private mergeWithDefaults(saved: Partial<ReviewBotSettings>): ReviewBotSettings {
    const merged: ReviewBotSettings = { ...DEFAULT_SETTINGS };
    if (saved.activeProviderId) merged.activeProviderId = saved.activeProviderId;
    if (saved.activeModel) merged.activeModel = saved.activeModel;
    if (saved.providers && Array.isArray(saved.providers)) {
      // Merge saved provider API keys into defaults
      for (const savedProvider of saved.providers) {
        const defaultProvider = merged.providers.find(p => p.id === savedProvider.id);
        if (defaultProvider && savedProvider.apiKey) {
          defaultProvider.apiKey = savedProvider.apiKey;
        }
        // Add custom models
        if (defaultProvider && savedProvider.models) {
          for (const model of savedProvider.models) {
            if (!defaultProvider.models.includes(model)) {
              defaultProvider.models.push(model);
            }
          }
        }
      }
      // Keep any custom providers not in defaults
      for (const savedProvider of saved.providers) {
        if (!merged.providers.find(p => p.id === savedProvider.id)) {
          merged.providers.push(savedProvider);
        }
      }
    }
    return merged;
  }

  private saveSettings(): void {
    try {
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2), 'utf-8');
    } catch (error) {
      this.logger.error(`Failed to save settings: ${(error as Error).message}`);
    }
  }

  getSettings(): ReviewBotSettings {
    return { ...this.settings };
  }

  getActiveProvider(): LlmProvider | undefined {
    return this.settings.providers.find(p => p.id === this.settings.activeProviderId);
  }

  getActiveModel(): string {
    return this.settings.activeModel;
  }

  updateProviderApiKey(providerId: string, apiKey: string): void {
    const provider = this.settings.providers.find(p => p.id === providerId);
    if (provider) {
      provider.apiKey = apiKey;
      this.saveSettings();
    }
  }

  addCustomModel(providerId: string, model: string): void {
    const provider = this.settings.providers.find(p => p.id === providerId);
    if (provider && !provider.models.includes(model)) {
      provider.models.push(model);
      this.saveSettings();
    }
  }

  setActiveProvider(providerId: string): void {
    const provider = this.settings.providers.find(p => p.id === providerId);
    if (provider) {
      this.settings.activeProviderId = providerId;
      // Auto-select first model if current model not in new provider
      if (!provider.models.includes(this.settings.activeModel)) {
        this.settings.activeModel = provider.models[0] || '';
      }
      this.saveSettings();
    }
  }

  setActiveModel(model: string): void {
    this.settings.activeModel = model;
    this.saveSettings();
  }

  updateSettings(updates: Partial<ReviewBotSettings>): void {
    if (updates.activeProviderId) this.settings.activeProviderId = updates.activeProviderId;
    if (updates.activeModel) this.settings.activeModel = updates.activeModel;
    if (updates.providers) {
      for (const p of updates.providers) {
        const existing = this.settings.providers.find(ep => ep.id === p.id);
        if (existing) {
          if (p.apiKey) existing.apiKey = p.apiKey;
          if (p.models) {
            for (const m of p.models) {
              if (!existing.models.includes(m)) existing.models.push(m);
            }
          }
        }
      }
    }
    this.saveSettings();
  }
}
