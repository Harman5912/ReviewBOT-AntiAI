import { Controller, Get, Post, Param, Query, Body, Res } from '@nestjs/common';
import { Response } from 'express';
import { DashboardService } from './dashboard.service';
import { FeedbackService } from './feedback.service';
import { RepoConfigService } from './repo-config.service';
import * as fs from 'fs';
import * as path from 'path';

@Controller('dashboard')
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly feedbackService: FeedbackService,
    private readonly repoConfigService: RepoConfigService,
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

  // ── Feedback ──

  @Post('api/feedback')
  recordFeedback(@Body() body: { findingId: string; reviewId: string; repoFullName: string; file: string; line: number; title: string; severity: string; isFalsePositive: boolean }) {
    this.feedbackService.recordFeedback({ ...body, timestamp: new Date().toISOString() });
    return { success: true };
  }

  @Get('api/feedback/:repo')
  getFeedback(@Param('repo') repo: string) {
    return this.feedbackService.getFeedbackForRepo(decodeURIComponent(repo));
  }

  @Get('api/feedback/stats/false-positive-rate')
  getFalsePositiveRate() {
    return { rate: this.feedbackService.getFalsePositiveRate() };
  }

  // ── Repo Config ──

  @Get('api/config/:repo')
  getRepoConfig(@Param('repo') repo: string) {
    return this.repoConfigService.getConfig(decodeURIComponent(repo));
  }

  @Post('api/config/:repo')
  updateRepoConfig(@Param('repo') repo: string, @Body() body: any) {
    this.repoConfigService.updateConfig(decodeURIComponent(repo), body);
    return { success: true };
  }

  @Get('api/configs')
  getAllConfigs() {
    return this.repoConfigService.getAllConfigs();
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
