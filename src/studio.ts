/* eslint-disable no-console */
import express, { Router, Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readdirSync, statSync } from 'fs';
import { spawn, ChildProcess, execSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';

let agPath = 'agentlang';
const nodeModulesPath = path.resolve(process.cwd(), 'node_modules/agentlang');

if (existsSync(nodeModulesPath)) {
  agPath = nodeModulesPath;
}

const modLoader: typeof import('agentlang/out/runtime/loader.js') = await import(`${agPath}/out/runtime/loader.js`);
const { flushAllAndLoad } = modLoader;
const modCli: typeof import('agentlang/out/cli/main.js') = await import(`${agPath}/out/cli/main.js`);
const { runPreInitTasks } = modCli;

import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}

const ignoredPaths = new Set(['node_modules', '.git', 'dist', 'out']);

class FileService {
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

  async writeFile(filePath: string, content: string): Promise<void> {
    const fullPath = path.join(this.targetDir, filePath);
    await fs.writeFile(fullPath, content, 'utf-8');
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
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.targetDir,
        encoding: 'utf-8',
      }).trim();

      return branch || 'main';
    } catch (error) {
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
            execSync(`git config --local ${config}`, {
              cwd: this.targetDir,
              stdio: 'pipe',
            });
          } catch {
            // If local config fails (e.g., not a git repo), try global as fallback
            try {
              execSync(`git config --global ${config}`, {
                stdio: 'pipe',
              });
            } catch (globalConfigError) {
              // Ignore config errors, continue with npm install
              console.warn('Failed to set git config:', globalConfigError);
            }
          }
        }
      }

      execSync('npm install', {
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

class FileController {
  private fileService: FileService;

  constructor(fileService: FileService) {
    this.fileService = fileService;
  }

  getFiles = async (req: Request, res: Response) => {
    try {
      const pathParam = req.query.path as string | undefined;
      if (pathParam) {
        // Fetch file tree for a specific path (e.g., node_modules/depName)
        // Skip ignored paths when fetching from node_modules
        // Use FileService's current targetDir
        const fullPath = path.join(this.fileService.getTargetDir(), pathParam);
        const skipIgnored = pathParam.startsWith('node_modules');
        const fileTree = await this.fileService.getFileTree(fullPath, '', skipIgnored);
        return res.json(fileTree);
      } else {
        // Fetch root file tree
        const fileTree = await this.fileService.getFileTree();
        return res.json(fileTree);
      }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof (error as { code: unknown }).code === 'string' &&
        (error as { code: string }).code === 'ENOENT'
      ) {
        return res.status(404).json({ error: 'Path not found' });
      }
      return res.status(500).json({ error: 'Failed to read file tree' });
    }
  };

  getFile = async (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    const includeMetadata = req.query.metadata === 'true';
    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }
    try {
      const content = await this.fileService.readFile(filePath);
      if (includeMetadata) {
        const stats = await this.fileService.stat(filePath);
        return res.json({ content, type: stats.type, size: stats.size, mtime: stats.mtime });
      }
      return res.json({ content });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof (error as { code: unknown }).code === 'string' &&
        (error as { code: string }).code === 'ENOENT'
      ) {
        return res.status(404).json({ error: 'File not found' });
      }
      return res.status(500).json({ error: `Failed to read file: ${filePath}` });
    }
  };

  getStat = async (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }
    try {
      const stats = await this.fileService.stat(filePath);
      return res.json(stats);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof (error as { code: unknown }).code === 'string' &&
        (error as { code: string }).code === 'ENOENT'
      ) {
        return res.status(404).json({ error: 'Path not found' });
      }
      return res.status(500).json({ error: `Failed to get stat for: ${filePath}` });
    }
  };

  saveFile = async (req: Request, res: Response) => {
    const { path: filePath, content } = req.body as { path?: string; content?: string };
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: 'File path and content are required' });
    }
    try {
      await this.fileService.writeFile(filePath, content);
      return res.json({ message: `Successfully wrote to ${filePath}` });
    } catch {
      return res.status(500).json({ error: `Failed to write to file: ${filePath}` });
    }
  };

  getInfo = async (_req: Request, res: Response) => {
    const info = await this.fileService.getPackageInfo();
    return res.json(info);
  };

  getBranch = async (_req: Request, res: Response) => {
    try {
      const branch = await this.fileService.getCurrentBranch();
      return res.json({ branch });
    } catch {
      return res.status(500).json({ error: 'Failed to get current branch' });
    }
  };

  installDependencies = (req: Request, res: Response) => {
    try {
      const { githubUsername, githubToken } = (req.body as { githubUsername?: string; githubToken?: string }) || {};
      this.fileService.installDependencies(githubUsername, githubToken);
      return res.json({ message: 'Dependencies installed successfully' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: errorMessage });
    }
  };
}

