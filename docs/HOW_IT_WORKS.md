# How ReviewBot Works

> A comprehensive guide to the ReviewBot AI Pull Request Review Agent — architecture, data flow, modules, APIs, and real-world runtime behavior.

---

## Table of Contents

1. [Overview](#overview)
2. [System Architecture](#system-architecture)
3. [Infrastructure Stack](#infrastructure-stack)
4. [Application Modules](#application-modules)
5. [Data Flow — How a PR Gets Reviewed](#data-flow--how-a-pr-gets-reviewed)
6. [State Machine](#state-machine)
7. [Three-Pass LLM Review](#three-pass-llm-review)
8. [API Endpoints](#api-endpoints)
9. [Configuration (`.env`)](#configuration-env)
10. [Runtime Logs Explained](#runtime-logs-explained)
11. [Setting Up & Testing](#setting-up--testing)
12. [Troubleshooting](#troubleshooting)

---

## 1. Overview

ReviewBot is a **production-grade AI Pull Request Review Agent** that automatically reviews GitHub pull requests using a multi-pass LLM pipeline. It is built with **NestJS** (Node.js), uses **Redis** for job queuing, and connects to **OpenRouter** for LLM access.

### Core Principle

> The goal is NOT to maximize comment volume.
> The goal is to maximize useful findings resolved before first human review.

### Key Features

| Feature | Description |
|---------|-------------|
| Three-Pass LLM Review | Triage → Deep Review → Cross-Examination |
| Static Pre-Filters | Secret detection, security scans, SQL injection, XSS |
| Smart Diff Parsing | Handles renames, binary files, large diffs, AST mapping |
| Context-Aware | Symbol graph, tree-sitter indexing, vector embeddings |
| Finding Post-Processing | Deduplication, confidence filtering, ranking, comment caps |
| GitHub App Integration | Webhooks, check runs, review comments |
| State Machine | Full PR lifecycle with retries and dead letter queue |
| Rate Limiting | Throttler guard (100 req/min) |
| Error Tracking | Sentry integration |

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        GitHub.com                                │
│  (Webhooks: pull_request.opened, .synchronize, .reopened, etc.) │
└──────────────────────────┬──────────────────────────────────────┘
                           │ POST /webhooks/github
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ngrok Tunnel                                 │
│  (Public URL → localhost:3000)                                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   ReviewBot API (NestJS)                        │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   Ingestion   │───▶│  Queue       │───▶│   Orchestrator   │  │
│  │   Controller  │    │  (BullMQ +   │    │   (State Machine) │  │
│  │              │    │   Redis)     │    │                  │  │
│  └──────────────┘    └──────────────┘    └────────┬─────────┘  │
│                                                    │            │
│  ┌──────────────┐    ┌──────────────┐    ┌────────▼─────────┐  │
│  │  Diff Parser  │    │   Context    │    │   LLM Engine     │  │
│  │  & Chunker   │    │  Retrieval   │    │  (3-Pass Review) │  │
│  └──────────────┘    └──────────────┘    └────────┬─────────┘  │
│                                                    │            │
│  ┌──────────────┐    ┌──────────────┐    ┌────────▼─────────┐  │
│  │   Static     │    │    Post      │    │   Publisher      │  │
│  │   Filters    │    │  Processor   │    │  (Comments +     │  │
│  │              │    │              │    │   Check Runs)    │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐                           │
│  │   Health     │    │   GitHub     │                           │
│  │   Controller │    │   Service    │                           │
│  └──────────────┘    └──────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Infrastructure Stack

| Component | Technology | Port | Purpose |
|-----------|-----------|------|---------|
| **Application** | NestJS 10 + Node.js 20 | 3000 | Main API server |
| **Queue** | BullMQ | — | Job processing |
| **Cache/Queue Backend** | Redis 8.8 | 6379 | Job storage, rate limiting |
| **Tunnel** | ngrok | — | Exposes localhost to internet |
| **LLM Provider** | OpenRouter | — | Access to Gemini, Owl Alpha, etc. |
| **Monitoring** | Sentry (optional) | — | Error tracking |

### How to Start Infrastructure

```powershell
# Start Redis 8.8
$redisDir = 'C:\Users\User\AppData\Local\Microsoft\WinGet\Packages\taizod1024.redis-windows-fork_Microsoft.Winget.Source_8wekyb3d8bbwe\Redis-8.8.0-Windows-x64-msys2'
Start-Process -FilePath "$redisDir\redis-server.exe" -ArgumentList '--port 6379' -WindowStyle Hidden

# Verify Redis
& "$redisDir\redis-cli.exe" ping
# Expected: PONG

# Start ngrok tunnel
ngrok http 3000
# Expected: Forwarding https://xxxx.ngrok-free.dev

# Start the application
Set-Location 'd:\anti ai\reviewbot'
npm run start:dev
```

---

## 4. Application Modules

### 4.1 Ingestion Module (`src/ingestion/`)

**Purpose:** Receives GitHub webhook events and enqueues review jobs.

- **IngestionController** — Handles `POST /webhooks/github`
- **IngestionService** — Validates events, deduplicates deliveries, enqueues to BullMQ

**Supported webhook events:**
- `pull_request.opened` — New PR created
- `pull_request.synchronize` — New commits pushed
- `pull_request.reopened` — Closed PR reopened
- `pull_request.ready_for_review` — Draft PR marked ready
- `pull_request.edited` — PR title/body edited
- `pull_request.closed` — PR closed (cancels review)

### 4.2 Queue Module (`src/queue/`)

**Purpose:** Manages BullMQ job queues.

| Queue | Purpose |
|-------|---------|
| `review` | Main review processing jobs |
| `dead-letter` | Failed jobs for manual inspection |

**Job Options:**
- Max attempts: 3
- Backoff: exponential, 5s delay
- Remove on complete: after 24h or 1000 jobs

### 4.3 Orchestrator Module (`src/orchestrator/`)

**Purpose:** Manages the review lifecycle state machine.

- **OrchestratorService** — Creates reviews, transitions states, tracks stats
- **ReviewProcessor** — Processes jobs from the queue

### 4.4 Diff Parser Module (`src/diff-parser/`)

**Purpose:** Parses git diffs into reviewable chunks.

- Handles file renames, binary files, large diffs
- Maps changes to AST nodes for context

### 4.5 Context Retrieval Module (`src/context-retrieval/`)

**Purpose:** Builds repository context for informed reviews.

- Symbol graph construction
- Tree-sitter indexing
- Vector embeddings for semantic search

### 4.6 Static Filters Module (`src/static-filters/`)

**Purpose:** Pre-filters findings before LLM review to reduce noise and cost.

- **Secret detection** — API keys, passwords, tokens
- **Security scans** — SQL injection, XSS patterns
- **Known false-positive suppression**

### 4.7 LLM Engine Module (`src/llm-engine/`)

**Purpose:** Orchestrates the three-pass LLM review.

- **Pass 1: Triage** — Fast model (Gemini 2.5 Flash) identifies which code hunks need deep review
- **Pass 2: Deep Review** — Powerful model (Owl Alpha) generates structured findings with context
- **Pass 3: Cross-Examination** — Attempts to disprove each finding to suppress hallucinations

**Provider:** OpenRouter (`src/llm-engine/providers/openrouter.provider.ts`)

### 4.8 Post Processor Module (`src/post-processor/`)

**Purpose:** Refines LLM findings before publishing.

- Deduplication of overlapping findings
- Confidence filtering (threshold: 0.70)
- Ranking by severity
- Comment cap per PR

### 4.9 Publisher Module (`src/publisher/`)

**Purpose:** Publishes review results back to GitHub.

- Posts review comments on specific lines
- Creates check run summaries
- Updates PR status

### 4.10 GitHub Module (`src/github/`)

**Purpose:** Interacts with the GitHub API.

- Authentication via GitHub App (JWT + installation tokens)
- Repository cloning
- Posting comments and check runs
- Installation ID lookup

### 4.11 Health Module (`src/health/`)

**Purpose:** Health check endpoints for monitoring.

### 4.12 Common Utilities (`src/common/`)

- **Config** — Environment configuration
- **Decorators** — Custom decorators
- **DTOs** — Data transfer objects
- **Enums** — Finding severity, review states
- **Guards** — Rate limiting (ThrottlerGuard)
- **Interceptors** — Sentry error tracking
- **Pipes** — Validation pipes
- **Utils** — Crypto, logger, secret redaction, token utilities

---

## 5. Data Flow — How a PR Gets Reviewed

### Step-by-Step Flow

```
1. Developer creates a Pull Request on GitHub
         │
2. GitHub sends webhook POST to your public URL
   (via ngrok: https://xxx.ngrok-free.dev/webhooks/github)
         │
3. IngestionController receives the webhook
   → Validates event type (pull_request.opened, etc.)
   → Checks for duplicate delivery
   → Enqueues a 'process-pr' job to BullMQ 'review' queue
         │
4. ReviewProcessor picks up the job from the queue
   → Creates a review record (state: QUEUED)
   → Transitions to CLONING
         │
5. GitHub Service clones the repository
   → Looks up installation ID via GitHub API
   → Generates installation access token
   → Clones repo to local disk
         │
6. Context Retrieval indexes the repository
   → Builds symbol graph
   → Creates tree-sitter index
   → Generates vector embeddings
         │
7. Diff Parser extracts changes
   → Parses git diff between base and head
   → Chunks large diffs
   → Maps to AST nodes
         │
8. Static Filters pre-screen the changes
   → Detects secrets, credentials
   → Identifies known patterns
   → Filters out trivial changes
         │
9. Three-Pass LLM Review
   → Pass 1 (Triage): Quick scan to prioritize hunks
   → Pass 2 (Deep Review): Detailed analysis with context
   → Pass 3 (Cross-Examine): Validates findings
         │
10. Post Processor refines findings
    → Deduplicates
    → Filters by confidence (≥ 0.70)
    → Ranks by severity
         │
11. Publisher posts results to GitHub
    → Line-specific review comments
    → Check run with summary
         │
12. Review marked as DONE
```

---

## 6. State Machine

```
                    ┌──────────┐
                    │  QUEUED  │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │ CLONING  │
                    └────┬─────┘
                         │
                    ┌────▼──────┐
                    │ INDEXING  │
                    └────┬──────┘
                         │
                    ┌────▼─────┐
                    │  TRIAGE  │  ◄── Pass 1: Quick LLM scan
                    └────┬─────┘
                         │
              ┌──────────┴──────────┐
              │                     │
         ┌────▼──────┐        ┌─────▼─────┐
         │DEEP_REVIEW│        │  VERIFY   │  ◄── Huge PRs skip deep review
         └────┬──────┘        └─────┬─────┘
              │                     │
         ┌────▼──────────┐          │
         │CROSS_EXAMINE  │          │
         └────┬──────────┘          │
              │                     │
              └──────────┬──────────┘
                    ┌────▼─────┐
                    │ PUBLISH  │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │   DONE   │
                    └──────────┘

Any state ──▶ CANCELLED (on PR close)
Any state ──▶ FAILED ──▶ QUEUED (retry ×3)
Failed after max retries ──▶ DEAD LETTER QUEUE
```

---

## 7. Three-Pass LLM Review

### Pass 1: Triage (Cheap Model)

| Property | Value |
|----------|-------|
| **Model** | `google/gemini-2.5-flash` |
| **Purpose** | Quick scan to identify which hunks need deep review |
| **Output** | Priority scores, category predictions |
| **Filters** | Formatting, comments, trivial changes |

### Pass 2: Deep Review (Owl Alpha)

| Property | Value |
|----------|-------|
| **Model** | `openrouter/owl-alpha` |
| **Purpose** | Generate structured findings with full repository context |
| **Output** | Findings with severity, category, CWE IDs, code patches |
| **Context** | Symbol graph, tree-sitter index, vector embeddings |

### Pass 3: Cross-Examination (Owl Alpha)

| Property | Value |
|----------|-------|
| **Model** | `openrouter/owl-alpha` |
| **Purpose** | Attempt to DISPROVE every finding from Pass 2 |
| **Output** | Confirmed findings with adjusted confidence scores |
| **Effect** | Suppresses hallucinations and weak findings |

### Finding Schema

```json
{
  "finding_id": "uuid",
  "severity": "critical|high|medium|low|nit",
  "category": "correctness|security|performance|maintainability|tests|convention",
  "confidence": 0.0-1.0,
  "file_path": "src/app.ts",
  "line_number": 42,
  "title": "SQL Injection vulnerability",
  "description": "User input is directly concatenated into SQL query...",
  "suggestion": "Use parameterized queries instead...",
  "cwe_id": "CWE-89",
  "patch": "diff suggestion here"
}
```

---

## 8. API Endpoints

### Health Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Basic health check — returns `{"status":"ok"}` |
| `GET` | `/health/ready` | Readiness probe — returns `{"status":"ready","timestamp":"..."}` |
| `GET` | `/health/live` | Liveness probe |

### Webhook Endpoint

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/webhooks/github` | Receives GitHub webhook events |

**Headers required:**
- `X-GitHub-Event`: Event type (e.g., `pull_request`)
- `X-GitHub-Delivery`: Unique delivery ID
- `X-Hub-Signature-256`: HMAC signature for verification

### Example Health Check

```powershell
# Check health
Invoke-WebRequest -Uri 'http://localhost:3000/health'
# Response: {"status":"ok","info":{"memory_heap":{"status":"up"},"memory_rss":{"status":"up"}}}

# Check readiness
Invoke-WebRequest -Uri 'http://localhost:3000/health/ready'
# Response: {"status":"ready","timestamp":"2026-06-15T10:54:36.433Z"}
```

---

## 9. Configuration (`.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `NODE_ENV` | Yes | `development` or `production` |
| `PORT` | Yes | Server port (default: `3000`) |
| `DATABASE_TYPE` | Yes | `sqlite` (local) or `postgres` |
| `DATABASE_NAME` | Yes | Database name |
| `REDIS_HOST` | Yes | Redis host (default: `localhost`) |
| `REDIS_PORT` | Yes | Redis port (default: `6379`) |
| `REDIS_PASSWORD` | No | Redis password |
| `GITHUB_APP_ID` | Yes | Your GitHub App ID |
| `GITHUB_PRIVATE_KEY` | Yes | GitHub App private key (PEM format) |
| `GITHUB_WEBHOOK_SECRET` | Yes | Webhook secret for verification |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key |
| `OPENROUTER_BASE_URL` | No | OpenRouter base URL |
| `OPENROUTER_DEFAULT_MODEL` | No | Triage model (default: `google/gemini-2.5-flash`) |
| `OPENROUTER_REVIEW_MODEL` | No | Review model (default: `openrouter/owl-alpha`) |
| `SENTRY_DSN` | No | Sentry DSN for error tracking |
| `CONFIDENCE_THRESHOLD` | No | Minimum confidence for findings (default: `0.70`) |
| `MAX_RETRIES` | No | Max retry attempts (default: `3`) |
| `REVIEW_CONCURRENCY` | No | Concurrent reviews (default: `5`) |
| `REVIEW_TIMEOUT_MS` | No | Review timeout (default: `480000` = 8min) |
| `CLONE_BASE_PATH` | No | Path for cloned repos (default: `/tmp/reviewbot`) |

---

## 10. Runtime Logs Explained

### Startup Sequence

When the application starts, you'll see these logs in order:

```
[Nest] XXXX  - [timestamp] LOG [NestFactory] Starting Nest application...
```
The NestJS factory initializes the application.

```
[Nest] XXXX  - [timestamp] LOG [InstanceLoader] AppModule dependencies initialized +XXms
```
Each module's dependencies are loaded. The `+XXms` shows how long it took.

```
[Nest] XXXX  - [timestamp] LOG [RoutesResolver] IngestionController {/webhooks}: +XXms
[Nest] XXXX  - [timestamp] LOG [RouterExplorer] Mapped {/webhooks/github, POST} route +Xms
```
Routes are mapped — this shows which endpoints are available.

```
[ReviewBot] ReviewBot API running on port 3000
```
The application is ready to accept requests.

### Webhook Received

```
[Nest] XXXX  - [timestamp] LOG [IngestionController] Received GitHub webhook: event=pull_request, delivery=XXXXXXXX
```
A webhook was received from GitHub.

```
[Nest] XXXX  - [timestamp] LOG [IngestionService] Enqueued PR #N from owner/repo
```
The PR was enqueued for review.

### Review Processing — Detailed Pipeline Log

Each review is identified by a `reviewId` (UUID). Every pipeline stage logs its progress:

```
[ReviewProcessor] Created review UUID for PR #42 in owner/repo
[OrchestratorService] Review UUID: queued → cloning
[ReviewProcessor] [UUID] Cloning owner/repo@abc12345
[ReviewProcessor] [UUID] Clone complete: /tmp/reviewbot/owner-repo-abc12345
[OrchestratorService] Review UUID: cloning → indexing
[ReviewProcessor] [UUID] Indexing repository...
[ReviewProcessor] [UUID] Indexing complete
[OrchestratorService] Review UUID: indexing → triage
[ReviewProcessor] [UUID] Fetching PR diff...
[ReviewProcessor] [UUID] Diff parsed: 12 chunks
```
The repository is cloned, indexed, and the diff is parsed into chunks.

```
[ReviewProcessor] [UUID] Running static pre-filters (secrets, SQL injection, XSS, command injection, SSRF)...
[ReviewProcessor] [UUID] Static filters: 2 findings (1 secrets, 1 vulnerabilities)
```
Static pre-filters run before the LLM to catch issues cheaply.

```
[ReviewProcessor] [UUID] Retrieving repository context...
[ReviewProcessor] [UUID] Starting 3-pass LLM review (12 chunks)...
[ReviewProcessor] [UUID] LLM review complete: Pass 1 triaged 8/12 chunks, Pass 2 found 15 issues, Pass 3 suppressed 4 false positives, 13 total findings (2 static + 11 LLM)
```
The three-pass LLM review completes with detailed stats per pass.

```
[ReviewProcessor] [UUID] Post-processing 13 findings (dedup, confidence filter, ranking, comment cap)...
[PostProcessorService]   ↳ Deduplication: 13 → 11 (removed 2 duplicates)
[PostProcessorService]   ↳ Confidence filter (≥0.7): 11 → 9 (removed 2 low-confidence)
[PostProcessorService]   ↳ Ranked 9 findings by severity, confidence, category
[PostProcessorService]   ↳ Comment cap (25): 9 → 9 (no change)
[PostProcessorService] Post-processing complete: 13 → 9 findings (dedup, confidence, severity, ranking, cap)
[ReviewProcessor] [UUID] Post-processing complete: 13 → 9 findings
```
Post-processing filters and ranks findings with per-step transparency.

```
[ReviewProcessor] [UUID] Publishing 9 findings to PR #42...
[PublisherService] Publishing review for PR #42: 9 findings
[PublisherService] Published review UUID: 9 comments, check run: 12345
[OrchestratorService] Review UUID: publish → done
[ReviewProcessor] [UUID] ✅ Review complete in 45230ms. Published 9 findings to PR #42. Pipeline: 12 chunks → 8 triaged → 15 raw findings → 9 published (4 suppressed by cross-exam, 2 from static filters)
```
Final summary shows the complete pipeline throughput.

### Error States

```
ERROR [ReviewProcessor] Review UUID: cloning → failed
```
The review failed at the cloning step (e.g., repo not accessible).

```
ERROR [ReviewProcessor] Review UUID failed: <error message>
```
Specific error details.

```
[OrchestratorService] Review UUID: failed → queued
```
Automatic retry — the job goes back to the queue.

---

## 10.1. PR Review UI — What Developers See

### Inline Review Comments

Each finding is posted as an inline comment on the specific diff line. The comment includes:

```
🔴 **SQL Injection Vulnerability**

**Severity:** critical | **Category:** security | **Confidence:** 85%

**CWE:** CWE-89

**Issue:**
User input is directly concatenated into a SQL query string, allowing an attacker to inject arbitrary SQL.

**🔧 What the fix does:**
Replaces string concatenation with parameterized queries so the database driver automatically escapes user input, preventing SQL injection.

**Suggested fix:**
```suggestion
- const query = 'SELECT * FROM users WHERE id = ' + userId;
+ const query = 'SELECT * FROM users WHERE id = ?';
+ db.query(query, [userId]);
```
```

Key elements:
- **Issue** — explains the problem found in the code
- **🔧 What the fix does** — explains the remediation approach and why it works (the `fix_explanation` field)
- **Suggested fix** — the actual code patch (when `suggestion_type` is `committable`)

### Review Summary Comment

A summary comment is posted on the PR with:

```
## 🤖 ReviewBot Review Summary

**PR:** #42 — Fix user authentication
**Findings published:** 9

### By Severity
- 🔴 **critical**: 1
- 🟠 **high**: 2
- 🟡 **medium**: 4
- 🔵 **low**: 2

### By Category
- 🔒 **security**: 3
- 🐛 **correctness**: 2
- ⚡ **performance**: 1
- 🔧 **maintainability**: 3

### 📋 Findings & Fixes

| # | Severity | Category | File | Finding | What the fix does |
|---|----------|----------|------|---------|-------------------|
| 1 | 🔴 critical | security | `src/auth.ts:42` | **SQL Injection** | Replaces string concatenation with parameterized queries... |
| 2 | 🟠 high | security | `src/api.ts:15` | **XSS in template** | Sanitizes user input before rendering in HTML... |
...

---

### 🔍 Review Pipeline Log

| Stage | Detail |
|-------|--------|
| 📥 Diff parsed | 12 chunks from PR diff |
| 🔎 Pass 1: Triage | 8/12 chunks selected for deep review |
| 🛡️ Static filters | 2 findings (secrets, security patterns) |
| 🧠 Pass 2: Deep review | 15 raw findings from LLM |
| ⚖️ Pass 3: Cross-exam | 4 findings suppressed as false positives |
| 🧹 Post-processing | Removed 4 findings (2 duplicates, 2 low-confidence) |
| 📤 Published | **9** findings posted as inline comments |
| ⏱️ Total time | 45.2s |
```

The **Pipeline Log** table gives full transparency into how many findings were generated, filtered, and why — so developers understand the review quality and coverage.

---

## 11. Setting Up & Testing

### Prerequisites

- Node.js 20+
- ngrok (with authenticated account)
- GitHub App created on GitHub
- OpenRouter API key

### Step-by-Step Setup

**1. Install dependencies:**
```powershell
cd d:\anti ai\reviewbot
npm install
```

**2. Configure environment:**
Edit `.env` with your credentials (see Configuration section above).

**3. Start Redis:**
```powershell
$redisDir = 'C:\Users\User\AppData\Local\Microsoft\WinGet\Packages\taizod1024.redis-windows-fork_Microsoft.Winget.Source_8wekyb3d8bbwe\Redis-8.8.0-Windows-x64-msys2'
Start-Process -FilePath "$redisDir\redis-server.exe" -ArgumentList '--port 6379' -WindowStyle Hidden
```

**4. Start the app:**
```powershell
npm run start:dev
```

**5. Start ngrok:**
```powershell
ngrok http 3000
```

**6. Configure GitHub App webhook URL:**
Set it to: `https://<your-ngrok-url>/webhooks/github`

**7. Install the GitHub App on a test repository.**

**8. Create a Pull Request and watch the bot review it!**

---

## 12. Troubleshooting

### Redis Connection Refused

```
Error: connect ECONNREFUSED 127.0.0.1:6379
```

**Fix:** Start Redis server:
```powershell
$redisDir = 'C:\Users\User\AppData\Local\Microsoft\WinGet\Packages\taizod1024.redis-windows-fork_Microsoft.Winget.Source_8wekyb3d8bbwe\Redis-8.8.0-Windows-x64-msys2'
Start-Process -FilePath "$redisDir\redis-server.exe" -WindowStyle Hidden
```

### Redis Version Too Old

```
Error: Redis version needs to be greater or equal than 5.0.0 Current: 3.0.504
```

**Fix:** Install Redis 8.8 via winget:
```powershell
winget install taizod1024.redis-windows-fork --accept-package-agreements --accept-source-agreements
```

### ngrok Authentication Failed

```
ERROR: authentication failed: The authtoken you specified is properly formed, but it is invalid.
```

**Fix:** Get a fresh authtoken from [https://dashboard.ngrok.com/get-started/your-authtoken](https://dashboard.ngrok.com/get-started/your-authtoken)

### No Installation ID Found

```
ERROR [ReviewProcessor] Review UUID failed: No installation ID found for repository
```

**Fix:** Make sure:
1. The GitHub App is installed on the repository
2. The `GITHUB_APP_ID` in `.env` is correct
3. The `GITHUB_PRIVATE_KEY` is valid and not expired

### App Not Reloading After Code Changes

The app runs in `--watch` mode and should auto-reload. If it doesn't:
1. Check that the terminal is still running
2. Manually restart with `npm run start:dev`

---

## Module Dependency Graph

```
AppModule
├── ConfigModule (global)
├── ThrottlerModule (rate limiting: 100 req/min)
├── BullModule (Redis connection)
├── ScheduleModule (cron jobs)
├── TerminusModule (health checks)
├── CommonConfigModule
│   └── DatabaseModule (SQLite)
├── QueueModule (BullMQ queues: review, dead-letter)
├── GithubModule (GitHub API client)
├── DiffParserModule (git diff parsing)
├── ContextRetrievalModule (repo indexing)
├── StaticFiltersModule (pre-filters)
├── LlmEngineModule
│   └── OpenRouterProvider (LLM API)
├── PostProcessorModule (finding refinement)
├── PublisherModule (GitHub comments)
├── OrchestratorModule (state machine)
│   └── ReviewProcessor (job processor)
├── IngestionModule (webhook handler)
└── HealthModule (health endpoints)
```

---

*Last updated: 2026-06-16*
*Application version: 1.0.0*
*Framework: NestJS 10 + Node.js 20*
