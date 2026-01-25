/* eslint-disable no-console */
import path from 'path';
import { existsSync, readdirSync, statSync } from 'fs';
import { rm } from 'fs/promises';
import { spawn, ChildProcess } from 'child_process';
import chalk from 'chalk';
import { FileService } from './FileService.js';
import { runPreInitTasks } from '../runtime.js';
import { isValidAgentlangProject, ignoredPaths } from '../utils.js';
import { AppInfo, WorkspaceInfo } from '../types.js';
import { fileURLToPath } from 'url';
import { initializeProject } from '../../utils/projectInitializer.js';
import { forkApp as forkAppUtil, type ForkOptions } from '../../utils/forkApp.js';

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
    console.log(`[StudioServer] createApp: Creating app "${name}" at path: ${appPath}`);

    try {
      // Use the shared initialization logic
      console.log(`[StudioServer] createApp: Starting project initialization for "${name}"`);
      const initStartTime = Date.now();

      await initializeProject(appPath, name, {
        silent: false, // Enable logging for better visibility
        skipInstall: false, // Install dependencies so the app is ready to run
        skipGit: false, // Initialize git repo
      });

      const initDuration = Date.now() - initStartTime;
      console.log(`[StudioServer] createApp: Project initialization completed for "${name}" in ${initDuration}ms`);

      const appInfo = {
        name,
        path: appPath,
        isInitialApp: false,
      };

      console.log(`[StudioServer] createApp: Successfully created app "${name}"`);
      return appInfo;
    } catch (error) {
      console.error(`[StudioServer] createApp: Failed to create app "${name}":`, error);
      throw error;
    }
  }

  async forkApp(
    sourcePath: string,
    newAppName: string,
    options?: ForkOptions,
  ): Promise<AppInfo> {
    const destPath = path.join(this.workspaceRoot, newAppName);

    if (existsSync(destPath)) {
      throw new Error(`A project named "${newAppName}" already exists in the workspace.`);
    }

    // Use the shared fork utility
    const result = await forkAppUtil(sourcePath, destPath, options);

    return {
      name: result.name,
      path: result.path,
      isInitialApp: false,
    };
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
