/* eslint-disable no-console */
import path from 'path';
import { existsSync } from 'fs';
import { cp, rm, mkdir } from 'fs/promises';
import { execSync } from 'child_process';
import { simpleGit } from 'simple-git';
import os from 'os';

export interface ForkOptions {
  credentials?: { username: string; token: string };
  branch?: string;
}

export interface ForkResult {
  name: string;
  path: string;
}

/**
 * Forks an app from a source path (local directory or git URL) to a destination.
 * This is the core fork functionality shared between CLI and Studio Server.
 *
 * @param sourcePath - Local directory path or git URL (http/https/git@)
 * @param destPath - Destination directory where the forked app will be created
 * @param options - Optional credentials and branch for git repos
 * @returns Promise resolving to fork result with name and path
 */
export async function forkApp(
  sourcePath: string,
  destPath: string,
  options?: ForkOptions,
): Promise<ForkResult> {
  if (existsSync(destPath)) {
    throw new Error(`Destination path "${destPath}" already exists.`);
  }

  // Check if source is a git URL
  if (sourcePath.startsWith('http') || sourcePath.startsWith('git@')) {
    return forkGitRepo(sourcePath, destPath, options);
  }

  if (!existsSync(sourcePath)) {
    throw new Error(`Source path "${sourcePath}" does not exist.`);
  }

  // 1. Copy the source directory to the destination
  // recursive: true copies all files
  // filter: skip node_modules, .git, and build folders
  await cp(sourcePath, destPath, {
    recursive: true,
    filter: src => {
      const basename = path.basename(src);
      return !['node_modules', '.git', 'dist', 'out', '.DS_Store'].includes(basename);
    },
  });

  // 2. Post-fork initialization: install deps and initialize git
  await postForkInit(destPath, sourcePath);

  return {
    name: path.basename(destPath),
    path: destPath,
  };
}

/**
 * Forks a git repository by cloning it to a temp directory, then copying to destination.
 */
async function forkGitRepo(
  repoUrl: string,
  destPath: string,
  options?: ForkOptions,
): Promise<ForkResult> {
  // 1. Clone to a temporary directory
  const tempDir = path.join(os.tmpdir(), `agentlang-fork-${Date.now()}`);
  await mkdir(tempDir, { recursive: true });

  try {
    const git = simpleGit();

    // Build authenticated URL if credentials provided
    let cloneUrl = repoUrl;
    if (options?.credentials?.username && options?.credentials?.token) {
      // Convert https://github.com/org/repo.git to https://user:token@github.com/org/repo.git
      const urlMatch = repoUrl.match(/^https:\/\/github\.com\/(.+)$/);
      if (urlMatch) {
        cloneUrl = `https://${options.credentials.username}:${options.credentials.token}@github.com/${urlMatch[1]}`;
      }
    }

    // Clone with specific branch if provided, otherwise clone default branch
    const cloneOptions: string[] = [];
    if (options?.branch) {
      cloneOptions.push('--branch', options.branch);
    }

    await git.clone(cloneUrl, tempDir, cloneOptions);

    // 2. Reuse the fork logic to copy from temp -> destination
    // This automatically strips .git, giving us a fresh copy
    // Don't pass options here since we're copying from local temp dir
    return await forkApp(tempDir, destPath);
  } finally {
    // 3. Cleanup temp dir
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Performs post-fork initialization: installs dependencies and initializes git.
 */
async function postForkInit(destPath: string, sourcePath: string): Promise<void> {
  // Install dependencies
  try {
    execSync('npm install', { cwd: destPath, stdio: 'ignore' });
  } catch (e) {
    console.warn('Failed to install dependencies for forked app:', e);
  }

  // Initialize Git
  try {
    const git = simpleGit(destPath);
    await git.init();
    await git.checkoutLocalBranch('main');
    await git.add('.');
    await git.commit(`chore: forked from ${path.basename(sourcePath)}`);
  } catch (e) {
    console.warn('Failed to initialize git for forked app:', e);
  }
}
