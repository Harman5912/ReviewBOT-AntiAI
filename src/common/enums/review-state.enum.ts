export enum ReviewState {
  QUEUED = 'queued',
  CLONING = 'cloning',
  INDEXING = 'indexing',
  TRIAGE = 'triage',
  DEEP_REVIEW = 'deep_review',
  VERIFY = 'verify',
  PENDING_REVIEW = 'pending_review',
  PUBLISHING = 'publishing',
  DONE = 'done',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
  REJECTED = 'rejected',
}

export const REVIEW_STATE_TRANSITIONS: Record<ReviewState, ReviewState[]> = {
  [ReviewState.QUEUED]: [ReviewState.CLONING, ReviewState.CANCELLED],
  [ReviewState.CLONING]: [ReviewState.INDEXING, ReviewState.FAILED, ReviewState.CANCELLED],
  [ReviewState.INDEXING]: [ReviewState.TRIAGE, ReviewState.FAILED, ReviewState.CANCELLED],
  [ReviewState.TRIAGE]: [ReviewState.DEEP_REVIEW, ReviewState.VERIFY, ReviewState.FAILED, ReviewState.CANCELLED],
  [ReviewState.DEEP_REVIEW]: [ReviewState.VERIFY, ReviewState.FAILED, ReviewState.CANCELLED],
  [ReviewState.VERIFY]: [ReviewState.PENDING_REVIEW, ReviewState.DONE, ReviewState.FAILED, ReviewState.CANCELLED],
  [ReviewState.PENDING_REVIEW]: [ReviewState.PUBLISHING, ReviewState.DONE, ReviewState.FAILED, ReviewState.CANCELLED, ReviewState.REJECTED],
  [ReviewState.PUBLISHING]: [ReviewState.DONE, ReviewState.FAILED],
  [ReviewState.DONE]: [],
  [ReviewState.CANCELLED]: [],
  [ReviewState.REJECTED]: [],
  [ReviewState.FAILED]: [ReviewState.QUEUED],
};

export function isValidTransition(from: ReviewState, to: ReviewState): boolean {
  return REVIEW_STATE_TRANSITIONS[from]?.includes(to) ?? false;
}
