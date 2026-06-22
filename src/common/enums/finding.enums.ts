export enum Severity {
  CRITICAL = 'critical',
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
  NIT = 'nit',
}

export enum Category {
  CORRECTNESS = 'correctness',
  SECURITY = 'security',
  PERFORMANCE = 'performance',
  MAINTAINABILITY = 'maintainability',
  TESTS = 'tests',
  CONVENTION = 'convention',
}

export enum SuggestionType {
  COMMITTABLE = 'committable',
  PROSE = 'prose',
  NONE = 'none',
}

export enum Side {
  LEFT = 'LEFT',
  RIGHT = 'RIGHT',
}

export const SEVERITY_ORDER: Record<Severity, number> = {
  [Severity.CRITICAL]: 5,
  [Severity.HIGH]: 4,
  [Severity.MEDIUM]: 3,
  [Severity.LOW]: 2,
  [Severity.NIT]: 1,
};
