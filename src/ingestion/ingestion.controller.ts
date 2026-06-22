import {
  Controller,
  Post,
  Headers,
  Req,
  HttpCode,
  HttpStatus,
  Logger,
  RawBody,
} from '@nestjs/common';
import { Request } from 'express';
import { IngestionService } from './ingestion.service';
import { verifyWebhookSignature } from '../common/utils/crypto';

@Controller('webhooks')
export class IngestionController {
  private readonly logger = new Logger(IngestionController.name);

  constructor(private readonly ingestionService: IngestionService) {}

  @Post('github')
  @HttpCode(HttpStatus.ACCEPTED)
  async handleGithubWebhook(
    @Req() req: Request,
    @RawBody() rawBody: Buffer,
    @Headers('x-hub-signature-256') signature: string,
    @Headers('x-github-event') event: string,
    @Headers('x-github-delivery') deliveryId: string,
  ): Promise<{ status: string; deliveryId: string }> {
    const body = rawBody?.toString() || '';

    if (!signature) {
      this.logger.warn(`Webhook received without signature: ${deliveryId}`);
      return { status: 'ignored', deliveryId: deliveryId || 'unknown' };
    }

    const secret = process.env.GITHUB_WEBHOOK_SECRET || '';
    if (!verifyWebhookSignature(body, signature, secret)) {
      this.logger.warn(`Invalid webhook signature: ${deliveryId}`);
      return { status: 'rejected', deliveryId: deliveryId || 'unknown' };
    }

    this.logger.log(
      `Received GitHub webhook: event=${event}, delivery=${deliveryId}`,
    );

    await this.ingestionService.enqueueWebhook({
      event,
      deliveryId,
      payload: JSON.parse(body),
      receivedAt: new Date(),
    });

    return { status: 'accepted', deliveryId };
  }
}
