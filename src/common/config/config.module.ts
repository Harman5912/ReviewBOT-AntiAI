import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),

  DATABASE_TYPE: z.enum(['postgres', 'sqlite']).default('sqlite'),
  DATABASE_HOST: z.string().default('localhost'),
  DATABASE_PORT: z.string().default('5432'),
  DATABASE_USER: z.string().default('reviewbot'),
  DATABASE_PASSWORD: z.string().default(''),
  DATABASE_NAME: z.string().default('reviewbot'),

  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.string().default('6379'),
  REDIS_PASSWORD: z.string().optional(),

  GITHUB_APP_ID: z.string(),
  GITHUB_PRIVATE_KEY: z.string(),
  GITHUB_WEBHOOK_SECRET: z.string(),

  OPENROUTER_API_KEY: z.string(),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  OPENROUTER_DEFAULT_MODEL: z.string().default('google/gemini-2.5-flash'),
  OPENROUTER_REVIEW_MODEL: z.string().default('openrouter/owl-alpha'),

  SENTRY_DSN: z.string().optional(),

  CONFIDENCE_THRESHOLD: z.string().default('0.70'),
  MAX_RETRIES: z.string().default('3'),
  REVIEW_TIMEOUT_MS: z.string().default('480000'),
});

export type EnvConfig = z.infer<typeof envSchema>;

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: 'ENV_CONFIG',
      useFactory: (configService: ConfigService): EnvConfig => {
        const result = envSchema.safeParse(process.env);
        if (!result.success) {
          console.error('Invalid environment configuration:', result.error.format());
          throw new Error('Invalid environment configuration');
        }
        return result.data;
      },
      inject: [ConfigService],
    },
  ],
  exports: ['ENV_CONFIG'],
})
export class CommonConfigModule {}
