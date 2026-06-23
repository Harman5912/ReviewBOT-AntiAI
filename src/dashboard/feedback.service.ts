import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface FindingFeedback {
  findingId: string;
  reviewId: string;
  repoFullName: string;
  file: string;
  line: number;
  title: string;
  severity: string;
  isFalsePositive: boolean;
  timestamp: string;
}

const FEEDBACK_FILE = path.join(process.cwd(), '.reviewbot-feedback.json');

@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  recordFeedback(feedback: FindingFeedback): void {
    try {
      const all = this.loadFeedback();
      all.push(feedback);
      fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(all, null, 2), 'utf-8');
      this.logger.log(`Feedback recorded: ${feedback.findingId} = ${feedback.isFalsePositive ? 'false positive' : 'valid'}`);
    } catch (error) {
      this.logger.warn(`Failed to record feedback: ${(error as Error).message}`);
    }
  }

  getFeedbackForRepo(repoFullName: string): FindingFeedback[] {
    return this.loadFeedback().filter(f => f.repoFullName === repoFullName);
  }

  getFalsePositiveRate(): number {
    const all = this.loadFeedback();
    if (!all.length) return 0;
    const fp = all.filter(f => f.isFalsePositive).length;
    return fp / all.length;
  }

  private loadFeedback(): FindingFeedback[] {
    try {
      if (fs.existsSync(FEEDBACK_FILE)) {
        return JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8'));
      }
    } catch (error) {
      this.logger.warn(`Failed to load feedback: ${(error as Error).message}`);
    }
    return [];
  }
}
