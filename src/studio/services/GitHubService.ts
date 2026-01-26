/* eslint-disable no-console */
import path from 'path';
import { existsSync } from 'fs';
import { unlink } from 'fs/promises';
import chalk from 'chalk';
import { simpleGit } from 'simple-git';

export class GitHubService {
  /**
   * Push changes to GitHub repository
   * Creates the repository if it doesn't exist, configures remote, and pushes
   * Repositories are always created under the user's account
   */
  async pushToGitHub(
    appPath: string,
    options: {
      githubToken: string;
      githubUsername: string;
      repoName: string;
    },
  ): Promise<{ success: boolean; message: string }> {
    const { githubToken, githubUsername, repoName } = options;

    try {
      let progressMessage = 'Checking GitHub repository...';
      console.log(chalk.blue(`[GitHubService] ${progressMessage}`));

      try {
        const response = await fetch(`https://api.github.com/repos/${githubUsername}/${repoName}`, {
          headers: {
            Authorization: `token ${githubToken}`,
            Accept: 'application/vnd.github.v3+json',
          },
        });

        if (response.ok) {
          progressMessage = 'GitHub repository found.';
          console.log(chalk.green(`[GitHubService] ${progressMessage}`));
        } else if (response.status === 404) {
          progressMessage = 'Creating GitHub repository...';
          console.log(chalk.yellow(`[GitHubService] ${progressMessage}`));
          const createResponse = await fetch('https://api.github.com/user/repos', {
            method: 'POST',
            headers: {
              Authorization: `token ${githubToken}`,
              Accept: 'application/vnd.github.v3+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: repoName,
              private: true,
              auto_init: false, // Don't auto-init since we'll push our own content
            }),
          });

          if (!createResponse.ok) {
            const errorData = (await createResponse.json().catch(() => ({}))) as { message?: string };
            throw new Error(
              `Failed to create GitHub repository: ${createResponse.statusText} - ${errorData.message || ''}`,
            );
          }

          progressMessage = 'GitHub repository created.';
          console.log(chalk.green(`[GitHubService] ${progressMessage}`));
        } else {
          const errorData = (await response.json().catch(() => ({}))) as { message?: string };
          throw new Error(`Failed to check repository: ${response.statusText} - ${errorData.message || ''}`);
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Failed to')) {
          throw error;
        }
        throw new Error(`Failed to check/create GitHub repository: ${errorMessage}`);
      }

      progressMessage = 'Initializing git repository...';
      console.log(chalk.blue(`[GitHubService] ${progressMessage}`));
      const git = simpleGit(appPath);
      const isRepo = await git.checkIsRepo();

      if (!isRepo) {
        progressMessage = 'Initializing git repository...';
        console.log(chalk.yellow(`[GitHubService] ${progressMessage}`));
        await git.init();
        await git.checkoutLocalBranch('main');
      }

      try {
        await git.addConfig('user.name', githubUsername, false, 'local');
        await git.addConfig('user.email', githubUsername, false, 'local');
      } catch {
        // Config might already exist
      }

      progressMessage = 'Configuring git remote...';
      console.log(chalk.blue(`[GitHubService] ${progressMessage}`));
      const remotes = await git.getRemotes(true);
      const originRemote = remotes.find(r => r.name === 'origin');
      const expectedRemoteUrl = `https://${githubUsername}:${githubToken}@github.com/${githubUsername}/${repoName}.git`;

      if (originRemote) {
        if (originRemote.refs.fetch !== expectedRemoteUrl) {
          progressMessage = 'Updating remote URL...';
          console.log(chalk.yellow(`[GitHubService] ${progressMessage}`));
          await git.remote(['set-url', 'origin', expectedRemoteUrl]);
        }
      } else {
        progressMessage = 'Adding remote origin...';
        console.log(chalk.yellow(`[GitHubService] ${progressMessage}`));
        await git.addRemote('origin', expectedRemoteUrl);
      }

      progressMessage = 'Checking for changes to push...';
      console.log(chalk.blue(`[GitHubService] ${progressMessage}`));
      const status = await git.status();
      const currentBranch = status.current || 'main';

      // Check if there are any commits to push
      try {
        // Check if we're ahead of remote
        const branchStatus = await git.status();

        // Try to fetch remote refs to see if remote branch exists
        try {
          await git.fetch(['origin', currentBranch]);
        } catch {
          // Remote branch might not exist yet, which is fine
        }

        // Check if we have commits ahead of remote
        if (branchStatus.ahead === 0) {
          // Check if remote branch exists by trying to list remote branches
          try {
            const remotes = await git.getRemotes(true);
            const hasOrigin = remotes.some(r => r.name === 'origin');

            if (hasOrigin) {
              // Try to check if remote branch exists
              try {
                await git.listRemote(['--heads', 'origin', currentBranch]);
                // Remote branch exists and we're not ahead
                return {
                  success: true,
                  message: 'Repository is up to date. Nothing to push.',
                };
              } catch {
                // Remote branch doesn't exist, check if we have local commits
                const localLog = await git.log();
                if (localLog.total === 0) {
                  return {
                    success: true,
                    message: 'No commits to push. Please commit your changes first.',
                  };
                }
                // We have local commits but no remote, proceed with push
              }
            } else {
              // No origin remote, check if we have local commits
              const localLog = await git.log();
              if (localLog.total === 0) {
                return {
                  success: true,
                  message: 'No commits to push. Please commit your changes first.',
                };
              }
            }
          } catch {
            // If we can't check, proceed with push
          }
        }
        // We have commits ahead, proceed with push
      } catch (error: unknown) {
        // If we can't determine status, try to push anyway
        // This handles edge cases where git status might fail
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.warn(
          chalk.yellow(`[GitHubService] Could not determine push status, attempting push anyway: ${errorMessage}`),
        );
      }

      progressMessage = 'Pushing to GitHub...';
      console.log(chalk.blue(`[GitHubService] ${progressMessage}`));
      await git.push(['-u', 'origin', currentBranch]);

      // Clean up any potential git index locks that might interfere with file operations
      // This ensures file endpoints continue to work after push
      const indexLockPath = path.join(appPath, '.git', 'index.lock');
      try {
        if (existsSync(indexLockPath)) {
          console.log(chalk.yellow('[GitHubService] Removing stale git index lock...'));
          await unlink(indexLockPath);
        }
      } catch {
        // Ignore errors when cleaning up lock file
      }

      const successMessage = `Successfully pushed to GitHub: ${githubUsername}/${repoName}`;
      console.log(chalk.green(`[GitHubService] ${successMessage}`));
      return {
        success: true,
        message: successMessage,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(chalk.red(`[GitHubService] Failed to push to GitHub: ${errorMessage}`));
      throw error;
    }
  }
}
