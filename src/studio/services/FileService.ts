import path from 'path';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import { execSync as execSyncChild } from 'child_process';
import { flushAllAndLoad } from '../runtime.js';
import { ignoredPaths, FileTreeNode } from '../utils.js';
import { simpleGit } from 'simple-git';

export class FileService {
  private targetDir: string;

  constructor(targetDir: string) {
    this.targetDir = targetDir;
  }

  setTargetDir(targetDir: string) {
    this.targetDir = targetDir;
  }

  getTargetDir() {
    return this.targetDir;
  }

  async loadProject(): Promise<void> {
    // Only load if it looks like a valid project to avoid errors in dashboard mode
    if (existsSync(path.join(this.targetDir, 'package.json'))) {
      await flushAllAndLoad(this.targetDir);
    }
  }

  async getFileTree(dirPath: string = this.targetDir, relativePath = '', skipIgnored = false): Promise<FileTreeNode[]> {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });
    const files: FileTreeNode[] = [];

    for (const dirent of dirents) {
      // Skip ignored paths unless we're explicitly fetching from node_modules
      if (!skipIgnored && ignoredPaths.has(dirent.name)) {
        continue;
      }
      const newRelativePath = path.join(relativePath, dirent.name);
      if (dirent.isDirectory()) {
        files.push({
          name: dirent.name,
          path: newRelativePath,
          type: 'directory',
          children: await this.getFileTree(path.join(dirPath, dirent.name), newRelativePath, skipIgnored),
        });
      } else {
        files.push({
          name: dirent.name,
          path: newRelativePath,
          type: 'file',
        });
      }
    }
    return files;
  }

  async readFile(filePath: string): Promise<string> {
    const fullPath = path.join(this.targetDir, filePath);
    return fs.readFile(fullPath, 'utf-8');
  }

  async writeFile(filePath: string, content: string, commitMessage?: string): Promise<void> {
    const fullPath = path.join(this.targetDir, filePath);
    await fs.writeFile(fullPath, content, 'utf-8');

    // Auto-commit the change if a commit message is provided
    if (commitMessage) {
      await this.commitFile(filePath, commitMessage);
    }
  }

  async commitFile(filePath: string, message: string): Promise<void> {
    try {
      // Check if .git directory exists
      const gitDir = path.join(this.targetDir, '.git');
      if (!existsSync(gitDir)) {
        // Not a git repo, skip commit
        return;
      }

      const git = simpleGit(this.targetDir);
      await git.add(filePath);

      // Check if there are staged changes
      const status = await git.status();
      if (status.staged.length > 0) {
        const timestamp = new Date().toLocaleString();
        await git.commit(`${message} at ${timestamp}`);
        // eslint-disable-next-line no-console
        console.log(`✅ Committed: ${message}`);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('Failed to commit changes:', error);
      // Don't throw - file was saved, commit is optional
    }
  }

  async stat(filePath: string): Promise<{ type: 'file' | 'directory'; size: number; mtime: Date }> {
    const fullPath = path.join(this.targetDir, filePath);
    const stats = await fs.stat(fullPath);
    return {
      type: stats.isDirectory() ? 'directory' : 'file',
      size: stats.size,
      mtime: stats.mtime,
    };
  }

  async getPackageInfo(): Promise<Record<string, unknown>> {
    try {
      const packageJsonPath = path.join(this.targetDir, 'package.json');
      if (!existsSync(packageJsonPath)) {
        return {};
      }
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      // Silently return empty object if package.json doesn't exist or can't be read
      // This is expected in Dashboard Mode where root directory may not have package.json
      return {};
    }
  }

  async getCurrentBranch(): Promise<string> {
    try {
      // Check if .git directory exists
      const gitDir = path.join(this.targetDir, '.git');
      try {
        const stat = await fs.stat(gitDir);
        if (!stat.isDirectory()) {
          return 'main'; // Default branch if not a git repo
        }
      } catch {
        return 'main'; // Default branch if .git doesn't exist
      }

      // Get current branch using git command
      const branch = execSyncChild('git rev-parse --abbrev-ref HEAD', {
        cwd: this.targetDir,
        encoding: 'utf-8',
      }).trim();

      return branch || 'main';
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('Failed to get current branch:', error);
      return 'main'; // Default to main if git command fails
    }
  }

  installDependencies(githubUsername?: string, githubToken?: string): void {
    try {
      // Configure git to use credentials if provided
      // Use local config (scoped to this directory) instead of global to avoid affecting other repos
      if (githubUsername && githubToken) {
        const gitConfig = [
          `url.https://${githubUsername}:${githubToken}@github.com/.insteadOf https://github.com/`,
          `url.https://${githubUsername}:${githubToken}@github.com/.insteadOf git+https://github.com/`,
        ];

        for (const config of gitConfig) {
          try {
            execSyncChild(`git config --local ${config}`, {
              cwd: this.targetDir,
              stdio: 'pipe',
            });
          } catch {
            // If local config fails (e.g., not a git repo), try global as fallback
            try {
              execSyncChild(`git config --global ${config}`, {
                stdio: 'pipe',
              });
            } catch (globalConfigError) {
              // Ignore config errors, continue with pnpm install
              // eslint-disable-next-line no-console
              console.warn('Failed to set git config:', globalConfigError);
            }
          }
        }
      }

      execSyncChild('pnpm install', {
        cwd: this.targetDir,
        stdio: 'pipe',
        env: {
          ...process.env,
          // Set GIT_ASKPASS to avoid interactive prompts
          GIT_ASKPASS: 'echo',
          GIT_TERMINAL_PROMPT: '0',
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to install dependencies: ${errorMessage}`);
    }
  }
}
