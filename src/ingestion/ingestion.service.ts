import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { v4 as uuidv4 } from 'uuid';

interface WebhookEvent {
  event: string;
  deliveryId: string;
  payload: Record<string, any>;
  receivedAt: Date;
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);
  private readonly processedDeliveries = new Set<string>();
  private readonly MAX_CACHE_SIZE = 10000;

  constructor(
    @InjectQueue('review') private readonly reviewQueue: Queue,
    @InjectQueue('dead-letter') private readonly dlq: Queue,
  ) {}

  async enqueueWebhook(event: WebhookEvent): Promise<void> {
    if (this.processedDeliveries.has(event.deliveryId)) {
      this.logger.warn(`Duplicate webhook delivery: ${event.deliveryId}`);
      return;
    }

    this.processedDeliveries.add(event.deliveryId);
    if (this.processedDeliveries.size > this.MAX_CACHE_SIZE) {
      const iterator = this.processedDeliveries.values();
      for (let i = 0; i < this.MAX_CACHE_SIZE / 2; i++) {
        const key = iterator.next().value;
        if (key) this.processedDeliveries.delete(key);
      }
    }

    const relevantActions = [
      'opened',
      'synchronize',
      'reopened',
      'ready_for_review',
      'edited',
    ];

    if (
      event.event === 'pull_request' &&
      relevantActions.includes(event.payload.action)
    ) {
      await this.reviewQueue.add(
        'process-pr',
        {
          deliveryId: event.deliveryId,
          action: event.payload.action,
          pullRequest: event.payload.pull_request,
          repository: event.payload.repository,
          organization: event.payload.organization,
          idempotencyKey: uuidv4(),
        },
        {
          jobId: `pr-${event.payload.repository?.full_name}-${event.payload.pull_request?.number}-${event.payload.pull_request?.head?.sha}`,
          priority: this.calculatePriority(event.payload),
        },
      );
      this.logger.log(
        `Enqueued PR #${event.payload.pull_request?.number} from ${event.payload.repository?.full_name}`,
      );
    } else if (event.event === 'pull_request' && event.payload.action === 'closed') {
      await this.reviewQueue.add(
        'cancel-review',
        {
          deliveryId: event.deliveryId,
          pullRequest: event.payload.pull_request,
          repository: event.payload.repository,
        },
        {
          jobId: `cancel-${event.payload.repository?.full_name}-${event.payload.pull_request?.number}`,
        },
      );
    } else if (event.event === 'ping') {
      this.logger.log('Received ping event');
    }
  }

  private calculatePriority(payload: Record<string, any>): number {
    const pr = payload.pull_request;
    if (!pr) return 5;

    if (pr.draft) return 10;
    if (pr.title?.toLowerCase().includes('wip')) return 9;
    if (pr.title?.toLowerCase().includes('security')) return 1;
    if (pr.labels?.some((l: any) => l.name === 'critical')) return 1;
    if (pr.labels?.some((l: any) => l.name === 'bug')) return 2;

    return 5;
  }
}
