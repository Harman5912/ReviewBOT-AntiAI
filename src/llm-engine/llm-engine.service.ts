import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { OpenRouterProvider, ChatMessage } from './providers/openrouter.provider';
import { DiffChunk } from '../diff-parser/diff-parser.service';
import { RetrievalContext } from '../context-retrieval/context-retrieval.service';
import { StaticFilterResult } from '../static-filters/static-filters.service';
import { FindingDto } from '../common/dto/finding.dto';
import { Severity, Category, SuggestionType, Side } from '../common/enums/finding.enums';
import { v4 as uuidv4 } from 'uuid';
import { truncateToTokenBudget } from '../common/utils/token-utils';
import { SettingsService } from '../dashboard/settings.service';

interface ReviewInput {
  chunks: DiffChunk[];
  diff: string;
  context: RetrievalContext;
  staticResults: StaticFilterResult;
  config?: any;
  userPrompt?: string;
}

interface ReviewOutput {
  findings: FindingDto[];
  triagedChunks: DiffChunk[];
  summary: string;
  metadata: {
    pass1Chunks: number;
    pass2Findings: number;
    pass3Suppressed: number;
    totalTokensUsed: number;
  };
}

const PASS1_SYSTEM_PROMPT = `You are a senior software engineer performing initial triage on code changes.
Your task is to quickly identify which code hunks deserve deep review.

For each hunk, output a JSON object with:
- "hunk_id": the chunk identifier
- "needs_review": boolean - whether this hunk needs deep review
- "priority": "high" | "medium" | "low" - how important deep review is
- "reason": brief explanation of why it does/doesn't need review
- "categories": array of categories that might apply (correctness, security, performance, maintainability, tests, convention)

Be conservative - if in doubt, mark for review. Focus on:
- Logic changes (not formatting)
- Security-sensitive areas
- Public API changes
- Database queries
- Authentication/authorization code
- Error handling changes
- New dependencies`;

const PASS2_SYSTEM_PROMPT = `You are ReviewBot, an expert AI code reviewer. You perform deep, thorough code review with the goal of finding real issues while minimizing false positives.

Review the provided code changes carefully. For each finding, provide structured output.

RULES:
1. Only report issues you are confident about (confidence >= 0.70)
2. Never report formatting issues unless they violate project conventions
3. Always provide actionable suggestions
4. Map findings to specific diff lines
5. Include CWE identifiers for security issues
6. Consider the full repository context provided
7. Do NOT report issues that are already covered by static analysis
8. Be precise - vague findings erode trust

Output a JSON array of findings with this structure:
[
  {
    "severity": "critical|high|medium|low|nit",
    "category": "correctness|security|performance|maintainability|tests|convention",
    "confidence": 0.0-1.0,
    "cwe": "CWE-XXX or empty string",
    "file": "path/to/file",
    "start_line": number,
    "end_line": number,
    "title": "Brief title",
    "explanation": "Detailed explanation of the issue",
    "fix_explanation": "A clear, concise explanation of WHAT the suggested fix does and WHY it resolves the issue. Focus on the remediation, not the problem. Example: 'Replaces string concatenation with parameterized query so the database driver automatically escapes user input, preventing SQL injection.'",
    "suggestion_type": "committable|prose|none",
    "suggestion_patch": "Code suggestion or empty string",
    "evidence_refs": ["chunk_id"]
  }
]`;

const PASS3_SYSTEM_PROMPT = `You are ReviewBot's cross-examination engine. Your job is to DISPROVE findings, not confirm them.

For each finding below, critically evaluate:
1. Is this a real issue or a false positive?
2. Could the code actually work correctly in context?
3. Is the suggested fix correct and safe?
4. Is the severity appropriate?

For each finding, output:
- "finding_id": the original finding identifier
- "verdict": "confirm" | "suppress" | "downgrade"
- "reason": explanation of your decision
- "adjusted_severity": if downgrading, the new severity
- "adjusted_confidence": adjusted confidence score

Be aggressive about suppressing weak findings. Only confirm findings that are clearly real issues.
Suppress findings where:
- The code is actually correct
- The finding is based on incomplete context
- The suggestion would introduce a bug
- The issue is purely stylistic without convention violation
- The confidence is below 0.70`;

@Injectable()
export class LlmEngineService implements OnModuleInit {
  private readonly logger = new Logger(LlmEngineService.name);

