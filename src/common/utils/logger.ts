import { LoggerService } from '@nestjs/common';

class ReviewBotLogger implements LoggerService {
  private context = 'ReviewBot';

  log(message: string, context?: string): void {
    console.log(`[${context || this.context}] ${message}`);
  }

  error(message: string, trace?: string, context?: string): void {
    console.error(`[${context || this.context}] ${message}`, trace || '');
  }

  warn(message: string, context?: string): void {
    console.warn(`[${context || this.context}] ${message}`);
  }

  debug(message: string, context?: string): void {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(`[${context || this.context}] ${message}`);
    }
  }
}

export const logger = new ReviewBotLogger();
