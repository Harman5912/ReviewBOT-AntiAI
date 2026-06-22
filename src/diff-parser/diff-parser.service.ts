import { Injectable, Logger } from '@nestjs/common';
import * as diff from 'diff';
import { redactSecrets } from '../common/utils/redact-secrets';

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  header: string;
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'mode_change';
  additions: number;
  deletions: number;
  binary: boolean;
  hunks: DiffHunk[];
  language?: string;
  isGenerated?: boolean;
  isVendor?: boolean;
}

export interface DiffChunk {
  id: string;
  file: string;
  hunks: DiffHunk[];
  contextLines: string[];
  startLine: number;
  endLine: number;
  tokenCount: number;
  metadata: {
    language?: string;
    isGenerated: boolean;
    isVendor: boolean;
    isBinary: boolean;
    isRename: boolean;
  };
}

export interface ParseOptions {
  repoFullName: string;
  prNumber: number;
  maxChunkTokens?: number;
  contextLines?: number;
}

const GENERATED_FILE_PATTERNS = [
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'go.sum',
  'Cargo.lock',
  '*.min.js',
  '*.min.css',
  'generated/**',
  'dist/**',
  'build/**',
  '*.generated.*',
  'graphql.ts',
  'proto/**',
];

const VENDOR_FILE_PATTERNS = [
  'node_modules/**',
  'vendor/**',
  'third_party/**',
  'bower_components/**',
  '.yarn/**',
];

const BINARY_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
  '.pdf', '.zip', '.tar', '.gz', '.rar', '.7z',
  '.exe', '.dll', '.so', '.dylib',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp3', '.mp4', '.avi', '.mov',
  '.wasm', '.pyc', '.class',
];

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.scala': 'scala',
  '.sh': 'bash',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.md': 'markdown',
  '.sql': 'sql',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

@Injectable()
export class DiffParserService {
  private readonly logger = new Logger(DiffParserService.name);

  async parseAndChunk(
    rawDiff: string,
    options: ParseOptions,
  ): Promise<DiffChunk[]> {
    const { maxChunkTokens = 4000, contextLines = 3 } = options;

    if (!rawDiff || rawDiff.trim().length === 0) {
      this.logger.warn('Empty diff received');
      return [];
    }

    const fileDiffs = this.parseUnifiedDiff(rawDiff);
    this.logger.log(
      `Parsed ${fileDiffs.length} file diffs from PR #${options.prNumber}`,
    );

    const chunks: DiffChunk[] = [];
    let chunkIndex = 0;

    for (const fileDiff of fileDiffs) {
      if (fileDiff.binary) {
        this.logger.debug(`Skipping binary file: ${fileDiff.path}`);
        continue;
      }

      if (fileDiff.status === 'mode_change') {
        this.logger.debug(`Skipping mode change: ${fileDiff.path}`);
        continue;
      }

      if (this.isGeneratedFile(fileDiff.path)) {
        this.logger.debug(`Skipping generated file: ${fileDiff.path}`);
        continue;
      }

      if (this.isVendorFile(fileDiff.path)) {
        this.logger.debug(`Skipping vendor file: ${fileDiff.path}`);
        continue;
      }

      if (fileDiff.hunks.length === 0) {
        continue;
      }

      const fileChunks = this.chunkFileDiff(fileDiff, maxChunkTokens, chunkIndex);
      chunks.push(...fileChunks);
      chunkIndex += fileChunks.length;
    }

    this.logger.log(
      `Created ${chunks.length} chunks from ${fileDiffs.length} files`,
    );

    return chunks;
  }

  private parseUnifiedDiff(rawDiff: string): FileDiff[] {
    const files: FileDiff[] = [];
    const fileHeaders = rawDiff.split(/^diff --git /m).slice(1);

    for (const fileSection of fileHeaders) {
      try {
        const fileDiff = this.parseFileSection(fileSection);
        if (fileDiff) {
          files.push(fileDiff);
        }
      } catch (error) {
        this.logger.warn(
          `Failed to parse file diff section: ${(error as Error).message}`,
        );
      }
    }

    return files;
  }

