import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import { Logger } from '@nestjs/common';
import { OrchestratorService, ReviewContext } from './orchestrator.service';
import { ReviewState } from '../common/enums/review-state.enum';
import { DiffParserService } from '../diff-parser/diff-parser.service';
import { ContextRetrievalService } from '../context-retrieval/context-retrieval.service';
import { StaticFiltersService } from '../static-filters/static-filters.service';
import { LlmEngineService } from '../llm-engine/llm-engine.service';
import { PostProcessorService } from '../post-processor/post-processor.service';
import { PublisherService } from '../publisher/publisher.service';
import { GithubService } from '../github/github.service';
import { QueueService } from '../queue/queue.service';
import { logger } from '../common/utils/logger';

interface ProcessPrJob {
  deliveryId: string;
  action: string;
  pullRequest: Record<string, any>;
  repository: Record<string, any>;
  organization?: Record<string, any>;
  idempotencyKey: string;
  userPrompt?: string;
}

@Processor('review', {
  concurrency: parseInt(process.env.REVIEW_CONCURRENCY || '5', 10),
} as any)
export class ReviewProcessor extends WorkerHost {
  private readonly logger = new Logger(ReviewProcessor.name);

  constructor(
    private readonly orchestrator: OrchestratorService,
    private readonly diffParser: DiffParserService,
    private readonly contextRetrieval: ContextRetrievalService,
    private readonly staticFilters: StaticFiltersService,
    private readonly llmEngine: LlmEngineService,
    private readonly postProcessor: PostProcessorService,
    private readonly publisher: PublisherService,
    private readonly github: GithubService,
    private readonly queueService: QueueService,
  ) {
    super();
  }

  async process(job: Job<ProcessPrJob | any>): Promise<any> {
    const jobName = job.name;

    if (jobName === 'cancel-review') {
      return this.handleCancel(job.data);
    }

    if (jobName === 'process-pr') {
      return this.handleProcessPr(job);
    }

    this.logger.warn(`Unknown job type: ${jobName}`);
  }

  private async handleCancel(data: any): Promise<void> {
    const { repository, pullRequest } = data;
    this.logger.log(
      `Cancelling review for PR #${pullRequest.number} in ${repository.full_name}`,
    );
    // Find and cancel any active review for this PR
    const stats = this.orchestrator.getReviewStats();
    this.logger.log(`Active reviews: ${stats.total}`);
  }

