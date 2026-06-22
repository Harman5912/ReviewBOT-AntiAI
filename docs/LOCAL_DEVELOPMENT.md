# Local Development Guide

## Prerequisites

- Node.js 20+
- Docker & Docker Compose
- Git
- A GitHub App (for webhook testing)

## Quick Start

### 1. Clone and Install

```bash
git clone <repo-url>
cd reviewbot
npm install
```

### 2. Environment Setup

```bash
cp .env.example .env
# Edit .env with your values
```

Required environment variables:
- `DATABASE_PASSWORD` - PostgreSQL password
- `GITHUB_APP_ID` - Your GitHub App ID
- `GITHUB_PRIVATE_KEY` - Your GitHub App private key
- `GITHUB_WEBHOOK_SECRET` - Webhook secret
- `OPENROUTER_API_KEY` - OpenRouter API key

### 3. Start Infrastructure

```bash
docker-compose up -d postgres redis
```

### 4. Run Database Migrations

```bash
npm run migration:run
```

### 5. Start Development Server

```bash
npm run start:dev
```

The API will be available at `http://localhost:3000`.

### 6. Expose Webhooks (for local testing)

Use ngrok or similar to expose your local server:

```bash
ngrok http 3000
```

Set the webhook URL in your GitHub App settings to `https://<ngrok-url>/webhooks/github`.

## Testing Webhooks Locally

```bash
# Send a test webhook
curl -X POST http://localhost:3000/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: pull_request" \
  -H "X-GitHub-Delivery: test-123" \
  -H "X-Hub-Signature-256: sha256=<computed-signature>" \
  -d '{"action":"opened","number":1,"pull_request":{...},"repository":{...}}'
```

## Running Tests

```bash
# Unit tests
npm run test

# With coverage
npm run test:cov

# E2E tests
npm run test:e2e
```

## Project Structure

```
src/
├── common/           # Shared utilities, DTOs, enums, config
├── ingestion/        # Webhook ingestion API
├── queue/            # BullMQ queue management
├── orchestrator/     # Review state machine & processor
├── diff-parser/      # Diff parsing & chunking
├── context-retrieval/# Symbol graph, tree-sitter, embeddings
├── static-filters/   # Pre-LLM static analysis
├── llm-engine/       # 3-pass LLM review engine
├── post-processor/   # Finding dedup, ranking, filtering
├── publisher/        # GitHub comment & check run publishing
├── github/           # GitHub App integration
└── health/           # Health check endpoints
```

## Debugging

Enable debug logging:
```bash
DEBUG=reviewbot:* npm run start:dev
```

View queue status:
```bash
curl http://localhost:3000/health
```