  private parseFileSection(section: string): FileDiff | null {
    const lines = section.split('\n');
    const firstLine = lines[0];

    const pathMatch = firstLine.match(/^"?(.+?)"?\s+"?(.+?)"?$/);
    if (!pathMatch) return null;

    const oldPath = pathMatch[1].replace(/^a\//, '');
    const newPath = pathMatch[2].replace(/^b\//, '');

    let status: FileDiff['status'] = 'modified';
    let binary = false;
    let additions = 0;
    let deletions = 0;

    let path = newPath;
    if (oldPath !== newPath) {
      status = 'renamed';
      path = newPath;
    }

    const hunks: DiffHunk[] = [];
    let currentHunk: Partial<DiffHunk> | null = null;
    let hunkLines: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('new file mode')) {
        status = 'added';
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        status = 'deleted';
        continue;
      }
      if (line.startsWith('similarity index')) {
        status = 'renamed';
        continue;
      }
      if (line.startsWith('old mode') || line.startsWith('new mode')) {
        if (!lines[i + 1]?.startsWith('@@')) {
          status = 'mode_change';
        }
        continue;
      }
      if (line.includes('Binary files') || line.startsWith('GIT binary patch')) {
        binary = true;
        continue;
      }

      const hunkHeaderMatch = line.match(
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/,
      );
      if (hunkHeaderMatch) {
        if (currentHunk) {
          hunks.push({
            ...currentHunk,
            lines: hunkLines,
          } as DiffHunk);
        }

        const oldStart = parseInt(hunkHeaderMatch[1], 10);
        const oldLines = parseInt(hunkHeaderMatch[2] || '1', 10);
        const newStart = parseInt(hunkHeaderMatch[3], 10);
        const newLines = parseInt(hunkHeaderMatch[4] || '1', 10);

        currentHunk = {
          oldStart,
          oldLines,
          newStart,
          newLines,
          header: hunkHeaderMatch[5]?.trim() || '',
        };
        hunkLines = [];
        continue;
      }

      if (currentHunk) {
        hunkLines.push(line);
        if (line.startsWith('+') && !line.startsWith('+++')) {
          additions++;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          deletions++;
        }
      }
    }

    if (currentHunk) {
      hunks.push({
        ...currentHunk,
        lines: hunkLines,
      } as DiffHunk);
    }

    const extension = '.' + (path.split('.').pop() || '');

    return {
      path,
      oldPath: status === 'renamed' ? oldPath : undefined,
      status,
      additions,
      deletions,
      binary,
      hunks,
      language: LANGUAGE_MAP[extension],
      isGenerated: this.isGeneratedFile(path),
      isVendor: this.isVendorFile(path),
    };
  }

  private chunkFileDiff(
    fileDiff: FileDiff,
    maxTokens: number,
    startIndex: number,
  ): DiffChunk[] {
    const chunks: DiffChunk[] = [];
    let currentHunks: DiffHunk[] = [];
    let currentTokens = 0;
    let chunkIdx = 0;

    for (const hunk of fileDiff.hunks) {
      const hunkContent = hunk.lines.join('\n');
      const hunkTokens = Math.ceil(hunkContent.length / 4);

      if (currentTokens + hunkTokens > maxTokens && currentHunks.length > 0) {
        chunks.push(this.createChunk(fileDiff, currentHunks, startIndex + chunkIdx));
        chunkIdx++;
        currentHunks = [];
        currentTokens = 0;
      }

      currentHunks.push(hunk);
      currentTokens += hunkTokens;
    }

    if (currentHunks.length > 0) {
      chunks.push(this.createChunk(fileDiff, currentHunks, startIndex + chunkIdx));
    }

    return chunks;
  }

  private createChunk(
    fileDiff: FileDiff,
    hunks: DiffHunk[],
    index: number,
  ): DiffChunk {
    const allLines = hunks.flatMap((h) => h.lines);
    const content = allLines.join('\n');

    return {
      id: `chunk-${index}-${fileDiff.path.replace(/\//g, '-')}`,
      file: fileDiff.path,
      hunks,
      contextLines: [],
      startLine: hunks[0].newStart,
      endLine: hunks[hunks.length - 1].newStart + hunks[hunks.length - 1].newLines,
      tokenCount: Math.ceil(content.length / 4),
      metadata: {
        language: fileDiff.language,
        isGenerated: fileDiff.isGenerated || false,
        isVendor: fileDiff.isVendor || false,
        isBinary: fileDiff.binary,
        isRename: fileDiff.status === 'renamed',
      },
    };
  }

  private isGeneratedFile(path: string): boolean {
    return GENERATED_FILE_PATTERNS.some((pattern) =>
      this.matchesGlob(path, pattern),
    );
  }

  private isVendorFile(path: string): boolean {
    return VENDOR_FILE_PATTERNS.some((pattern) =>
      this.matchesGlob(path, pattern),
    );
  }

  private isBinaryFile(path: string): boolean {
    const ext = '.' + (path.split('.').pop() || '');
    return BINARY_EXTENSIONS.includes(ext.toLowerCase());
  }

  private matchesGlob(path: string, pattern: string): boolean {
    const regex = pattern
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${regex}$`).test(path);
  }
}
