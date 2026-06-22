# 🤖 ReviewBot

**High-Signal AI Pull Request Review Agent**

ReviewBot is a production-grade GitHub Pull Request Review Agent that prioritizes developer trust, low false-positive rates, actionable findings, and fast review turnaround.

> The goal is NOT to maximize comment volume.
> The goal is to maximize useful findings resolved before first human review.

## Features

- **Three-Pass LLM Review** - Triage → Deep Review → Cross-Examination
- **Static Pre-Filters** - Secret detection, security scans, SQL injection, XSS
- **Smart Diff Parsing** - Handles renames, binary files, large diffs, AST mapping
- **Context-Aware** - Symbol graph, tree-sitter indexing, vector embeddings
- **Finding Post-Processing** - Deduplication, confidence filtering, ranking, comment caps
- **GitHub App Integration** - Webhooks, check runs, review comments
- **State Machine** - Full PR lifecycle management with retries and dead letter queue
- **Edge Case Handling** - 30+ edge cases including huge PRs, flip-flops, rate limits

## Quick Start

```bash
# Clone
git clone <repo-url>
cd reviewbot

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your values

# Start infrastructure
docker-compose up -d postgres redis

# Run
npm run start:dev
```

## Architecture

```
GitHub Webhooks → Ingestion API → Event Queue (BullMQ)
    → Review Orchestrator (State Machine)
    → Diff Parser & Chunker
    → Context Retrieval (Tree-sitter + Embeddings)
    → Static Pre-Filters (Secrets, Security)
    → LLM Review Engine (3-Pass: Triage → Deep → Cross-Examine)
    → Finding Post Processor (Dedup, Rank, Filter)
    → Publisher (GitHub Comments + Check Runs)
```

## Tech Stack

- **Backend:** NestJS, TypeScript
- **Database:** PostgreSQL
- **Queue:** Redis, BullMQ
- **AI:** OpenRouter, Owl Alpha
- **Monitoring:** Sentry
- **Deployment:** Docker, GitHub Actions

## Configuration

Create `.github/reviewbot.yaml` in your repository:

```yaml
auto_review: true
draft_prs: false
severity_threshold: nit
max_comments: 25
tone: professional
ignored_paths:
  - node_modules/**
  - vendor/**
fail_on_severity: high
```

## Metrics & Targets

| Metric | Target |
|--------|--------|
| Finding acceptance rate | ≥ 60% |
| False positive rate | ≤ 15% |
| Suggestion apply rate | ≥ 25% |
| Review latency p90 | ≤ 3 minutes |
| Avg cost per review | ≤ $0.40 |
| Availability | 99.9% |

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Local Development](docs/LOCAL_DEVELOPMENT.md)
- [Production Guide](docs/PRODUCTION_GUIDE.md)
- [Configuration Example](docs/reviewbot.example.yaml)

## License

MIT
