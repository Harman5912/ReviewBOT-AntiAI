import { Controller, Get, Post, Param, Query, Body, Res } from '@nestjs/common';
import { Response } from 'express';
import { DashboardService } from './dashboard.service';
import { SettingsService } from './settings.service';
import * as fs from 'fs';
import * as path from 'path';

@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly settingsService: SettingsService,
  ) {}

  // ── Data API ──

  @Get('api/stats')
  getStats() {
    return this.dashboardService.getStats();
  }

  @Get('api/reviews')
  getReviews() {
    return this.dashboardService.getRecentReviews(50);
  }

  @Get('api/reviews/:id')
  getReview(@Param('id') id: string) {
    return this.dashboardService.getReviewDetail(id);
  }

  @Get('api/reviews/:id/findings')
  getFindings(@Param('id') id: string) {
    return this.dashboardService.getReviewFindings(id);
  }

  @Get('api/reviews/:id/logs')
  getLogs(@Param('id') id: string) {
    return this.dashboardService.getReviewLogs(id);
  }

  // ── GitHub integration ──

  @Get('api/github/installations')
  listInstallations() {
    return this.dashboardService.listInstallations();
  }

  @Get('api/github/installations/:id/repos')
  async listRepos(@Param('id') id: string) {
    try {
      const repos = await this.dashboardService.listRepos(parseInt(id, 10));
      return repos;
    } catch (error: any) {
      // Return a structured error so the frontend can show helpful guidance
      return {
        error: true,
        message: error.message,
        hint: 'The GitHub App needs "Repository permissions: Metadata (Read-only)" or "Contents: Read-only". Go to GitHub → Settings → GitHub Apps → Your App → Permissions.',
        docsUrl: 'https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-user-access-token',
      };
    }
  }

  @Get('api/github/repos/:owner/:repo/prs')
  listPRs(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Query('state') state?: string,
  ) {
    return this.dashboardService.listPRs(owner, repo, state);
  }

  // ── Review actions ──

  @Post('api/review')
  runReview(@Body() body: { owner: string; repo: string; prNumber: number }) {
    return this.dashboardService.runReview(body.owner, body.repo, body.prNumber);
  }

  @Post('api/review-branch')
  runBranchReview(@Body() body: { owner: string; repo: string; branch: string }) {
    return this.dashboardService.runBranchReview(body.owner, body.repo, body.branch);
  }

  @Post('api/apply-fixes')
  applyFixes(@Body() body: {
    owner: string;
    repo: string;
    prNumber: number;
    findings: Array<{ file: string; suggestion_patch: string; title: string }>;
  }) {
    return this.dashboardService.applyFixes(
      body.owner,
      body.repo,
      body.prNumber,
      body.findings,
    );
  }

  // ── Interactive review actions ──

  /** Publish approved findings as PR review comments */
  @Post('api/reviews/:id/publish')
  publishReview(
    @Param('id') reviewId: string,
    @Body() body: {
      owner: string;
      repo: string;
      prNumber: number;
      approvedFindingIndices: number[];
    },
  ) {
    return this.dashboardService.publishReview(
      reviewId,
      body.owner,
      body.repo,
      body.prNumber,
      body.approvedFindingIndices,
    );
  }

  /** Reject a review — dismiss all findings without publishing */
  @Post('api/reviews/:id/reject')
  rejectReview(@Param('id') reviewId: string) {
    return this.dashboardService.rejectReview(reviewId);
  }

  /** Re-run review with a user-provided prompt for additional focus */
  @Post('api/reviews/:id/re-review')
  reReview(
    @Param('id') reviewId: string,
    @Body() body: {
      owner: string;
      repo: string;
      prNumber: number;
      prompt: string;
    },
  ) {
    return this.dashboardService.reReviewWithPrompt(
      reviewId,
      body.owner,
      body.repo,
      body.prNumber,
      body.prompt,
    );
  }

  /** Apply fixes directly to the reviewbot-test branch */
  @Post('api/reviews/:id/apply-to-branch')
  applyToBranch(
    @Param('id') reviewId: string,
    @Body() body: {
      owner: string;
      repo: string;
      prNumber: number;
      approvedFindingIndices: number[];
      targetBranch?: string;
    },
  ) {
    return this.dashboardService.applyFixesToBranch(
      reviewId,
      body.owner,
      body.repo,
      body.prNumber,
      body.approvedFindingIndices,
      body.targetBranch || 'reviewbot-test',
    );
  }

  // ── Branch management ──

  /** List all branches for a repository */
  @Get('api/github/repos/:owner/:repo/branches')
  listBranches(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
  ) {
    return this.dashboardService.listBranches(owner, repo);
  }

  /** Get branch sync status (ahead/behind default branch) */
  @Get('api/github/repos/:owner/:repo/branches/:branch/sync')
  getBranchSync(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('branch') branch: string,
  ) {
    return this.dashboardService.getBranchSync(owner, repo, branch);
  }

  /** Sync a branch with the default branch (merge main into it) */
  @Post('api/github/repos/:owner/:repo/branches/:branch/sync')
  syncBranch(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('branch') branch: string,
  ) {
    return this.dashboardService.syncBranch(owner, repo, branch);
  }

  /** Read a file from a branch */
  @Get('api/github/repos/:owner/:repo/branches/:branch/file')
  readFile(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('branch') branch: string,
    @Query('path') filePath: string,
  ) {
    return this.dashboardService.readFile(owner, repo, branch, filePath);
  }

  /** List files in a directory on a branch */
  @Get('api/github/repos/:owner/:repo/branches/:branch/files')
  listFiles(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('branch') branch: string,
    @Query('path') dirPath?: string,
  ) {
    return this.dashboardService.listFiles(owner, repo, branch, dirPath || '');
  }

  /** Write/update a file on a branch */
  @Post('api/github/repos/:owner/:repo/branches/:branch/file')
  writeFile(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('branch') branch: string,
    @Body() body: { path: string; content: string; commitMessage: string },
  ) {
    return this.dashboardService.writeFile(
      owner,
      repo,
      branch,
      body.path,
      body.content,
      body.commitMessage,
    );
  }

  /** Write multiple files to a branch */
  @Post('api/github/repos/:owner/:repo/branches/:branch/files')
  writeFiles(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('branch') branch: string,
    @Body() body: { files: Array<{ path: string; content: string }>; commitMessage: string },
  ) {
    return this.dashboardService.writeFiles(
      owner,
      repo,
      branch,
      body.files,
      body.commitMessage,
    );
  }

  /** Create a PR from a branch */
  @Post('api/github/repos/:owner/:repo/branches/:branch/pr')
  createBranchPR(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('branch') branch: string,
    @Body() body: { base?: string; title: string; body?: string },
  ) {
    return this.dashboardService.createBranchPR(
      owner,
      repo,
      branch,
      body.base,
      body.title,
      body.body || '',
    );
  }

  /** Ask ReviewBot to implement a feature/fix on a branch via LLM */
  @Post('api/github/repos/:owner/:repo/branches/:branch/implement')
  implementOnBranch(
    @Param('owner') owner: string,
    @Param('repo') repo: string,
    @Param('branch') branch: string,
    @Body() body: { prompt: string; files?: string[] },
  ) {
    return this.dashboardService.implementOnBranch(
      owner,
      repo,
      branch,
      body.prompt,
      body.files,
    );
  }

  // ── Settings ──

  @Get('api/settings')
  getSettings() {
    return this.settingsService.getSettings();
  }

  @Post('api/settings/provider')
  setProvider(@Body() body: { providerId: string }) {
    this.settingsService.setActiveProvider(body.providerId);
    return { success: true, activeProviderId: body.providerId };
  }

  @Post('api/settings/model')
  setModel(@Body() body: { model: string }) {
    this.settingsService.setActiveModel(body.model);
    return { success: true, activeModel: body.model };
  }

  @Post('api/settings/api-key')
  setApiKey(@Body() body: { providerId: string; apiKey: string }) {
    this.settingsService.updateProviderApiKey(body.providerId, body.apiKey);
    return { success: true };
  }

  @Post('api/settings/custom-model')
  addCustomModel(@Body() body: { providerId: string; model: string }) {
    this.settingsService.addCustomModel(body.providerId, body.model);
    return { success: true };
  }

  // ── Static page ──

  @Get()
  serveDashboard(@Res() res: Response) {
    const htmlPath = path.join(__dirname, '..', '..', 'public', 'dashboard.html');
    if (fs.existsSync(htmlPath)) {
      res.sendFile(htmlPath);
    } else {
      res.type('text/html').send('<h1>🤖 ReviewBot</h1><p>Dashboard loading...</p>');
    }
  }
}
