# ReviewBot Architecture

## System Design

ReviewBot is a production-grade AI Pull Request Review Agent designed for **developer trust**, **low false-positive rates**, **actionable findings**, and **fast review turnaround**.

### Core Principle

> The goal is NOT to maximize comment volume.
> The goal is to maximize useful findings resolved before first human review.

## State Machine

```
queued → cloning → indexing → triage → deep_review → verify → publish → done
                                                       ↗
queued → cloning → indexing → triage → verify → publish → done  (huge PRs)

Any state → cancelled (on PR close)
Any state → failed → queued (retry ×3)
Failed after max retries → Dead Letter Queue
```

## Three-Pass LLM Review

### Pass 1: Triage (Cheap Model)
- Uses a fast, cheap model (e.g., Gemini 2.5 Flash)
- Determines which hunks deserve deep review
- Filters out trivial changes (formatting, comments, etc.)
- Outputs priority and category predictions

### Pass 2: Deep Review (Owl Alpha)
- Uses Owl Alpha via OpenRouter
- Generates structured findings with full repository context
- Includes CWE identifiers for security findings
- Provides actionable suggestions with code patches

### Pass 3: Cross-Examination (Owl Alpha)
- Attempts to DISPROVE every finding from Pass 2
- Suppresses hallucinations and weak findings
- Adjusts confidence scores
- Only confirms findings that survive scrutiny

## Finding Schema

```json
{
  "finding_id": "uuid",
  "severity": "critical|high|medium|low|nit",
  "category": "correctness|security|performance|maintainability|tests|convention",
  "confidence": 0.0-1.0,
  "cwe": "CWE-XXX",
  "file": "path/to/file",
  "start_line": 42,
  "end_line": 45,
  "side": "RIGHT",
  "title": "Brief title",
  "explanation": "Detailed explanation",
  "suggestion": {
    "type": "committable|prose|none",
    "patch": "suggested code fix"
  },
  "evidence_refs": ["chunk-id-1"]
}
```

## Confidence Threshold

Default: **0.70**

Findings below this threshold are suppressed. This is configurable per-repository via `reviewbot.yaml`.

## Static Pre-Filters

Run before LLM review to catch issues cheaply:

1. **Secret Detection** - Hardcoded passwords, API keys, tokens
2. **SQL Injection** - String concatenation in queries
3. **XSS** - Unsafe HTML rendering
4. **Command Injection** - User input in shell commands
5. **SSRF** - User-controlled URLs in HTTP requests

## Post-Processing Pipeline

1. **Deduplication** - By file + line + normalized title
2. **Confidence Filtering** - Remove below threshold
3. **Severity Filtering** - Apply minimum severity
4. **Ranking** - By severity, confidence, category
5. **Comment Cap** - Max comments per review (default: 25)
6. **Diff-line Validation** - Ensure valid line mappings
7. **Flip-flop Detection** - Reduce confidence for oscillating findings

## Edge Cases Handled

| Edge Case | Handling |
|-----------|----------|
| Huge PRs (>50 chunks) | Triage-only mode with warning |
| Binary files | Skipped with logging |
| Generated code | Auto-detected and skipped |
| Vendor code | Auto-detected and skipped |
| File renames | Tracked, old path preserved |
| Force pushes | New SHA triggers fresh review |
| Closed PRs | Review cancelled |
| Empty diffs | No-op with logging |
| Webhooks duplicates | Idempotency key dedup |
| API rate limits | Backoff + retry |
| Model outages | Retry with exponential backoff |
| Context overflow | Token budget enforcement |
| Flip-flopping findings | Confidence reduction |
| Secrets in prompts | Automatic redaction |
| Bot loops | Self-detection and suppression |

## Configuration (reviewbot.yaml)

```yaml
auto_review: true
draft_prs: false
severity_threshold: nit
max_comments: 25
tone: professional
ignored_paths:
  - node_modules/**
  - vendor/**
  - dist/**
  - "*.lock"
banned_apis:
  - eval
  - exec
required_test_paths:
  - "**/*.test.*"
  - "**/*.spec.*"
fail_on_severity: high
security:
  secret_scan: true
  dependency_check: true
  sql_injection_scan: true
  xss_scan: true
```

Invalid configuration produces a warning comment and falls back to org defaults.

## Non-Functional Requirements

| Requirement | Target |
|-------------|--------|
| p50 latency | ≤ 90 seconds |
| p90 latency | ≤ 3 minutes |
| p99 latency | ≤ 8 minutes |
| Availability | 99.9% |
| Scalability | 10,000 repos, 1,000 reviews/min burst |
| Avg cost per review | ≤ $0.40 |

## North Star Metric

**Percentage of bot findings resolved before first human review.**

Supporting targets:
- Finding acceptance rate ≥ 60%
- False positive rate ≤ 15%
- Suggestion apply rate ≥ 25%
- Weekly active repos ≥ 70%
- Review latency p90 ≤ 3 minutes
