import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface RepoConfig {
  repoFullName: string;
  confidenceThreshold: number;
  maxComments: number;
  severityThreshold: string;
  enabled: boolean;
  customRules: string[];
}

const CONFIG_FILE = path.join(process.cwd(), '.reviewbot-repo-configs.json');

@Injectable()
export class RepoConfigService {
  private readonly logger = new Logger(RepoConfigService.name);

  getConfig(repoFullName: string): RepoConfig {
    const configs = this.loadConfigs();
    const existing = configs.find(c => c.repoFullName === repoFullName);
    if (existing) return existing;
    // Return defaults
    return {
      repoFullName,
      confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.70'),
      maxComments: 50,
      severityThreshold: 'low',
      enabled: true,
      customRules: [],
    };
  }

  updateConfig(repoFullName: string, updates: Partial<RepoConfig>): void {
    const configs = this.loadConfigs();
    const idx = configs.findIndex(c => c.repoFullName === repoFullName);
    if (idx >= 0) {
      configs[idx] = { ...configs[idx], ...updates };
    } else {
      configs.push({ repoFullName, ...this.getDefaultConfig(repoFullName), ...updates });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(configs, null, 2), 'utf-8');
    this.logger.log(`Config updated for ${repoFullName}`);
  }

  getAllConfigs(): RepoConfig[] {
    return this.loadConfigs();
  }

  private getDefaultConfig(repoFullName: string): RepoConfig {
    return {
      repoFullName,
      confidenceThreshold: parseFloat(process.env.CONFIDENCE_THRESHOLD || '0.70'),
      maxComments: 50,
      severityThreshold: 'low',
      enabled: true,
      customRules: [],
    };
  }

  private loadConfigs(): RepoConfig[] {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      }
    } catch (error) {
      this.logger.warn(`Failed to load configs: ${(error as Error).message}`);
    }
    return [];
  }
}
