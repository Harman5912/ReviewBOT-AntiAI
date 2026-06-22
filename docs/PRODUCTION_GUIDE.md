# Production Deployment Guide

## Architecture Overview

```
GitHub/GitLab Webhooks
        ↓
   Ingestion API (NestJS)
        ↓
   Event Queue (BullMQ + Redis)
        ↓
   Review Orchestrator (State Machine)
        ↓
   Diff Parser & Chunker
        ↓
   Context Retrieval (Tree-sitter + Embeddings)
        ↓
   Static Pre-Filters (Secrets, Security, Linters)
        ↓
   LLM Review Engine (OpenRouter + Owl Alpha)
        ↓
   Finding Post Processor (Dedup, Rank, Filter)
        ↓
   Publisher (GitHub Comments + Check Runs)
```

## Deployment

### Docker Compose (Recommended for small-medium scale)

```bash
# Clone the repository
git clone <repo-url>
cd reviewbot

# Create production .env
cp .env.example .env
# Edit with production values

# Start all services
docker-compose up -d

# Scale workers
docker-compose up -d --scale worker=4
```

### Kubernetes (For large-scale deployments)

See `k8s/` directory for Kubernetes manifests.

## Scaling Guidelines

| Scale | Workers | Redis | PostgreSQL | Concurrency |
|-------|---------|-------|------------|-------------|
| Small (< 100 repos) | 2 | 512MB | 1 vCPU, 2GB | 5 |
| Medium (< 1,000 repos) | 4 | 2GB | 2 vCPU, 4GB | 10 |
| Large (< 10,000 repos) | 8+ | 4GB | 4 vCPU, 8GB | 20 |

## Monitoring

### Health Endpoints

- `GET /health` - Overall health check
- `GET /health/ready` - Readiness probe
- `GET /health/live` - Liveness probe

### Key Metrics to Monitor

- **Review latency** (p50, p90, p99)
- **Queue depth** (waiting, active, failed)
- **Finding acceptance rate** (target ≥ 60%)
- **False positive rate** (target ≤ 15%)
- **API rate limit remaining**
- **Error rate** (target < 0.1%)

### Sentry Integration

Set `SENTRY_DSN` in your environment. All unhandled exceptions are automatically captured.

## Security Checklist

- [ ] Webhook signature verification enabled
- [ ] HMAC secrets rotated regularly
- [ ] Per-tenant encryption configured
- [ ] Secret redaction active (no secrets sent to LLMs)
- [ ] Audit logging enabled
- [ ] Zero-retention mode configured
- [ ] GitHub App permissions set to least privilege
- [ ] Database connections encrypted (SSL)
- [ ] Redis password protected
- [ ] Rate limiting configured

## Backup & Recovery

### Database Backups

```bash
# Automated daily backup
pg_dump -h localhost -U reviewbot reviewbot | gzip > backup-$(date +%Y%m%d).sql.gz
```

### Redis Persistence

Redis is configured with AOF persistence by default in docker-compose.

## Troubleshooting

### High Queue Depth

```bash
# Check queue stats
docker-compose exec api node -e "console.log('check /health')"

# Scale up workers
docker-compose up -d --scale worker=6
```

### Failed Reviews

Check the dead letter queue:
```bash
# View failed jobs
docker-compose exec redis redis-cli LRANGE bull:dead-letter:waiting 0 -1
```

### Rate Limiting

Monitor GitHub API rate limits:
```bash
curl -H "Authorization: token <token>" https://api.github.com/rate_limit
```

## Performance Targets

| Metric | Target |
|--------|--------|
| p50 latency | ≤ 90 seconds |
| p90 latency | ≤ 3 minutes |
| p99 latency | ≤ 8 minutes |
| Availability | 99.9% |
| Burst capacity | 1,000 reviews/min |
| Avg cost per review | ≤ $0.40 |
