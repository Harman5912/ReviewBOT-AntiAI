import { Injectable, Logger } from '@nestjs/common';
import { FindingDto } from '../common/dto/finding.dto';
import { Severity, SEVERITY_ORDER } from '../common/enums/finding.enums';
import { hashContent } from '../common/utils/crypto';

export interface PostProcessOptions {
  confidenceThreshold: number;
  maxComments: number;
  repoFullName: string;
  severityThreshold?: Severity;
}

@Injectable()
export class PostProcessorService {
  private readonly logger = new Logger(PostProcessorService.name);
  private readonly publishedFindings = new Map<string, Set<string>>();

  async process(
    findings: FindingDto[],
    options: PostProcessOptions,
  ): Promise<FindingDto[]> {
    this.logger.log(
      `Post-processing ${findings.length} findings (threshold: ${options.confidenceThreshold}, max: ${options.maxComments})`,
    );

    let processed = [...findings];
    const inputCount = findings.length;

    // Step 1: Deduplication
    const preDedup = processed.length;
    processed = this.deduplicate(processed);
    if (processed.length < preDedup) {
      this.logger.log(
        `  ↳ Deduplication: ${preDedup} → ${processed.length} (removed ${preDedup - processed.length} duplicates)`,
      );
    }

    // Step 2: Confidence filtering
    const preConfidence = processed.length;
    processed = this.filterByConfidence(
      processed,
      options.confidenceThreshold,
    );
    if (processed.length < preConfidence) {
      this.logger.log(
        `  ↳ Confidence filter (≥${options.confidenceThreshold}): ${preConfidence} → ${processed.length} (removed ${preConfidence - processed.length} low-confidence)`,
      );
    }

    // Step 3: Severity threshold filtering
    if (options.severityThreshold) {
      const preSeverity = processed.length;
      processed = this.filterBySeverity(
        processed,
        options.severityThreshold,
      );
      if (processed.length < preSeverity) {
        this.logger.log(
          `  ↳ Severity filter (≥${options.severityThreshold}): ${preSeverity} → ${processed.length} (removed ${preSeverity - processed.length} below threshold)`,
        );
      }
    }

    // Step 4: Ranking
    processed = this.rank(processed);
    this.logger.log(`  ↳ Ranked ${processed.length} findings by severity, confidence, category`);

    // Step 5: Comment cap
    const preCap = processed.length;
    processed = this.applyCommentCap(processed, options.maxComments);
    if (processed.length < preCap) {
      this.logger.log(
        `  ↳ Comment cap (${options.maxComments}): ${preCap} → ${processed.length} (removed ${preCap - processed.length} lower-priority)`,
      );
    }

    // Step 6: Diff-line mapping validation
    processed = this.validateDiffLineMapping(processed);

    // Step 7: Flip-flop detection
    processed = await this.detectFlipFlops(processed, options.repoFullName);

    this.logger.log(
      `Post-processing complete: ${inputCount} → ${processed.length} findings ` +
        `(dedup, confidence, severity, ranking, cap)`,
    );

    return processed;
  }

  private deduplicate(findings: FindingDto[]): FindingDto[] {
    const seen = new Map<string, FindingDto>();

    for (const finding of findings) {
      const key = this.createDedupKey(finding);
      const existing = seen.get(key);

      if (!existing) {
        seen.set(key, finding);
      } else if (finding.confidence > existing.confidence) {
        seen.set(key, finding);
      }
    }

    return Array.from(seen.values());
  }

  private createDedupKey(finding: FindingDto): string {
    const normalizedTitle = finding.title.toLowerCase().trim();
    return `${finding.file}:${finding.start_line}:${finding.end_line}:${normalizedTitle}`;
  }

  private filterByConfidence(
    findings: FindingDto[],
    threshold: number,
  ): FindingDto[] {
    return findings.filter((f) => {
      if (f.confidence < threshold) {
        this.logger.debug(
          `Filtered by confidence: ${f.title} (${f.confidence} < ${threshold})`,
        );
        return false;
      }
      return true;
    });
  }

  private filterBySeverity(
    findings: FindingDto[],
    threshold: Severity,
  ): FindingDto[] {
    const thresholdLevel = SEVERITY_ORDER[threshold];
    return findings.filter((f) => SEVERITY_ORDER[f.severity] >= thresholdLevel);
  }

  private rank(findings: FindingDto[]): FindingDto[] {
    return findings.sort((a, b) => {
      // Primary: severity (highest first)
      const severityDiff =
        SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
      if (severityDiff !== 0) return severityDiff;

      // Secondary: confidence (highest first)
      const confidenceDiff = b.confidence - a.confidence;
      if (confidenceDiff !== 0) return confidenceDiff;

      // Tertiary: category priority
      const categoryPriority: Record<string, number> = {
        security: 5,
        correctness: 4,
        performance: 3,
        maintainability: 2,
        tests: 1,
        convention: 0,
      };
      return (
        (categoryPriority[b.category] || 0) -
        (categoryPriority[a.category] || 0)
      );
    });
  }

  private applyCommentCap(
    findings: FindingDto[],
    maxComments: number,
  ): FindingDto[] {
    if (findings.length <= maxComments) {
      return findings;
    }

    this.logger.log(
      `Applying comment cap: ${findings.length} → ${maxComments}`,
    );

    // Always include critical and high severity findings
    const critical = findings.filter(
      (f) => f.severity === Severity.CRITICAL,
    );
    const high = findings.filter((f) => f.severity === Severity.HIGH);
    const rest = findings.filter(
      (f) => f.severity !== Severity.CRITICAL && f.severity !== Severity.HIGH,
    );

    const capped = [...critical, ...high];
    const remaining = maxComments - capped.length;

    if (remaining > 0) {
      capped.push(...rest.slice(0, remaining));
    }

    return capped;
  }

  private validateDiffLineMapping(findings: FindingDto[]): FindingDto[] {
    return findings.filter((f) => {
      if (f.start_line <= 0 || f.end_line < f.start_line) {
        this.logger.debug(
          `Invalid line mapping: ${f.title} (${f.start_line}-${f.end_line})`,
        );
        return false;
      }
      if (f.end_line - f.start_line > 100) {
        this.logger.debug(
          `Suspiciously large range: ${f.title} (${f.end_line - f.start_line} lines)`,
        );
      }
      return true;
    });
  }

  private async detectFlipFlops(
    findings: FindingDto[],
    repoFullName: string,
  ): Promise<FindingDto[]> {
    const repoKey = repoFullName;
    const previousHashes = this.publishedFindings.get(repoKey) || new Set();
    const currentHashes = new Set<string>();
    const result: FindingDto[] = [];

    for (const finding of findings) {
      const hash = hashContent(
        `${finding.file}:${finding.start_line}:${finding.title}:${finding.explanation}`,
      );
      currentHashes.add(hash);

      if (previousHashes.has(hash)) {
        this.logger.debug(`Flip-flop detected: ${finding.title}`);
        // Reduce confidence for flip-flopped findings
        finding.confidence = Math.max(finding.confidence - 0.15, 0);
      }

      result.push(finding);
    }

    this.publishedFindings.set(repoKey, currentHashes);
    return result;
  }
}
