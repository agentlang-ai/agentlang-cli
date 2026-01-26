/* eslint-disable no-console */
import path from 'path';
import { existsSync } from 'fs';
import { spawn, ChildProcess, execSync } from 'child_process';
import chalk from 'chalk';
import { FileService } from './FileService.js';
import { runPreInitTasks } from '../runtime.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class AppRuntimeService {
  private agentProcess: ChildProcess | null = null;
  private currentAppPath: string | null = null;

  constructor(private fileService: FileService) {}

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

    // 4. Check and install dependencies if needed
    const nodeModulesPath = path.join(appPath, 'node_modules');
    const packageJsonPath = path.join(appPath, 'package.json');

    if (existsSync(packageJsonPath)) {
      const needsInstall = !existsSync(nodeModulesPath) || !existsSync(path.join(nodeModulesPath, 'sqlite3'));

      if (needsInstall) {
        console.log(chalk.yellow('📦 Dependencies not found. Installing...'));
        try {
          execSync('npm install', {
            cwd: appPath,
            stdio: 'inherit',
            env: {
              ...process.env,
              GIT_ASKPASS: 'echo',
              GIT_TERMINAL_PROMPT: '0',
            },
          });
          console.log(chalk.green('✓ Dependencies installed'));
        } catch (error) {
          console.error(chalk.red('Failed to install dependencies:'), error);
          throw new Error('Failed to install dependencies. Please run "npm install" manually in the app directory.');
        }
      }
    }

    // 5. Load Project (Runtime)
    try {
      await this.fileService.loadProject();
    } catch (error) {
      console.error(chalk.red('Failed to load project runtime:'), error);
      // Continue anyway to allow editing
    }

    // 6. Start Agent Process
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

  stopApp(resetToRoot = true, workspaceRoot?: string): void {
    if (this.agentProcess) {
      console.log(chalk.yellow('\nStopping active app...'));
      this.agentProcess.kill();
      this.agentProcess = null;
    }

    if (resetToRoot && workspaceRoot) {
      this.currentAppPath = null;
      this.fileService.setTargetDir(workspaceRoot);
      console.log(chalk.green('✓ Returned to Dashboard Mode'));
    } else if (resetToRoot) {
      this.currentAppPath = null;
    }
  }

  getCurrentApp(): string | null {
    return this.currentAppPath;
  }

  setCurrentApp(appPath: string | null): void {
    this.currentAppPath = appPath;
  }
}
