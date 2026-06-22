import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { logger } from '../../common/utils/logger';
import { redactSecrets } from '../../common/utils/redact-secrets';
import { truncateToTokenBudget } from '../../common/utils/token-utils';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompletionOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: 'text' | 'json';
}

@Injectable()
export class OpenRouterProvider {
  private client!: OpenAI;
  private readonly logger = new Logger(OpenRouterProvider.name);
  private defaultModel: string;
  private reviewModel: string;
  private requestCount = 0;
  private rateLimitResetTime = 0;
  private _apiKey = '';
  private _baseUrl = '';

  constructor() {
    this._apiKey = process.env.OPENROUTER_API_KEY || '';
    this._baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
    this.defaultModel = process.env.OPENROUTER_DEFAULT_MODEL || 'google/gemini-2.5-flash';
    this.reviewModel = process.env.OPENROUTER_REVIEW_MODEL || 'openrouter/owl-alpha';
    this.initClient();
  }

  private initClient(): void {
    this.client = new OpenAI({
      apiKey: this._apiKey,
      baseURL: this._baseUrl,
      defaultHeaders: {
        'HTTP-Referer': process.env.APP_URL || 'https://reviewbot.dev',
        'X-Title': 'ReviewBot',
      },
    });
  }

  /** Reconfigure the provider at runtime */
  configure(apiKey: string, baseUrl?: string, model?: string): void {
    this._apiKey = apiKey;
    if (baseUrl) this._baseUrl = baseUrl;
    if (model) this.reviewModel = model;
    this.defaultModel = model || this.defaultModel;
    this.initClient();
    this.logger.log(`Reconfigured: baseUrl=${this._baseUrl}, model=${this.reviewModel}`);
  }

  getApiKey(): string {
    return this._apiKey;
  }

  getBaseUrl(): string {
    return this._baseUrl;
  }

  async chat(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<string> {
    const model = options?.model || this.defaultModel;
    const maxTokens = options?.maxTokens || 4096;
    const temperature = options?.temperature ?? 0.1;

    // Redact secrets from all messages
    const sanitizedMessages = messages.map((m) => ({
      ...m,
      content: redactSecrets(m.content),
    }));

    // Check rate limiting
    await this.checkRateLimit();

    try {
      const completion = await this.client.chat.completions.create({
        model,
        messages: sanitizedMessages as any,
        max_tokens: maxTokens,
        temperature,
        response_format:
          options?.responseFormat === 'json'
            ? { type: 'json_object' }
            : undefined,
      });

      this.requestCount++;

      const content = completion.choices[0]?.message?.content || '';
      this.logger.debug(
        `OpenRouter response: model=${model}, tokens=${completion.usage?.total_tokens || 'unknown'}`,
      );

      return content;
    } catch (error: any) {
      if (error?.status === 429) {
        this.rateLimitResetTime = Date.now() + 60000;
        this.logger.warn('OpenRouter rate limit hit, backing off');
        throw new Error('Rate limit exceeded');
      }

      if (error?.status >= 500) {
        this.logger.error(`OpenRouter server error: ${error?.status}`);
        throw new Error(`Model outage: ${error?.message}`);
      }

      this.logger.error(`OpenRouter error: ${(error as Error).message}`);
      throw error;
    }
  }

  async chatJson(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<any> {
    const response = await this.chat(messages, {
      ...options,
      responseFormat: 'json',
    });

    try {
      return JSON.parse(response);
    } catch {
      // Try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      this.logger.warn('Failed to parse JSON response from LLM');
      return null;
    }
  }

  private async checkRateLimit(): Promise<void> {
    if (Date.now() < this.rateLimitResetTime) {
      const waitMs = this.rateLimitResetTime - Date.now();
      this.logger.log(`Rate limit: waiting ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  getDefaultModel(): string {
    return this.defaultModel;
  }

  getReviewModel(): string {
    return this.reviewModel;
  }
}
