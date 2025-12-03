/* eslint-disable no-console */
import express, { Router, Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { spawn, ChildProcess } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { flushAllAndLoad, load } from 'agentlang/out/runtime/loader.js';
import { runPreInitTasks } from './main.js';
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

  async loadProject(): Promise<void> {
    await flushAllAndLoad(this.targetDir);
  }

  async getFileTree(dirPath: string = this.targetDir, relativePath = ''): Promise<FileTreeNode[]> {
    const dirents = await fs.readdir(dirPath, { withFileTypes: true });
    const files: FileTreeNode[] = [];

    for (const dirent of dirents) {
      if (ignoredPaths.has(dirent.name)) {
        continue;
      }
      const newRelativePath = path.join(relativePath, dirent.name);
      if (dirent.isDirectory()) {
        files.push({
          name: dirent.name,
          path: newRelativePath,
          type: 'directory',
          children: await this.getFileTree(path.join(dirPath, dirent.name), newRelativePath),
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

  async getPackageInfo(): Promise<Record<string, unknown>> {
    try {
      const packageJsonPath = path.join(this.targetDir, 'package.json');
      const content = await fs.readFile(packageJsonPath, 'utf-8');
      return JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
      console.warn('Failed to read package.json:', error);
      return {};
    }
  }
}

class FileController {
  private fileService: FileService;

  constructor(fileService: FileService) {
    this.fileService = fileService;
  }

  getFiles = async (_req: Request, res: Response) => {
    try {
      const fileTree = await this.fileService.getFileTree();
      return res.json(fileTree);
    } catch {
      return res.status(500).json({ error: 'Failed to read file tree' });
    }
  };

  getFile = async (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }
    try {
      const content = await this.fileService.readFile(filePath);
      return res.json({ content });
    } catch {
      return res.status(500).json({ error: `Failed to read file: ${filePath}` });
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
}

function createRoutes(targetDir: string): Router {
  const router = Router();
  const fileService = new FileService(targetDir);
  const fileController = new FileController(fileService);

  // Initialize project load
  fileService.loadProject().catch(console.error);

  router.get('/files', fileController.getFiles);
  router.get('/file', fileController.getFile);
  router.post('/file', fileController.saveFile);
  router.get('/info', fileController.getInfo);

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

export async function startStudio(projectPath = '.', studioPort = 4000): Promise<void> {
  const spinner = ora('Starting Agent Studio...').start();
  const targetDir = path.resolve(process.cwd(), projectPath);

  // Validate that the directory contains an agentlang project
  spinner.text = 'Validating Agentlang project...';
  try {
    // Initialize runtime first
    const preInitSuccess = await runPreInitTasks();
    if (!preInitSuccess) {
      spinner.fail(chalk.red('Failed to initialize Agentlang runtime'));
      process.exit(1);
    }

    // Try to load the project to validate it's a valid agentlang project
    await load(targetDir, undefined, async () => {
      // Callback is called when loading completes successfully
    });
    spinner.succeed(chalk.green('Validated Agentlang project'));
  } catch (error) {
    spinner.fail(chalk.red('Failed to load Agentlang project'));
    console.error(
      chalk.red(
        `The directory "${targetDir}" does not appear to contain a valid Agentlang project.\n` +
          `Error: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    console.error(
      chalk.yellow(
        '\nPlease ensure the directory contains valid Agentlang (.al) files and try again.',
      ),
    );
    process.exit(1);
  }

  // Find @agentlang/lstudio
  spinner.text = 'Finding @agentlang/lstudio...';
  const lstudioPath = findLStudioPath(targetDir);
  if (!lstudioPath) {
    spinner.fail(chalk.red('Failed to find @agentlang/lstudio'));
    console.error(
      chalk.yellow(
        'Please install @agentlang/lstudio in your project:\n  npm install --save-dev @agentlang/lstudio',
      ),
    );
    process.exit(1);
  }
  spinner.succeed(chalk.green('Found @agentlang/lstudio'));

  spinner.text = 'Starting Agentlang server...';

  // Start agentlang server in background
  // We'll run it in a separate process to avoid blocking
  let agentProcess: ChildProcess | null = null;
  try {
    // Determine the path to the agent CLI
    const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');

    // Use spawn to run agent run command
    if (existsSync(cliPath)) {
      // Use direct path to cli.js
      agentProcess = spawn('node', [cliPath, 'run', targetDir], {
        stdio: 'pipe', // Use pipe instead of inherit to avoid mixing output
        shell: false,
        cwd: targetDir,
      });
    } else {
      // Fallback to agent command if available in PATH
      agentProcess = spawn('agent', ['run', targetDir], {
        stdio: 'pipe',
        shell: true,
        cwd: targetDir,
      });
    }

    // Handle process output
    if (agentProcess.stdout) {
      agentProcess.stdout.on('data', (data: Buffer) => {
        process.stdout.write(chalk.dim(`[Agent] ${data.toString()}`));
      });
    }
    if (agentProcess.stderr) {
      agentProcess.stderr.on('data', (data: Buffer) => {
        process.stderr.write(chalk.dim(`[Agent] ${data.toString()}`));
      });
    }

    agentProcess.on('error', (err: Error) => {
      spinner.warn(chalk.yellow('Could not start agentlang server in background'));
      console.warn(chalk.dim(`Error: ${err.message}`));
      agentProcess = null;
    });

    agentProcess.on('exit', (code) => {
      if (code !== null && code !== 0) {
        console.warn(chalk.yellow(`Agentlang server exited with code ${code}`));
      }
    });
  } catch (error: unknown) {
    spinner.warn(chalk.yellow('Could not start agentlang server in background, continuing anyway...'));
    console.warn(chalk.dim(error instanceof Error ? error.message : String(error)));
    agentProcess = null;
  }

  spinner.text = 'Starting Studio server...';

  // Create Express app
  const app = express();

  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  app.use(cors());
  app.use(express.json());

  // Serve static files from @agentlang/lstudio/dist
  app.use(express.static(lstudioPath));

  // Setup Routes
  app.use('/', createRoutes(targetDir));

  // Handle client-side routing
  app.get('*', (req, res, next) => {
    // Skip if handled by API routes
    if (
      req.path.startsWith('/files') ||
      req.path.startsWith('/file') ||
      req.path.startsWith('/test') ||
      req.path.startsWith('/info') ||
      req.path.startsWith('/env-config.js')
    ) {
      return next();
    }
    res.sendFile(path.join(lstudioPath, 'index.html'));
  });

  // Start server
  await new Promise<void>((resolve) => {
    app.listen(studioPort, () => {
      spinner.succeed(chalk.green(`Studio server is running on http://localhost:${studioPort}`));
      console.log(chalk.blue(`Serving files from: ${targetDir}`));
      const studioUrl = `http://localhost:${studioPort}`;
      console.log(chalk.blue(`Studio UI is available at: ${studioUrl}`));
      if (agentProcess) {
        console.log(chalk.dim('Agentlang server is running in the background'));
      }

      // Open browser automatically (fire and forget)
      open(studioUrl)
        .then(() => {
          console.log(chalk.green(`✓ Opened browser at ${studioUrl}`));
        })
        .catch((error: unknown) => {
          console.warn(
            chalk.yellow(
              `⚠ Could not open browser automatically: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
          console.log(chalk.dim(`   Please open ${studioUrl} manually in your browser`));
        });

      // Handle cleanup on exit
      process.on('SIGINT', () => {
        console.log(chalk.yellow('\nShutting down...'));
        if (agentProcess) {
          agentProcess.kill();
        }
        process.exit(0);
      });

      process.on('SIGTERM', () => {
        console.log(chalk.yellow('\nShutting down...'));
        if (agentProcess) {
          agentProcess.kill();
        }
        process.exit(0);
      });

      resolve();
    });
  });
}