  constructor(
    private readonly openRouter: OpenRouterProvider,
    private readonly settingsService: SettingsService,
  ) {}

  onModuleInit(): void {
    this.syncFromSettings();
  }

  /** Sync provider config from settings */
  syncFromSettings(): void {
    const provider = this.settingsService.getActiveProvider();
    const model = this.settingsService.getActiveModel();
    if (provider) {
      this.openRouter.configure(provider.apiKey, provider.baseUrl, model);
      this.logger.log(`LLM synced: provider=${provider.id}, model=${model}`);
    }
  }

  /** Generate free-form text from the LLM (used for code generation, file identification, etc.) */
  async generateText(
    prompt: string,
    options?: { maxTokens?: number; temperature?: number; model?: string },
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: 'user', content: prompt },
    ];
    return this.openRouter.chat(messages, {
      model: options?.model || this.openRouter.getReviewModel(),
      maxTokens: options?.maxTokens || 8192,
      temperature: options?.temperature ?? 0.2,
    });
  }

  async review(input: ReviewInput): Promise<ReviewOutput> {
    const { chunks, diff, context, staticResults, userPrompt } = input;

    if (userPrompt) {
      // RE-REVIEW mode: Deep scan with user instructions — skip triage, review all chunks
      this.logger.log(`Re-review mode: Deep scanning ${chunks.length} chunks with user instructions`);
      const findings = await this.reviewWithUserPrompt(
        chunks,
        diff,
        context,
        staticResults,
        userPrompt,
      );
      const allFindings = [...staticResults.findings, ...findings];
      return {
        findings: allFindings,
        triagedChunks: chunks,
        summary: `Re-review complete: ${allFindings.length} findings based on user instructions`,
        metadata: {
          pass1Chunks: chunks.length,
          pass2Findings: findings.length,
          pass3Suppressed: 0,
          totalTokensUsed: 0,
        },
      };
    }

    // INITIAL REVIEW mode: 3-pass pipeline with triage
    // PASS 1: Triage - determine which hunks deserve deep review
    this.logger.log(`Pass 1: Triaging ${chunks.length} chunks`);
    const triagedChunks = await this.pass1Triage(chunks);

    // PASS 2: Deep review with Owl Alpha
    this.logger.log(`Pass 2: Deep review of ${triagedChunks.length} chunks`);
    const pass2Findings = await this.pass2DeepReview(
      triagedChunks,
      diff,
      context,
      staticResults,
    );

    // PASS 3: Cross-examination
    this.logger.log(`Pass 3: Cross-examining ${pass2Findings.length} findings`);
    const { confirmedFindings, suppressedCount } = await this.pass3CrossExamine(
      pass2Findings,
      triagedChunks,
      context,
    );

    // Merge static filter findings with LLM findings
    const allFindings = [...staticResults.findings, ...confirmedFindings];

    return {
      findings: allFindings,
      triagedChunks,
      summary: `Review complete: ${allFindings.length} findings (${suppressedCount} suppressed)`,
      metadata: {
        pass1Chunks: triagedChunks.length,
        pass2Findings: pass2Findings.length,
        pass3Suppressed: suppressedCount,
        totalTokensUsed: 0, // Tracked by provider
      },
    };
  }

  /** Deep review with user instructions — skips triage, reviews all chunks with focus on user prompt */
  private async reviewWithUserPrompt(
    chunks: DiffChunk[],
    diff: string,
    context: RetrievalContext,
    staticResults: StaticFilterResult,
    userPrompt: string,
  ): Promise<FindingDto[]> {
    const findings: FindingDto[] = [];
    const batchSize = 5;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const batchFindings = await this.reviewChunkBatchWithPrompt(
        batch,
        diff,
        context,
        staticResults,
        userPrompt,
      );
      findings.push(...batchFindings);
    }

    return findings;
  }

  private async reviewChunkBatchWithPrompt(
    chunks: DiffChunk[],
    diff: string,
    context: RetrievalContext,
    staticResults: StaticFilterResult,
    userPrompt: string,
  ): Promise<FindingDto[]> {
    const chunksContext = chunks.map((c) => ({
      id: c.id,
      file: c.file,
      language: c.metadata.language,
      content: c.hunks.map((h) => h.lines.join('\n')).join('\n'),
      startLine: c.startLine,
      endLine: c.endLine,
    }));

    const existingFindings = staticResults.findings.map((f) => ({
      file: f.file,
      title: f.title,
      severity: f.severity,
    }));

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: `You are ReviewBot, an expert AI code reviewer performing a DEEP, THOROUGH scan of code changes.

The user has provided specific instructions for what to focus on. Your job is to:
1. Read ALL code changes carefully
2. Find issues that match the user's specific instructions
3. Also catch any other critical issues you notice
4. For each finding, provide a detailed explanation and actionable fix suggestions

RULES:
- Only report issues you are confident about (confidence >= 0.60)
- Always provide actionable suggestions with code patches when possible
- Map findings to specific diff lines
- Include CWE identifiers for security issues
- Consider the full repository context provided
- Be thorough — the user is asking for a deep scan
- Report formatting issues only if they violate project conventions

Output a JSON array of findings with this structure:
[
  {
    "severity": "critical|high|medium|low|nit",
    "category": "correctness|security|performance|maintainability|tests|convention",
    "confidence": 0.0-1.0,
    "cwe": "CWE-XXX or empty string",
    "file": "path/to/file",
    "start_line": number,
    "end_line": number,
    "title": "Brief title",
    "explanation": "Detailed explanation of the issue",
    "fix_explanation": "A clear, concise explanation of WHAT the suggested fix does and WHY it resolves the issue",
    "suggestion_type": "committable|prose|none",
    "suggestion_patch": "Code suggestion or empty string",
    "evidence_refs": ["chunk_id"]
  }
]`,
      },
      {
        role: 'user',
        content: `Perform a deep code review focusing on the user's instructions.

## User Instructions (PRIMARY FOCUS — prioritize this above all else):
${userPrompt}

## Code Chunks to Review:
${JSON.stringify(chunksContext, null, 2)}

## Repository Context:
Symbols: ${JSON.stringify(context.symbols.slice(0, 30))}
Related files: ${Array.from(context.relatedFiles.keys()).join(', ')}

## Already Detected by Static Analysis (do not duplicate):
${JSON.stringify(existingFindings, null, 2)}

Provide your findings as a JSON array. Be thorough and focus on what the user asked about.`,
      },
    ];

    try {
      const result = await this.openRouter.chatJson(messages, {
        model: this.openRouter.getReviewModel(),
        maxTokens: 8192,
        temperature: 0.15,
      });

      if (!result || !Array.isArray(result)) {
        return [];
      }

      return result.map((item: any) => ({
        finding_id: uuidv4(),
        severity: item.severity || Severity.MEDIUM,
        category: item.category || Category.CORRECTNESS,
        confidence: Math.min(Math.max(item.confidence || 0.7, 0), 1),
        cwe: item.cwe || '',
        file: item.file || chunks[0]?.file || '',
        start_line: item.start_line || 0,
        end_line: item.end_line || 0,
        side: Side.RIGHT,
        title: item.title || 'Untitled Finding',
        explanation: item.explanation || '',
        fix_explanation: item.fix_explanation || '',
        suggestion: {
          type: item.suggestion_type || SuggestionType.PROSE,
          patch: item.suggestion_patch || '',
        },
        evidence_refs: item.evidence_refs || [],
      }));
    } catch (error) {
      this.logger.error(`Re-review batch failed: ${(error as Error).message}`);
      return [];
    }
  }

  async triageOnly(chunks: DiffChunk[]): Promise<FindingDto[]> {
    const findings: FindingDto[] = [];

    for (const chunk of chunks) {
      findings.push({
        finding_id: uuidv4(),
        severity: Severity.MEDIUM,
        category: Category.MAINTAINABILITY,
        confidence: 0.5,
        file: chunk.file,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        side: Side.RIGHT,
        title: 'Large PR - Triage Only Review',
        explanation:
          `This PR is too large for a full automated review (${chunks.length} chunks). ` +
          'A human reviewer should perform a thorough review.',
        suggestion: {
          type: SuggestionType.PROSE,
          patch: 'Consider breaking this PR into smaller, focused changes.',
        },
        evidence_refs: [chunk.id],
      });
    }

    return findings.slice(0, 5);
  }

  private async pass1Triage(chunks: DiffChunk[]): Promise<DiffChunk[]> {
    if (chunks.length === 0) return [];

    const chunksData = chunks.map((c) => ({
      id: c.id,
      file: c.file,
      language: c.metadata.language,
      startLine: c.startLine,
      endLine: c.endLine,
      content: c.hunks.map((h) => h.lines.join('\n')).join('\n'),
    }));

    const messages: ChatMessage[] = [
      { role: 'system', content: PASS1_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Review these code hunks and determine which need deep review:\n\n${JSON.stringify(chunksData, null, 2)}`,
      },
    ];

    try {
      const result = await this.openRouter.chatJson(messages, {
        model: this.openRouter.getDefaultModel(),
        maxTokens: 4096,
        temperature: 0.1,
      });

      if (!result || !Array.isArray(result)) {
        this.logger.warn('Pass 1: Invalid response, reviewing all chunks');
        return chunks;
      }

      const triageMap = new Map<string, any>();
      for (const item of result) {
        if (item.hunk_id) {
          triageMap.set(item.hunk_id, item);
        }
      }

      return chunks.filter((chunk) => {
        const triage = triageMap.get(chunk.id);
        return !triage || triage.needs_review !== false;
      });
    } catch (error) {
      this.logger.error(`Pass 1 failed: ${(error as Error).message}`);
      return chunks; // Review all chunks on failure
    }
  }

  private async pass2DeepReview(
    chunks: DiffChunk[],
    diff: string,
    context: RetrievalContext,
    staticResults: StaticFilterResult,
    userPrompt?: string,
  ): Promise<FindingDto[]> {
    const findings: FindingDto[] = [];

    // Process chunks in batches to stay within context limits
    const batchSize = 5;
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const batchFindings = await this.reviewChunkBatch(
        batch,
        diff,
        context,
        staticResults,
        userPrompt,
      );
      findings.push(...batchFindings);
    }

    return findings;
  }

  private async reviewChunkBatch(
    chunks: DiffChunk[],
    diff: string,
    context: RetrievalContext,
    staticResults: StaticFilterResult,
    userPrompt?: string,
  ): Promise<FindingDto[]> {
    const chunksContext = chunks.map((c) => ({
      id: c.id,
      file: c.file,
      language: c.metadata.language,
      content: c.hunks.map((h) => h.lines.join('\n')).join('\n'),
      startLine: c.startLine,
      endLine: c.endLine,
    }));

    const existingFindings = staticResults.findings.map((f) => ({
      file: f.file,
      title: f.title,
      severity: f.severity,
    }));

    // Build user prompt section if provided
    const userPromptSection = userPrompt
      ? `\n\n## User Instructions (IMPORTANT — prioritize these):\n${userPrompt}\n`
      : '';

    const messages: ChatMessage[] = [
      { role: 'system', content: PASS2_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Review the following code changes:

## Code Chunks:
${JSON.stringify(chunksContext, null, 2)}

## Repository Context:
Symbols: ${JSON.stringify(context.symbols.slice(0, 20))}
Related files: ${Array.from(context.relatedFiles.keys()).join(', ')}

## Already Detected (do not duplicate):
${JSON.stringify(existingFindings, null, 2)}${userPromptSection}

Provide your findings as a JSON array.`,
      },
    ];

    try {
      const result = await this.openRouter.chatJson(messages, {
        model: this.openRouter.getReviewModel(),
        maxTokens: 8192,
        temperature: 0.1,
      });

      if (!result || !Array.isArray(result)) {
        return [];
      }

      return result.map((item: any) => ({
        finding_id: uuidv4(),
        severity: item.severity || Severity.MEDIUM,
        category: item.category || Category.CORRECTNESS,
        confidence: Math.min(Math.max(item.confidence || 0.7, 0), 1),
        cwe: item.cwe || '',
        file: item.file || chunks[0]?.file || '',
        start_line: item.start_line || 0,
        end_line: item.end_line || 0,
        side: Side.RIGHT,
        title: item.title || 'Untitled Finding',
        explanation: item.explanation || '',
        fix_explanation: item.fix_explanation || this.generateFixExplanation(item),
        suggestion: {
          type: item.suggestion_type || SuggestionType.PROSE,
          patch: item.suggestion_patch || '',
        },
        evidence_refs: item.evidence_refs || [],
      }));
    } catch (error) {
      this.logger.error(`Pass 2 batch failed: ${(error as Error).message}`);
      return [];
    }
  }

  private async pass3CrossExamine(
    findings: FindingDto[],
    chunks: DiffChunk[],
    context: RetrievalContext,
  ): Promise<{ confirmedFindings: FindingDto[]; suppressedCount: number }> {
    if (findings.length === 0) {
      return { confirmedFindings: [], suppressedCount: 0 };
    }

    const findingsForReview = findings.map((f) => ({
      finding_id: f.finding_id,
      severity: f.severity,
      category: f.category,
      confidence: f.confidence,
      file: f.file,
      title: f.title,
      explanation: f.explanation,
      suggestion: f.suggestion,
    }));

    const messages: ChatMessage[] = [
      { role: 'system', content: PASS3_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Cross-examine these findings:

## Findings:
${JSON.stringify(findingsForReview, null, 2)}

## Code Context:
${chunks.map((c) => `File: ${c.file}\n${c.hunks.map((h) => h.lines.join('\n')).join('\n')}`).join('\n\n')}

Provide your verdicts as a JSON array.`,
      },
    ];

    try {
      const result = await this.openRouter.chatJson(messages, {
        model: this.openRouter.getReviewModel(),
        maxTokens: 8192,
        temperature: 0.1,
      });

      if (!result || !Array.isArray(result)) {
        this.logger.warn('Pass 3: Invalid response, confirming all findings');
        return { confirmedFindings: findings, suppressedCount: 0 };
      }

      const verdictMap = new Map<string, any>();
      for (const item of result) {
        if (item.finding_id) {
          verdictMap.set(item.finding_id, item);
        }
      }

      const confirmedFindings: FindingDto[] = [];
      let suppressedCount = 0;

      for (const finding of findings) {
        const verdict = verdictMap.get(finding.finding_id);

        if (!verdict || verdict.verdict === 'suppress') {
          suppressedCount++;
          this.logger.debug(
            `Suppressed: ${finding.title} - ${verdict?.reason || 'no verdict'}`,
          );
          continue;
        }

        if (verdict.verdict === 'downgrade' && verdict.adjusted_severity) {
          finding.severity = verdict.adjusted_severity;
          finding.confidence = verdict.adjusted_confidence ?? finding.confidence;
        }

        confirmedFindings.push(finding);
      }

      return { confirmedFindings, suppressedCount };
    } catch (error) {
      this.logger.error(`Pass 3 failed: ${(error as Error).message}`);
      return { confirmedFindings: findings, suppressedCount: 0 };
    }
  }

  /**
   * Generates a fallback fix_explanation when the LLM doesn't provide one.
   * Derives a human-readable remediation explanation from the finding data.
   */
  private generateFixExplanation(item: any): string {
    const suggestionType = item.suggestion_type || 'none';
    const patch = item.suggestion_patch || '';
    const title = item.title || 'This issue';
    const cwe = item.cwe || '';

    if (suggestionType === 'none' || !patch) {
      return `Review the code at the indicated location. ${title} should be addressed to resolve this ${item.category || 'code quality'} concern.`;
    }

    const cweNote = cwe ? ` (${cwe})` : '';

    // Security-specific templates
    if (item.category === 'security') {
      if (cwe === 'CWE-89') {
        return 'Replaces string concatenation with parameterized queries so the database driver automatically escapes user input, preventing SQL injection.';
      }
      if (cwe === 'CWE-79') {
        return 'Sanitizes user input before rendering it in HTML, preventing cross-site scripting (XSS) attacks.';
      }
      if (cwe === 'CWE-78') {
        return 'Removes user input from shell command execution, preventing command injection. Input is validated and sanitized before use.';
      }
      if (cwe === 'CWE-918') {
        return 'Validates and whitelists URLs before making HTTP requests, preventing Server-Side Request Forgery (SSRF).';
      }
      if (cwe === 'CWE-798') {
        return 'Removes the hardcoded secret and uses environment variables or a secrets manager instead, preventing credential exposure.';
      }
      return `Applies a security fix${cweNote} to address the ${item.severity} severity vulnerability. The suggested patch ensures the code follows security best practices.`;
    }

    // General fix explanation
    if (suggestionType === 'committable') {
      return `Applies the suggested code change to fix: ${title}${cweNote}. The patch directly addresses the root cause identified in the explanation.`;
    }

    return `Suggested remediation for: ${title}${cweNote}. ${item.explanation ? 'The fix addresses the issue: ' + item.explanation.substring(0, 120) : 'Follow the suggestion to resolve this issue.'}`;
  }
}
