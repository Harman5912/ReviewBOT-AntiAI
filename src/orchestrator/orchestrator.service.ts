import { Injectable, Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  ReviewState,
  isValidTransition,
} from '../common/enums/review-state.enum';

export interface ReviewContext {
  reviewId: string;
  deliveryId: string;
  prNumber: number;
  repoFullName: string;
  headSha: string;
  baseSha: string;
  state: ReviewState;
  attempt: number;
  maxRetries: number;
  idempotencyKey: string;
  prData: Record<string, any>;
  repoData: Record<string, any>;
  diff?: any;
  chunks?: any[];
  context?: any;
  staticFilterResults?: any;
  findings?: any[];
  processedFindings?: any[];
  config?: any;
  error?: string;
  startedAt: Date;
  updatedAt: Date;
}

interface StateEntry {
  context: ReviewContext;
  state: ReviewState;
  enteredAt: Date;
}

@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);
  private readonly reviews = new Map<string, StateEntry>();
  private readonly MAX_REVIEW_CACHE = 50000;

  createReview(input: {
    deliveryId: string;
    prNumber: number;
    repoFullName: string;
    headSha: string;
    baseSha: string;
    prData: Record<string, any>;
    repoData: Record<string, any>;
    idempotencyKey: string;
  }): ReviewContext {
    const reviewId = uuidv4();
    const context: ReviewContext = {
      reviewId,
      deliveryId: input.deliveryId,
      prNumber: input.prNumber,
      repoFullName: input.repoFullName,
      headSha: input.headSha,
      baseSha: input.baseSha,
      state: ReviewState.QUEUED,
      attempt: 0,
      maxRetries: 3,
      idempotencyKey: input.idempotencyKey,
      prData: input.prData,
      repoData: input.repoData,
      startedAt: new Date(),
      updatedAt: new Date(),
    };

    this.reviews.set(reviewId, {
      context,
      state: ReviewState.QUEUED,
      enteredAt: new Date(),
    });

    this.logger.log(
      `Created review ${reviewId} for PR #${input.prNumber} in ${input.repoFullName}`,
    );

    return context;
  }

  getReview(reviewId: string): ReviewContext | undefined {
    return this.reviews.get(reviewId)?.context;
  }

  transition(
    reviewId: string,
    toState: ReviewState,
    updates?: Partial<ReviewContext>,
  ): ReviewContext {
    const entry = this.reviews.get(reviewId);
    if (!entry) {
      throw new Error(`Review ${reviewId} not found`);
    }

    const { context, state: fromState } = entry;

    if (!isValidTransition(fromState, toState)) {
      throw new Error(
        `Invalid state transition: ${fromState} → ${toState} for review ${reviewId}`,
      );
    }

    const updatedContext: ReviewContext = {
      ...context,
      ...updates,
      state: toState,
      updatedAt: new Date(),
    };

    if (toState === ReviewState.FAILED) {
      updatedContext.attempt = (context.attempt || 0) + 1;
    }

    this.reviews.set(reviewId, {
      context: updatedContext,
      state: toState,
      enteredAt: new Date(),
    });

    this.logger.log(
      `Review ${reviewId}: ${fromState} → ${toState}`,
    );

    return updatedContext;
  }

  cancelReview(reviewId: string): ReviewContext {
    return this.transition(reviewId, ReviewState.CANCELLED);
  }

  canRetry(reviewId: string): boolean {
    const entry = this.reviews.get(reviewId);
    if (!entry) return false;
    return entry.context.attempt < entry.context.maxRetries;
  }

  getReviewStats(): {
    total: number;
    byState: Record<string, number>;
  } {
    const byState: Record<string, number> = {};
    for (const entry of this.reviews.values()) {
      byState[entry.state] = (byState[entry.state] || 0) + 1;
    }
    return { total: this.reviews.size, byState };
  }

  cleanupOldReviews(maxAgeHours = 48): number {
    const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
    let removed = 0;
    for (const [id, entry] of this.reviews.entries()) {
      if (
        entry.context.updatedAt.getTime() < cutoff &&
        (entry.state === ReviewState.DONE ||
          entry.state === ReviewState.CANCELLED ||
          entry.state === ReviewState.FAILED)
      ) {
        this.reviews.delete(id);
        removed++;
      }
    }
    return removed;
  }
}
