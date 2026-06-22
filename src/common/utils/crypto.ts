import { createHmac, timingSafeEqual } from 'crypto';

export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  const hmac = createHmac('sha256', secret);
  const digest = 'sha256=' + hmac.update(payload).digest('hex');

  if (signature.length !== digest.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

export function generateIdempotencyKey(): string {
  return `rb_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

export function hashContent(content: string): string {
  return createHmac('sha256', 'content-hash').update(content).digest('hex');
}