interface AppInfo {
  name: string;
  path: string;
}

class StudioServer {
  private rootDir: string;
  private fileService: FileService;
  private currentAppPath: string | null = null;
  private agentProcess: ChildProcess | null = null;

  constructor(rootDir: string, fileService: FileService) {
    this.rootDir = rootDir;
    this.fileService = fileService;
  }

  discoverApps(): AppInfo[] {
    const apps: AppInfo[] = [];
    try {
      const files = readdirSync(this.rootDir);
      for (const file of files) {
        const fullPath = path.join(this.rootDir, file);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory() && !ignoredPaths.has(file)) {
            // Check for package.json or .al files
            if (existsSync(path.join(fullPath, 'package.json'))) {
              apps.push({ name: file, path: fullPath });
              continue;
            }

            // Check for .al files
            const subFiles = readdirSync(fullPath);
            if (subFiles.some(f => f.endsWith('.al'))) {
              apps.push({ name: file, path: fullPath });
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

  async launchApp(appPath: string): Promise<void> {
    console.log(chalk.blue(`\nLaunching app: ${appPath}`));

    // 1. Stop existing app if any
    this.stopApp(false); // false = don't reset to root yet, we are switching

    // 2. Set new target
    this.currentAppPath = appPath;
    this.fileService.setTargetDir(appPath);

    // 3. Load Project (Runtime)
    try {
      await this.fileService.loadProject();
    } catch (error) {
      console.error(chalk.red('Failed to load project runtime:'), error);
      // Continue anyway to allow editing
    }

    // 4. Start Agent Process
    try {
      const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');
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
      this.fileService.setTargetDir(this.rootDir);
      console.log(chalk.green('✓ Returned to Dashboard Mode'));
    }
  }

  getCurrentApp() {
    return this.currentAppPath;
  }
}

function createRoutes(targetDir: string, studioServer: StudioServer, fileService: FileService): Router {
  const router = Router();
  const fileController = new FileController(fileService);

  // Initialize project load if not in dashboard mode initially
  fileService.loadProject().catch(console.error);

  // File Routes
  router.get('/files', fileController.getFiles);
  router.get('/file', fileController.getFile);
  router.get('/stat', fileController.getStat);
  router.post('/file', fileController.saveFile);
  router.get('/info', fileController.getInfo);
  router.get('/branch', fileController.getBranch);
  router.post('/install', fileController.installDependencies);

  // App Management Routes
  router.get('/apps', (_req, res) => {
    const apps = studioServer.discoverApps();
    res.json(apps);
  });

  router.post('/app/launch', async (req, res) => {
    const { path: appPath } = req.body as { path?: string };
    if (!appPath) {
      res.status(400).json({ error: 'App path required' });
      return;
    }

    try {
      await studioServer.launchApp(appPath);
      res.json({ success: true, currentApp: appPath });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/app/stop', (_req, res) => {
    try {
      studioServer.stopApp(true);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.get('/test', (_req, res) => {
    return res.json({ message: 'Hello from agent studio!' });
  });

  return router;
}

function findLStudioPath(projectDir: string): string | null {
  // First, try to find @agentlang/lstudio in the project's node_modules
  // Check for dist subfolder first (local development)
  const projectLStudioDistPath = path.join(projectDir, 'node_modules', '@agentlang', 'lstudio', 'dist');
  if (existsSync(projectLStudioDistPath) && existsSync(path.join(projectLStudioDistPath, 'index.html'))) {
    return projectLStudioDistPath;
  }

  // Check root of package (npm installed version)
  const projectLStudioRootPath = path.join(projectDir, 'node_modules', '@agentlang', 'lstudio');
  if (existsSync(path.join(projectLStudioRootPath, 'index.html'))) {
    return projectLStudioRootPath;
  }

  // If not found, try agentlang-cli's node_modules
  // Check for dist subfolder first
  const cliLStudioDistPath = path.join(__dirname, '..', 'node_modules', '@agentlang', 'lstudio', 'dist');
  if (existsSync(cliLStudioDistPath) && existsSync(path.join(cliLStudioDistPath, 'index.html'))) {
    return cliLStudioDistPath;
  }

  // Check root of package in cli's node_modules
  const cliLStudioRootPath = path.join(__dirname, '..', 'node_modules', '@agentlang', 'lstudio');
  if (existsSync(path.join(cliLStudioRootPath, 'index.html'))) {
    return cliLStudioRootPath;
  }

  return null;
}

export async function startStudio(projectPath = '.', studioPort = 4000, serverOnly = false): Promise<void> {
  const spinner = ora(serverOnly ? 'Starting Studio backend server...' : 'Starting Agent Studio...').start();
  const rootDir = path.resolve(process.cwd(), projectPath);

  // Initialize Services
  const fileService = new FileService(rootDir);
  const studioServer = new StudioServer(rootDir, fileService);

  // Check Mode
  const isDirectApp =
    existsSync(path.join(rootDir, 'package.json')) ||
    (await fileService.getFileTree(rootDir)).some(f => f.name.endsWith('.al'));

  if (isDirectApp) {
    spinner.text = 'Validating Agentlang project...';
    try {
      const preInitSuccess = await runPreInitTasks();
      if (!preInitSuccess) {
        spinner.fail(chalk.red('Failed to initialize Agentlang runtime'));
        process.exit(1);
      }

      await studioServer.launchApp(rootDir);
      spinner.succeed(chalk.green('Validated Agentlang project'));
    } catch {
      spinner.fail(chalk.red('Failed to load Agentlang project'));
      console.error(chalk.yellow('Ensure the directory contains valid Agentlang files.'));
      process.exit(1);
    }
  } else {
    console.log(chalk.blue('ℹ  Starting in Dashboard Mode (No direct app found)'));
    console.log(chalk.dim('   Select an app from the UI to launch it.'));
    spinner.succeed(chalk.green('Studio Dashboard Ready'));
  }

  // Find @agentlang/lstudio (skip in server-only mode)
  let lstudioPath: string | null = null;
  if (!serverOnly) {
    lstudioPath = findLStudioPath(rootDir);
    if (!lstudioPath) {
      // Only error if we really can't find it, but in dev mode it might differ.
      // Warn instead of exit in case we are just using API
      console.warn(chalk.yellow('Warning: Could not find @agentlang/lstudio UI files.'));
    }
  }

  // Create Express app
  const app = express();
  app.use(cors());
  app.use(express.json());

  // Setup Routes
  app.use('/', createRoutes(rootDir, studioServer, fileService));

  // Serve static files from @agentlang/lstudio/dist (skip in server-only mode)
  if (!serverOnly && lstudioPath) {
    app.use(express.static(lstudioPath));

    // Handle client-side routing
    app.get('*', (req, res, next) => {
      // Skip if handled by API routes
      if (
        req.path.startsWith('/files') ||
        req.path.startsWith('/file') ||
        req.path.startsWith('/test') ||
        req.path.startsWith('/info') ||
        req.path.startsWith('/branch') ||
        req.path.startsWith('/install') ||
        req.path.startsWith('/env-config.js') ||
        req.path.startsWith('/apps') || // new
        req.path.startsWith('/app/') // new
      ) {
        return next();
      }
      if (lstudioPath) {
        res.sendFile(path.join(lstudioPath, 'index.html'));
      } else {
        res.status(404).json({ error: 'Studio UI not found' });
      }
    });
  }

  // Start server
  await new Promise<void>(resolve => {
    app.listen(studioPort, () => {
      spinner.succeed(chalk.green(`Studio server is running on http://localhost:${studioPort}`));
      const studioUrl = `http://localhost:${studioPort}`;

      if (serverOnly) {
        console.log(chalk.blue(`Backend API available at: ${studioUrl}`));
        console.log(chalk.dim('Endpoints: /files, /file, /info, /branch, /test, /apps, /app/launch'));
      } else {
        console.log(chalk.blue(`Studio UI is available at: ${studioUrl}`));
      }

      // Open browser automatically (skip in server-only mode)
      if (!serverOnly) {
        void open(studioUrl).catch(() => {
          // Ignore errors when opening browser
        });
      }

      // Handle cleanup on exit
      const cleanup = () => {
        console.log(chalk.yellow('\nShutting down...'));
        studioServer.stopApp(false);
        process.exit(0);
      };

      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);

      resolve();
    });
  });
}