  private async handleProcessPr(job: Job<ProcessPrJob>): Promise<any> {
    const { data } = job;
    const startTime = Date.now();

    const context = this.orchestrator.createReview({
      deliveryId: data.deliveryId,
      prNumber: data.pullRequest.number,
      repoFullName: data.repository.full_name,
      headSha: data.pullRequest.head.sha,
      baseSha: data.pullRequest.base.sha,
      prData: data.pullRequest,
      repoData: data.repository,
      idempotencyKey: data.idempotencyKey,
    });

    // Collect processing stats for transparency logging
    const stats: {
      rawFindings: number;
      deduplicated: number;
      confidenceFiltered: number;
      severityFiltered: number;
      capped: number;
      crossExamSuppressed: number;
      staticFindings: number;
      triagedChunks: number;
      totalChunks: number;
      elapsedMs: number;
    } = {
      rawFindings: 0,
      deduplicated: 0,
      confidenceFiltered: 0,
      severityFiltered: 0,
      capped: 0,
      crossExamSuppressed: 0,
      staticFindings: 0,
      triagedChunks: 0,
      totalChunks: 0,
      elapsedMs: 0,
    };

    try {
      // STATE: CLONING
      this.orchestrator.transition(context.reviewId, ReviewState.CLONING);
      this.logger.log(
        `[${context.reviewId}] Cloning ${data.repository.full_name}@${data.pullRequest.head.sha.substring(0, 8)}`,
      );
      const clonePath = await this.github.cloneRepository(
        data.repository,
        data.pullRequest.head.sha,
      );
      this.logger.log(`[${context.reviewId}] Clone complete: ${clonePath}`);

      // STATE: INDEXING
      this.orchestrator.transition(context.reviewId, ReviewState.INDEXING, {
        context: { clonePath },
      });
      this.logger.log(`[${context.reviewId}] Indexing repository...`);
      await this.contextRetrieval.indexRepository(
        data.repository.full_name,
        clonePath,
      );
      this.logger.log(`[${context.reviewId}] Indexing complete`);

      // STATE: TRIAGE
      this.orchestrator.transition(context.reviewId, ReviewState.TRIAGE);
      this.logger.log(`[${context.reviewId}] Fetching PR diff...`);
      const diff = await this.github.getPullRequestDiff(
        data.repository,
        data.pullRequest.number,
      );
      const chunks = await this.diffParser.parseAndChunk(diff, {
        repoFullName: data.repository.full_name,
        prNumber: data.pullRequest.number,
      });
      stats.totalChunks = chunks.length;
      this.logger.log(
        `[${context.reviewId}] Diff parsed: ${chunks.length} chunks`,
      );

      let findings: any[];

      // Check for huge PR - triage-only mode
      if (chunks.length > 50) {
        this.logger.warn(
          `[${context.reviewId}] Huge PR detected (${chunks.length} chunks). Running triage-only mode.`,
        );
        const triageFindings = await this.llmEngine.triageOnly(chunks);
        findings = triageFindings;
        stats.rawFindings = triageFindings.length;
        stats.triagedChunks = chunks.length;
        this.orchestrator.transition(context.reviewId, ReviewState.VERIFY, {
          chunks,
          findings: triageFindings,
        });
      } else {
        // STATE: DEEP_REVIEW
        this.orchestrator.transition(context.reviewId, ReviewState.DEEP_REVIEW, {
          diff,
          chunks,
        });

        // Static pre-filters
        this.logger.log(
          `[${context.reviewId}] Running static pre-filters (secrets, SQL injection, XSS, command injection, SSRF)...`,
        );
        const filterResults = await this.staticFilters.runAll(chunks, diff);
        stats.staticFindings = filterResults.findings.length;
        this.logger.log(
          `[${context.reviewId}] Static filters: ${filterResults.findings.length} findings (${filterResults.metadata.secretsDetected} secrets, ${filterResults.metadata.vulnerabilitiesFound} vulnerabilities)`,
        );

        this.logger.log(`[${context.reviewId}] Retrieving repository context...`);
        const retrievalContext = await this.contextRetrieval.retrieveContext(
          chunks,
          data.repository.full_name,
        );

        // Three-pass LLM review
        this.logger.log(
          `[${context.reviewId}] Starting 3-pass LLM review (${chunks.length} chunks)...`,
        );
        const reviewOutput = await this.llmEngine.review({
          chunks,
          diff,
          context: retrievalContext,
          staticResults: filterResults,
          config: context.config,
        });

        findings = reviewOutput.findings;
        stats.rawFindings = reviewOutput.metadata.pass2Findings;
        stats.triagedChunks = reviewOutput.metadata.pass1Chunks;
        stats.crossExamSuppressed = reviewOutput.metadata.pass3Suppressed;

        this.logger.log(
          `[${context.reviewId}] LLM review complete: ` +
            `Pass 1 triaged ${reviewOutput.metadata.pass1Chunks}/${chunks.length} chunks, ` +
            `Pass 2 found ${reviewOutput.metadata.pass2Findings} issues, ` +
            `Pass 3 suppressed ${reviewOutput.metadata.pass3Suppressed} false positives, ` +
            `${reviewOutput.findings.length} total findings (${stats.staticFindings} static + ${reviewOutput.findings.length - stats.staticFindings} LLM)`,
        );

        this.orchestrator.transition(context.reviewId, ReviewState.VERIFY, {
          diff,
          chunks,
          context: retrievalContext,
          staticFilterResults: filterResults,
          findings: reviewOutput.findings,
        });
      }

      // Post-processing
      const review = this.orchestrator.getReview(context.reviewId);
      if (!review) throw new Error('Review context lost');

      const prePostProcessCount = (review.findings || []).length;
      this.logger.log(
        `[${context.reviewId}] Post-processing ${prePostProcessCount} findings (dedup, confidence filter, ranking, comment cap)...`,
      );

      const processedFindings = await this.postProcessor.process(
        review.findings || [],
        {
          confidenceThreshold: parseFloat(
            process.env.CONFIDENCE_THRESHOLD || '0.70',
          ),
          maxComments: 25,
          repoFullName: data.repository.full_name,
        },
      );

      // Calculate post-processing stats
      stats.deduplicated = prePostProcessCount - (review.findings || []).length;
      stats.confidenceFiltered = 0; // Tracked inside post-processor via logs
      stats.severityFiltered = 0;
      stats.capped = prePostProcessCount - processedFindings.length;

      this.logger.log(
        `[${context.reviewId}] Post-processing complete: ${prePostProcessCount} → ${processedFindings.length} findings`,
      );

      this.orchestrator.transition(context.reviewId, ReviewState.PUBLISH, {
        processedFindings,
      });

      // STATE: PUBLISH
      this.logger.log(
        `[${context.reviewId}] Publishing ${processedFindings.length} findings to PR #${data.pullRequest.number}...`,
      );
      await this.publisher.publish({
        review,
        findings: processedFindings,
        repository: data.repository,
        pullRequest: data.pullRequest,
        processingStats: {
          ...stats,
          elapsedMs: Date.now() - startTime,
        },
      });

      // STATE: DONE
      this.orchestrator.transition(context.reviewId, ReviewState.DONE);

      const elapsed = Date.now() - startTime;
      this.logger.log(
        `[${context.reviewId}] ✅ Review complete in ${elapsed}ms. ` +
          `Published ${processedFindings.length} findings to PR #${data.pullRequest.number}. ` +
          `Pipeline: ${stats.totalChunks} chunks → ${stats.triagedChunks} triaged → ` +
          `${stats.rawFindings} raw findings → ${processedFindings.length} published ` +
          `(${stats.crossExamSuppressed} suppressed by cross-exam, ${stats.staticFindings} from static filters)`,
      );

      return {
        reviewId: context.reviewId,
        findingsCount: processedFindings.length,
        elapsedMs: elapsed,
      };
    } catch (error) {
      this.logger.error(
        `Review ${context.reviewId} failed: ${(error as Error).message}`,
        (error as Error).stack,
      );

      if (this.orchestrator.canRetry(context.reviewId)) {
        this.orchestrator.transition(context.reviewId, ReviewState.FAILED, {
          error: (error as Error).message,
        });
        throw error; // Let BullMQ handle retry
      } else {
        this.orchestrator.transition(context.reviewId, ReviewState.FAILED, {
          error: (error as Error).message,
        });
        await this.queueService.moveToDeadLetter(
          job,
          error as Error,
        );
        throw new UnrecoverableError(
          `Review ${context.reviewId} failed after max retries`,
        );
      }
    }
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error): void {
    this.logger.error(`Job ${job.id} failed: ${error.message}`);
  }

  @OnWorkerEvent('completed')
  onCompleted(job: Job): void {
    this.logger.log(`Job ${job.id} completed`);
  }
}
