import { Injectable, Logger } from '@nestjs/common';
import { FindingDto } from '../common/dto/finding.dto';
import { ReviewContext } from '../orchestrator/orchestrator.service';
import { GithubService } from '../github/github.service';
import { Severity } from '../common/enums/finding.enums';

const SEVERITY_RANK: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  nit: 1,
};

/** Processing stats passed from the review pipeline for transparency logging */
interface ProcessingStats {
  /** Total findings from LLM (before post-processing) */
  rawFindings: number;
  /** Findings removed by deduplication */
  deduplicated: number;
  /** Findings removed by confidence filter */
  confidenceFiltered: number;
  /** Findings removed by severity filter */
  severityFiltered: number;
  /** Findings removed by comment cap */
  capped: number;
  /** Findings suppressed by cross-examination (Pass 3) */
  crossExamSuppressed: number;
  /** Static filter findings (secrets, security patterns) */
  staticFindings: number;
  /** Chunks triaged in Pass 1 */
  triagedChunks: number;
  /** Total chunks in the diff */
  totalChunks: number;
  /** Review processing time in ms */
  elapsedMs: number;
}

interface PublishInput {
  review: ReviewContext;
  findings: FindingDto[];
  repository: Record<string, any>;
  pullRequest: Record<string, any>;
  /** Optional processing stats for transparency logging */
  processingStats?: ProcessingStats;
}

interface PublishResult {
  reviewId: string;
  commentsPosted: number;
  checkRunId?: string;
  summary: string;
}

@Injectable()
export class PublisherService {
  private readonly logger = new Logger(PublisherService.name);

  constructor(private readonly github: GithubService) {}

