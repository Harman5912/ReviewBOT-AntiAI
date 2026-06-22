import { Injectable, Logger } from '@nestjs/common';
import { DiffChunk } from '../diff-parser/diff-parser.service';
import { estimateTokenCount } from '../common/utils/token-utils';

interface SymbolDefinition {
  name: string;
  file: string;
  line: number;
  type: string;
  signature?: string;
  references: string[];
}

interface IndexedRepository {
  repoFullName: string;
  symbols: Map<string, SymbolDefinition>;
  fileIndex: Map<string, string>;
  lastIndexed: Date;
  treeSitterAsts: Map<string, any>;
}

export interface RetrievalContext {
  symbols: SymbolDefinition[];
  relatedFiles: Map<string, string>;
  astNodes: any[];
  embeddings: number[][];
  tokenBudget: {
    total: number;
    used: number;
    remaining: number;
  };
}

const DEFAULT_TOKEN_BUDGET = 15000;

@Injectable()
export class ContextRetrievalService {
  private readonly logger = new Logger(ContextRetrievalService.name);
  private readonly indexCache = new Map<string, IndexedRepository>();
  private readonly MAX_CACHE_SIZE = 100;

  async indexRepository(
    repoFullName: string,
    clonePath: string,
  ): Promise<void> {
    this.logger.log(`Indexing repository: ${repoFullName}`);

    const existing = this.indexCache.get(repoFullName);
    if (existing && Date.now() - existing.lastIndexed.getTime() < 3600000) {
      this.logger.log(`Using cached index for ${repoFullName}`);
      return;
    }

    const indexed: IndexedRepository = {
      repoFullName,
      symbols: new Map(),
      fileIndex: new Map(),
      lastIndexed: new Date(),
      treeSitterAsts: new Map(),
    };

    // In production, this would walk the file tree, parse with tree-sitter,
    // extract symbols, build a symbol graph, and compute embeddings.
    // For now, we set up the structure.

    this.indexCache.set(repoFullName, indexed);

    if (this.indexCache.size > this.MAX_CACHE_SIZE) {
      const oldest = this.indexCache.keys().next().value;
      if (oldest) this.indexCache.delete(oldest);
    }

    this.logger.log(`Indexed ${repoFullName}`);
  }

  async retrieveContext(
    chunks: DiffChunk[],
    repoFullName: string,
    options?: { maxTokens?: number },
  ): Promise<RetrievalContext> {
    const maxTokens = options?.maxTokens || DEFAULT_TOKEN_BUDGET;
    const indexed = this.indexCache.get(repoFullName);

    if (!indexed) {
      this.logger.warn(`No index found for ${repoFullName}`);
      return {
        symbols: [],
        relatedFiles: new Map(),
        astNodes: [],
        embeddings: [],
        tokenBudget: { total: maxTokens, used: 0, remaining: maxTokens },
      };
    }

    const context: RetrievalContext = {
      symbols: [],
      relatedFiles: new Map(),
      astNodes: [],
      embeddings: [],
      tokenBudget: { total: maxTokens, used: 0, remaining: maxTokens },
    };

    // Collect referenced symbols from chunks
    const referencedSymbols = this.extractReferencedSymbols(chunks);

    // Retrieve symbol definitions
    for (const symbolName of referencedSymbols) {
      if (context.tokenBudget.remaining <= 0) break;

      const symbol = indexed.symbols.get(symbolName);
      if (symbol) {
        const symbolText = `${symbol.name}: ${symbol.signature || symbol.type}`;
        const tokens = estimateTokenCount(symbolText);

        if (tokens <= context.tokenBudget.remaining) {
          context.symbols.push(symbol);
          context.tokenBudget.used += tokens;
          context.tokenBudget.remaining -= tokens;
        }
      }
    }

    // Retrieve related files
    const affectedFiles = new Set(chunks.map((c) => c.file));
    for (const file of affectedFiles) {
      if (context.tokenBudget.remaining <= 0) break;

      const fileContent = indexed.fileIndex.get(file);
      if (fileContent) {
        const tokens = estimateTokenCount(fileContent);
        if (tokens <= context.tokenBudget.remaining) {
          context.relatedFiles.set(file, fileContent);
          context.tokenBudget.used += tokens;
          context.tokenBudget.remaining -= tokens;
        }
      }
    }

    this.logger.log(
      `Retrieved context for ${repoFullName}: ${context.symbols.length} symbols, ` +
        `${context.relatedFiles.size} files, ${context.tokenBudget.used} tokens used`,
    );

    return context;
  }

  private extractReferencedSymbols(chunks: DiffChunk[]): Set<string> {
    const symbols = new Set<string>();

    for (const chunk of chunks) {
      for (const hunk of chunk.hunks) {
        for (const line of hunk.lines) {
          if (line.startsWith('+') || line.startsWith(' ')) {
            const code = line.substring(1);

            // Extract identifiers
            const identifiers = code.match(/\b[A-Z][a-zA-Z0-9_]*\b/g);
            if (identifiers) {
              identifiers.forEach((id) => symbols.add(id));
            }

            // Extract function calls
            const funcCalls = code.match(/\b([a-z][a-zA-Z0-9_]*)\s*\(/g);
            if (funcCalls) {
              funcCalls.forEach((call) => {
                const name = call.replace(/\s*\($/, '');
                symbols.add(name);
              });
            }
          }
        }
      }
    }

    return symbols;
  }

  async updateIncremental(
    repoFullName: string,
    changedFiles: string[],
  ): Promise<void> {
    const indexed = this.indexCache.get(repoFullName);
    if (!indexed) return;

    for (const file of changedFiles) {
      indexed.symbols.forEach((symbol, key) => {
        if (symbol.file === file) {
          indexed.symbols.delete(key);
        }
      });
      indexed.fileIndex.delete(file);
      indexed.treeSitterAsts.delete(file);
    }

    indexed.lastIndexed = new Date();
    this.logger.log(`Incremental update for ${repoFullName}: ${changedFiles.length} files`);
  }
}
