/* eslint-disable no-console */
import path from 'path';
import { existsSync, readdirSync, statSync } from 'fs';
import { cp, rm, mkdir } from 'fs/promises';
import { spawn, ChildProcess } from 'child_process';
import chalk from 'chalk';
import { FileService } from './FileService.js';
import { runPreInitTasks } from '../runtime.js';
import { isValidAgentlangProject, ignoredPaths } from '../utils.js';
import { AppInfo, WorkspaceInfo } from '../types.js';
import { fileURLToPath } from 'url';
import { initializeProject } from '../../utils/projectInitializer.js';
import { simpleGit } from 'simple-git';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class StudioServer {
  private workspaceRoot: string; // Parent directory containing all projects
  private initialAppPath: string | null; // The project we launched from (if any)
  private fileService: FileService;
  private currentAppPath: string | null = null;
  private agentProcess: ChildProcess | null = null;

  constructor(workspaceRoot: string, initialAppPath: string | null, fileService: FileService) {
    this.workspaceRoot = workspaceRoot;
    this.initialAppPath = initialAppPath;
    this.fileService = fileService;
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  getInitialAppPath(): string | null {
    return this.initialAppPath;
  }

  discoverApps(): AppInfo[] {
    const apps: AppInfo[] = [];
    try {
      const files = readdirSync(this.workspaceRoot);
      for (const file of files) {
        const fullPath = path.join(this.workspaceRoot, file);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory() && !ignoredPaths.has(file)) {
            // Use the helper function to check if it's a valid project
            if (isValidAgentlangProject(fullPath)) {
              apps.push({
                name: file,
                path: fullPath,
                isInitialApp: fullPath === this.initialAppPath,
              });
            }
          }
        } catch {
          // Ignore access errors
        }
      }
    } catch (error) {
      console.warn('Failed to discover apps:', error);
    }
    return apps;
  }

  getWorkspaceInfo(): WorkspaceInfo {
    return {
      workspaceRoot: this.workspaceRoot,
      initialAppPath: this.initialAppPath,
      currentApp: this.currentAppPath,
      apps: this.discoverApps(),
    };
  }

  async createApp(name: string): Promise<AppInfo> {
    const appPath = path.join(this.workspaceRoot, name);

    // Use the shared initialization logic
    await initializeProject(appPath, name, {
      silent: true, // Don't log to server console
      skipInstall: false, // Install dependencies so the app is ready to run
      skipGit: false, // Initialize git repo
    });

    return {
      name,
      path: appPath,
      isInitialApp: false,
    };
  }

  async forkApp(
    sourcePath: string,
    newAppName: string,
    options?: {
      credentials?: { username: string; token: string };
      branch?: string;
    },
  ): Promise<AppInfo> {
    const destPath = path.join(this.workspaceRoot, newAppName);

    if (existsSync(destPath)) {
      throw new Error(`A project named "${newAppName}" already exists in the workspace.`);
    }

    // Check if source is a git URL
    if (sourcePath.startsWith('http') || sourcePath.startsWith('git@')) {
      return this.forkGitRepo(sourcePath, newAppName, options);
    }

    if (!existsSync(sourcePath)) {
      throw new Error(`Source path "${sourcePath}" does not exist.`);
    }

    // 1. Copy the source directory to the workspace
    // recursive: true copies all files
    // filter: skip node_modules, .git, and build folders
    await cp(sourcePath, destPath, {
      recursive: true,
      filter: src => {
        const basename = path.basename(src);
        return !['node_modules', '.git', 'dist', 'out', '.DS_Store'].includes(basename);
      },
    });

    // 2. Initialize the project (install deps, git init)
    // We use our helper but skip creation steps since files already exist
    // However, initializeProject might fail if it sees package.json.
    // We should modify initializeProject or just run the post-copy steps manually here.
    // initializeProject throws "Directory already initialized" if package.json exists.

    // So let's handle the post-fork initialization manually to avoid the check

    // Install dependencies
    try {
      const { execSync } = await import('child_process');
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

    return {
      name: newAppName,
      path: destPath,
      isInitialApp: false,
    };
  }

  async forkGitRepo(
    repoUrl: string,
    newAppName: string,
    options?: {
      credentials?: { username: string; token: string };
      branch?: string;
    },
  ): Promise<AppInfo> {
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

      // 2. Reuse the fork logic to copy from temp -> workspace
      // This automatically strips .git, giving us a fresh copy
      // Don't pass options here since we're copying from local temp dir
      return await this.forkApp(tempDir, newAppName);
    } finally {
      // 3. Cleanup temp dir
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async deleteApp(appPath: string): Promise<void> {
    // Verify the path exists
    if (!existsSync(appPath)) {
      throw new Error(`App path "${appPath}" does not exist.`);
    }

    // Safety check: ensure the path is within the workspace root
    const normalizedAppPath = path.resolve(appPath);
    const normalizedWorkspaceRoot = path.resolve(this.workspaceRoot);
    if (!normalizedAppPath.startsWith(normalizedWorkspaceRoot)) {
      throw new Error('Cannot delete app outside of workspace root.');
    }

    // If this is the currently running app, stop it first
    if (this.currentAppPath === appPath) {
      this.stopApp(true);
    }

    // Delete the app directory
    console.log(chalk.yellow(`Deleting app: ${appPath}`));
    await rm(appPath, { recursive: true, force: true });
    console.log(chalk.green(`Successfully deleted app: ${appPath}`));
  }

  async launchApp(appPath: string): Promise<void> {
    console.log(chalk.blue(`\nLaunching app: ${appPath}`));

    // 1. Stop existing app if any
    this.stopApp(false); // false = don't reset to root yet, we are switching

    // 2. Set new target
    this.currentAppPath = appPath;
    this.fileService.setTargetDir(appPath);

    // 3. Initialize Runtime (required before loading project)
    try {
      const preInitSuccess = await runPreInitTasks();
      if (!preInitSuccess) {
        console.warn(chalk.yellow('Warning: Failed to initialize Agentlang runtime'));
      }
    } catch (error) {
      console.warn(chalk.yellow('Warning: Runtime initialization error:'), error);
    }

    // 4. Load Project (Runtime)
    try {
      await this.fileService.loadProject();
    } catch (error) {
      console.error(chalk.red('Failed to load project runtime:'), error);
      // Continue anyway to allow editing
    }

    // 5. Start Agent Process
    try {
      // Need to find the CLI path. We are in src/studio/services
      // CLI is likely at ../../../bin/cli.js relative to this file?
      // No, in studio.ts it was path.join(__dirname, '..', 'bin', 'cli.js');
      // Here __dirname is .../agentlang-cli/src/studio/services (if compiled/ts-node)
      // So we need to go up to src/studio, then src, then root...
      // If we assume standard compiled structure:
      // dist/studio/services/StudioServer.js
      // dist/studio/services/../../bin/cli.js -> dist/bin/cli.js ? No.
      // bin/cli.js is usually at root/bin/cli.js.

      // Let's assume we can resolve it relative to the package root.
      // But let's try to match original relative path.
      // Original: path.join(__dirname, '..', 'bin', 'cli.js') where __dirname was src/studio.ts (so src)
      // So it pointed to src/../bin/cli.js = root/bin/cli.js

      // From here: src/studio/services
      // We need: ../../../bin/cli.js

      const cliPath = path.join(__dirname, '..', '..', '..', 'bin', 'cli.js');
      const spawnArgs = ['run', appPath];
      const spawnOptions = {
        stdio: 'pipe' as const,
        shell: false,
        cwd: appPath,
      };

      if (existsSync(cliPath)) {
        this.agentProcess = spawn('node', [cliPath, ...spawnArgs], spawnOptions);
      } else {
        this.agentProcess = spawn('agent', spawnArgs, { ...spawnOptions, shell: true });
      }

      if (this.agentProcess) {
        this.agentProcess.stdout?.on('data', (data: Buffer) => {
          process.stdout.write(chalk.dim(`[Agent ${path.basename(appPath)}] ${data.toString()}`));
        });
        this.agentProcess.stderr?.on('data', (data: Buffer) => {
          process.stderr.write(chalk.dim(`[Agent ${path.basename(appPath)}] ${data.toString()}`));
        });

        console.log(chalk.green(`✓ Agent process started (PID: ${this.agentProcess.pid})`));
      }
    } catch (error) {
      console.error(chalk.red('Failed to spawn agent process:'), error);
    }
  }

  stopApp(resetToRoot = true): void {
    if (this.agentProcess) {
      console.log(chalk.yellow('\nStopping active app...'));
      this.agentProcess.kill();
      this.agentProcess = null;
    }

    if (resetToRoot) {
      this.currentAppPath = null;
      this.fileService.setTargetDir(this.workspaceRoot);
      console.log(chalk.green('✓ Returned to Dashboard Mode'));
    }
  }

  getCurrentApp() {
    return this.currentAppPath;
  }
}