  async publish(input: PublishInput): Promise<PublishResult> {
    const { review, findings, repository, pullRequest, processingStats } = input;

    this.logger.log(
      `Publishing review for PR #${pullRequest.number}: ${findings.length} findings`,
    );

    // Generate review summary with processing transparency
    const summary = this.generateSummary(findings, pullRequest, processingStats);

    // Batch comments to avoid notification spam
    const commentBatches = this.batchComments(findings, 5);

    let totalComments = 0;

    // Post inline comments in batches
    for (const batch of commentBatches) {
      for (const finding of batch) {
        try {
          await this.github.postReviewComment(
            repository,
            pullRequest.number,
            {
              body: this.formatComment(finding),
              path: finding.file,
              line: finding.end_line,
              side: finding.side,
            },
          );
          totalComments++;
        } catch (error) {
          this.logger.warn(
            `Failed to post comment for ${finding.finding_id}: ${(error as Error).message}`,
          );
        }
      }

      // Small delay between batches to avoid rate limiting
      if (commentBatches.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    // Post summary comment
    try {
      await this.github.postIssueComment(
        repository,
        pullRequest.number,
        summary,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to post summary: ${(error as Error).message}`,
      );
    }

    // Create check run
    let checkRunId: string | undefined;
    try {
      const checkResult = await this.github.createCheckRun(repository, {
        name: 'ReviewBot',
        head_sha: pullRequest.head.sha,
        status: 'completed',
        conclusion: this.determineConclusion(findings),
        output: {
          title: `ReviewBot: ${findings.length} findings`,
          summary: this.generateCheckSummary(findings),
        },
      });
      checkRunId = checkResult?.id?.toString();
    } catch (error) {
      this.logger.warn(
        `Failed to create check run: ${(error as Error).message}`,
      );
    }

    this.logger.log(
      `Published review ${review.reviewId}: ${totalComments} comments, check run: ${checkRunId || 'none'}`,
    );

    return {
      reviewId: review.reviewId,
      commentsPosted: totalComments,
      checkRunId,
      summary,
    };
  }

  private generateSummary(
    findings: FindingDto[],
    pr: any,
    stats?: ProcessingStats,
  ): string {
    const bySeverity: Record<string, number> = {};
    const byCategory: Record<string, number> = {};

    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
      byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    }

    const severityEmoji: Record<string, string> = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🔵',
      nit: '⚪',
    };

    const categoryEmoji: Record<string, string> = {
      security: '🔒',
      correctness: '🐛',
      performance: '⚡',
      maintainability: '🔧',
      tests: '🧪',
      convention: '📏',
    };

    let s = `## 🤖 ReviewBot Review Summary\n\n`;
    s += `**PR:** #${pr.number} — ${pr.title}\n`;
    s += `**Findings published:** ${findings.length}\n\n`;

    if (findings.length === 0) {
      s += `✅ No significant issues found. Looks good!\n`;
    } else {
      // Severity breakdown
      s += `### By Severity\n`;
      for (const [sev, count] of Object.entries(bySeverity).sort(
        (a, b) => (SEVERITY_RANK[b[0]] || 0) - (SEVERITY_RANK[a[0]] || 0),
      )) {
        const emoji = severityEmoji[sev] || '⚪';
        s += `- ${emoji} **${sev}**: ${count}\n`;
      }

      // Category breakdown
      s += `\n### By Category\n`;
      for (const [cat, count] of Object.entries(byCategory)) {
        const emoji = categoryEmoji[cat] || '📋';
        s += `- ${emoji} **${cat}**: ${count}\n`;
      }

      // Detailed findings table with fix explanations
      s += `\n### 📋 Findings & Fixes\n\n`;
      s += `| # | Severity | Category | File | Finding | What the fix does |\n`;
      s += `|---|----------|----------|------|---------|-------------------|\n`;

      findings.forEach((f, i) => {
        const emoji = severityEmoji[f.severity] || '⚪';
        const fileShort = f.file.length > 25 ? '...' + f.file.slice(-22) : f.file;
        const fixSummary = (f.fix_explanation || 'See inline comment')
          .replace(/\|/g, '\\|')
          .replace(/\n/g, ' ')
          .substring(0, 80);
        s += `| ${i + 1} | ${emoji} ${f.severity} | ${f.category} | \`${fileShort}:${f.start_line}\` | **${f.title}** | ${fixSummary} |\n`;
      });

      // Callout for critical/high
      const criticalCount = bySeverity['critical'] || 0;
      const highCount = bySeverity['high'] || 0;

      if (criticalCount > 0) {
        s += `\n> ⚠️ **${criticalCount} critical issue(s) require immediate attention.**\n`;
      }
      if (highCount > 0) {
        s += `\n> ⚠️ **${highCount} high severity issue(s) should be addressed.**\n`;
      }
    }

    // Processing transparency log
    if (stats) {
      s += `\n\n---\n\n### 🔍 Review Pipeline Log\n\n`;
      s += `| Stage | Detail |\n`;
      s += `|-------|--------|\n`;
      s += `| 📥 Diff parsed | ${stats.totalChunks} chunks from PR diff |\n`;
      s += `| 🔎 Pass 1: Triage | ${stats.triagedChunks}/${stats.totalChunks} chunks selected for deep review |\n`;
      s += `| 🛡️ Static filters | ${stats.staticFindings} findings (secrets, security patterns) |\n`;
      s += `| 🧠 Pass 2: Deep review | ${stats.rawFindings} raw findings from LLM |\n`;
      s += `| ⚖️ Pass 3: Cross-exam | ${stats.crossExamSuppressed} findings suppressed as false positives |\n`;

      const postProcessRemoved =
        stats.deduplicated +
        stats.confidenceFiltered +
        stats.severityFiltered +
        stats.capped;
      if (postProcessRemoved > 0) {
        s += `| 🧹 Post-processing | Removed ${postProcessRemoved} findings `;
        const filters: string[] = [];
        if (stats.deduplicated > 0) filters.push(`${stats.deduplicated} duplicates`);
        if (stats.confidenceFiltered > 0) filters.push(`${stats.confidenceFiltered} low-confidence`);
        if (stats.severityFiltered > 0) filters.push(`${stats.severityFiltered} below severity threshold`);
        if (stats.capped > 0) filters.push(`${stats.capped} over comment cap`);
        s += `(${filters.join(', ')}) |\n`;
      }

      s += `| 📤 Published | **${findings.length}** findings posted as inline comments |\n`;
      s += `| ⏱️ Total time | ${(stats.elapsedMs / 1000).toFixed(1)}s |\n`;
    }

    s += `\n---\n*Generated by [ReviewBot](https://reviewbot.dev) — High-Signal AI PR Review Agent*`;

    return s;
  }

  private formatComment(finding: FindingDto): string {
    const severityEmoji: Record<string, string> = {
      critical: '🔴',
      high: '🟠',
      medium: '🟡',
      low: '🔵',
      nit: '⚪',
    };

    let comment = `${severityEmoji[finding.severity] || '⚪'} **${finding.title}**\n\n`;
    comment += `**Severity:** ${finding.severity} | **Category:** ${finding.category} | **Confidence:** ${Math.round(finding.confidence * 100)}%\n\n`;

    if (finding.cwe) {
      comment += `**CWE:** ${finding.cwe}\n\n`;
    }

    // Problem explanation
    comment += `**Issue:**\n${finding.explanation}\n`;

    // Fix explanation — what the fix does and why
    if (finding.fix_explanation) {
      comment += `\n**🔧 What the fix does:**\n${finding.fix_explanation}\n`;
    }

    // Suggested code patch or prose suggestion
    if (finding.suggestion?.type === 'committable' && finding.suggestion.patch) {
      comment += `\n**Suggested fix:**\n\`\`\`suggestion\n${finding.suggestion.patch}\n\`\`\`\n`;
    } else if (finding.suggestion?.type === 'prose' && finding.suggestion.patch) {
      comment += `\n**Suggestion:** ${finding.suggestion.patch}\n`;
    }

    return comment;
  }

  private batchComments(
    findings: FindingDto[],
    batchSize: number,
  ): FindingDto[][] {
    const batches: FindingDto[][] = [];
    for (let i = 0; i < findings.length; i += batchSize) {
      batches.push(findings.slice(i, i + batchSize));
    }
    return batches;
  }

  private determineConclusion(findings: FindingDto[]): string {
    const hasCritical = findings.some((f) => f.severity === Severity.CRITICAL);
    const hasHigh = findings.some((f) => f.severity === Severity.HIGH);

    if (hasCritical) return 'failure';
    if (hasHigh) return 'neutral';
    return 'success';
  }

  private generateCheckSummary(findings: FindingDto[]): string {
    if (findings.length === 0) {
      return 'No issues found! 🎉';
    }

    const bySeverity: Record<string, number> = {};
    for (const f of findings) {
      bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
    }

    const parts: string[] = [];
    for (const [sev, count] of Object.entries(bySeverity)) {
      parts.push(`${count} ${sev}`);
    }

    return `Found ${findings.length} issue(s): ${parts.join(', ')}`;
  }
}
