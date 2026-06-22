import { Injectable, Logger } from '@nestjs/common';
import { DiffChunk } from '../diff-parser/diff-parser.service';
import { Severity, Category } from '../common/enums/finding.enums';
import { FindingDto } from '../common/dto/finding.dto';
import { v4 as uuidv4 } from 'uuid';
import { containsSecrets } from '../common/utils/redact-secrets';

export interface StaticFilterResult {
  findings: FindingDto[];
  skippedFiles: string[];
  metadata: {
    secretsDetected: number;
    vulnerabilitiesFound: number;
    lintErrors: number;
    dependencyIssues: number;
  };
}

const SQL_INJECTION_PATTERNS = [
  /execute\s*\(\s*["'`].*\+.*["'`]\s*\)/i,
  /query\s*\(\s*["'`].*\$\{.*\}.*["'`]\s*\)/i,
  /raw\s*\(\s*["'`].*\+.*["'`]\s*\)/i,
  /SELECT\s+.*\s+FROM\s+.*\+/i,
  /INSERT\s+INTO\s+.*\+/i,
  /UPDATE\s+.*\s+SET\s+.*\+/i,
  /DELETE\s+FROM\s+.*\+/i,
];

const XSS_PATTERNS = [
  /innerHTML\s*=\s*.*(?:req|params|query|body)/i,
  /dangerouslySetInnerHTML/i,
  /document\.write\s*\(/i,
  /eval\s*\(.*(?:req|params|query|body)/i,
  /\.html\s*\(.*(?:req|params|query|body)/i,
];

const COMMAND_INJECTION_PATTERNS = [
  /exec\s*\(.*(?:req|params|query|body)/i,
  /execSync\s*\(.*(?:req|params|query|body)/i,
  /child_process/i,
  /spawn\s*\(.*(?:req|params|query|body)/i,
];

const SSRF_PATTERNS = [
  /fetch\s*\(.*(?:req|params|query|body)/i,
  /axios\s*\.\w+\s*\(.*(?:req|params|query|body)/i,
  /http\.get\s*\(.*(?:req|params|query|body)/i,
  /request\s*\(.*(?:req|params|query|body)/i,
];

const HARDCODED_SECRET_PATTERNS = [
  /(?:password|passwd|pwd|secret|api[_-]?key|token|access[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/gi,
  /(?:AWS|AZURE|GCP)_?(?:ACCESS|SECRET|PRIVATE)_?(?:KEY|ID)\s*[:=]\s*['"][^'"]+['"]/gi,
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
];

@Injectable()
export class StaticFiltersService {
  private readonly logger = new Logger(StaticFiltersService.name);

  async runAll(chunks: DiffChunk[], rawDiff: string): Promise<StaticFilterResult> {
    const result: StaticFilterResult = {
      findings: [],
      skippedFiles: [],
      metadata: {
        secretsDetected: 0,
        vulnerabilitiesFound: 0,
        lintErrors: 0,
        dependencyIssues: 0,
      },
    };

    // Run all filters in parallel
    const [secretFindings, securityFindings] = await Promise.all([
      this.detectSecrets(chunks),
      this.scanSecurityPatterns(chunks),
    ]);

    result.findings.push(...secretFindings, ...securityFindings);
    result.metadata.secretsDetected = secretFindings.length;
    result.metadata.vulnerabilitiesFound = securityFindings.length;

    this.logger.log(
      `Static filters complete: ${result.findings.length} findings ` +
        `(${result.metadata.secretsDetected} secrets, ${result.metadata.vulnerabilitiesFound} vulnerabilities)`,
    );

    return result;
  }

  private async detectSecrets(chunks: DiffChunk[]): Promise<FindingDto[]> {
    const findings: FindingDto[] = [];

    for (const chunk of chunks) {
      for (const hunk of chunk.hunks) {
        let lineNum = hunk.newStart;
        for (const line of hunk.lines) {
          if (line.startsWith('+')) {
            const code = line.substring(1);

            for (const pattern of HARDCODED_SECRET_PATTERNS) {
              pattern.lastIndex = 0;
              if (pattern.test(code)) {
                findings.push({
                  finding_id: uuidv4(),
                  severity: Severity.CRITICAL,
                  category: Category.SECURITY,
                  confidence: 0.95,
                  cwe: 'CWE-798',
                  file: chunk.file,
                  start_line: lineNum,
                  end_line: lineNum,
                  side: 'RIGHT' as any,
                  title: 'Hardcoded Secret Detected',
                  explanation:
                    'A hardcoded secret (password, API key, or token) was detected in the code. ' +
                    'Secrets should never be committed to source control.',
                  fix_explanation:
                    'Removes the hardcoded secret and uses environment variables or a secrets manager instead. ' +
                    'This prevents credential exposure in source control and allows secure rotation of secrets.',
                  suggestion: {
                    type: 'prose' as any,
                    patch:
                      'Remove the hardcoded secret and use environment variables or a secrets manager instead.',
                  },
                  evidence_refs: [chunk.id],
                });
                break;
              }
            }
          }
          if (!line.startsWith('-')) {
            lineNum++;
          }
        }
      }
    }

    return findings;
  }

  private async scanSecurityPatterns(chunks: DiffChunk[]): Promise<FindingDto[]> {
    const findings: FindingDto[] = [];

    for (const chunk of chunks) {
      for (const hunk of chunk.hunks) {
        let lineNum = hunk.newStart;
        for (const line of hunk.lines) {
          if (line.startsWith('+')) {
            const code = line.substring(1);

            // SQL Injection
            for (const pattern of SQL_INJECTION_PATTERNS) {
              if (pattern.test(code)) {
                findings.push({
                  finding_id: uuidv4(),
                  severity: Severity.CRITICAL,
                  category: Category.SECURITY,
                  confidence: 0.85,
                  cwe: 'CWE-89',
                  file: chunk.file,
                  start_line: lineNum,
                  end_line: lineNum,
                  side: 'RIGHT' as any,
                  title: 'Potential SQL Injection',
                  explanation:
                    'User input appears to be concatenated directly into a SQL query. ' +
                    'This creates a SQL injection vulnerability.',
                  fix_explanation:
                    'Replaces string concatenation with parameterized queries so the database driver ' +
                    'automatically escapes user input, preventing SQL injection attacks.',
                  suggestion: {
                    type: 'prose' as any,
                    patch: 'Use parameterized queries or prepared statements.',
                  },
                  evidence_refs: [chunk.id],
                });
                break;
              }
            }

            // XSS
            for (const pattern of XSS_PATTERNS) {
              if (pattern.test(code)) {
                findings.push({
                  finding_id: uuidv4(),
                  severity: Severity.HIGH,
                  category: Category.SECURITY,
                  confidence: 0.80,
                  cwe: 'CWE-79',
                  file: chunk.file,
                  start_line: lineNum,
                  end_line: lineNum,
                  side: 'RIGHT' as any,
                  title: 'Potential Cross-Site Scripting (XSS)',
                  explanation:
                    'User input appears to be rendered directly into HTML without sanitization.',
                  fix_explanation:
                    'Sanitizes user input before rendering it in HTML, preventing cross-site scripting (XSS) attacks. ' +
                    'Framework-provided escaping ensures all dangerous characters are neutralized.',
                  suggestion: {
                    type: 'prose' as any,
                    patch: 'Sanitize user input before rendering. Use framework-provided escaping.',
                  },
                  evidence_refs: [chunk.id],
                });
                break;
              }
            }

            // Command Injection
            for (const pattern of COMMAND_INJECTION_PATTERNS) {
              if (pattern.test(code)) {
                findings.push({
                  finding_id: uuidv4(),
                  severity: Severity.CRITICAL,
                  category: Category.SECURITY,
                  confidence: 0.85,
                  cwe: 'CWE-78',
                  file: chunk.file,
                  start_line: lineNum,
                  end_line: lineNum,
                  side: 'RIGHT' as any,
                  title: 'Potential Command Injection',
                  explanation:
                    'User input appears to be passed to a system command execution function.',
                  fix_explanation:
                    'Removes user input from shell command execution and validates/sanitizes all input. ' +
                    'This prevents attackers from injecting arbitrary commands through user-controlled data.',
                  suggestion: {
                    type: 'prose' as any,
                    patch: 'Validate and sanitize input. Avoid shell execution with user input.',
                  },
                  evidence_refs: [chunk.id],
                });
                break;
              }
            }

            // SSRF
            for (const pattern of SSRF_PATTERNS) {
              if (pattern.test(code)) {
                findings.push({
                  finding_id: uuidv4(),
                  severity: Severity.HIGH,
                  category: Category.SECURITY,
                  confidence: 0.75,
                  cwe: 'CWE-918',
                  file: chunk.file,
                  start_line: lineNum,
                  end_line: lineNum,
                  side: 'RIGHT' as any,
                  title: 'Potential Server-Side Request Forgery (SSRF)',
                  explanation:
                    'User input appears to be used directly in an HTTP request URL.',
                  fix_explanation:
                    'Validates and whitelists URLs before making HTTP requests. ' +
                    'This prevents attackers from using the server to access internal resources or external endpoints.',
                  suggestion: {
                    type: 'prose' as any,
                    patch: 'Validate and whitelist allowed URLs. Do not allow user-controlled URLs.',
                  },
                  evidence_refs: [chunk.id],
                });
                break;
              }
            }
          }
          if (!line.startsWith('-')) {
            lineNum++;
          }
        }
      }
    }

    return findings;
  }
}
