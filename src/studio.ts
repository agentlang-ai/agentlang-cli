/* eslint-disable no-console */
import express from 'express';
import cors from 'cors';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { getWorkspaceRoot, findLStudioPath } from './studio/utils.js';
import { FileService } from './studio/services/FileService.js';
import { StudioServer } from './studio/services/StudioServer.js';
import { createRoutes } from './studio/routes.js';

export async function startStudio(projectPath = '.', studioPort = 4000, serverOnly = false): Promise<void> {
  const spinner = ora(serverOnly ? 'Starting Studio backend server...' : 'Starting Agent Studio...').start();
  const inputDir = path.resolve(process.cwd(), projectPath);

  // Smart Parent Detection: Determine workspace root and initial app
  const { workspaceRoot, initialAppPath } = getWorkspaceRoot(inputDir);

  // Initialize Services with workspace root
  const fileService = new FileService(workspaceRoot);
  const studioServer = new StudioServer(workspaceRoot, initialAppPath, fileService);

  // Always use Dashboard Mode
  if (initialAppPath) {
    // Launched from inside a project - show workspace with initial app highlighted
    console.log(chalk.blue(`ℹ  Detected project: ${path.basename(initialAppPath)}`));
    console.log(chalk.blue(`ℹ  Workspace root: ${workspaceRoot}`));
    console.log(chalk.dim('   Auto-launching app...'));

    // Auto-launch the detected app
    // This sets the current app in StudioServer, which the frontend can detect via /workspace or /apps
    await studioServer.launchApp(initialAppPath);
  } else {
    // Launched from a workspace directory
    console.log(chalk.blue(`ℹ  Workspace root: ${workspaceRoot}`));
    console.log(chalk.dim('   Starting in Dashboard Mode. Select an app from the UI to launch it.'));
  }
  spinner.succeed(chalk.green('Studio Dashboard Ready'));

  // Find @agentlang/lstudio (skip in server-only mode)
  // Try to find it in the input directory first (for projects with local lstudio)
  // then fall back to workspace root
  let lstudioPath: string | null = null;
  if (!serverOnly) {
    lstudioPath = findLStudioPath(inputDir);
    if (!lstudioPath && inputDir !== workspaceRoot) {
      lstudioPath = findLStudioPath(workspaceRoot);
    }
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
  app.use('/', createRoutes(studioServer, fileService));

  // Serve static files from @agentlang/lstudio/dist (skip in server-only mode)
  if (!serverOnly && lstudioPath) {
    app.use(express.static(lstudioPath));

    // Handle client-side routing
    app.get('', (req, res, next) => {
      // Skip if handled by API routes
      if (
        req.path.startsWith('/files') ||
        req.path.startsWith('/file') ||
        req.path.startsWith('/test') ||
        req.path.startsWith('/info') ||
        req.path.startsWith('/branch') ||
        req.path.startsWith('/install') ||
        req.path.startsWith('/env-config.js') ||
        req.path.startsWith('/workspace') || // workspace info
        req.path.startsWith('/apps') ||
        req.path.startsWith('/app/')
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
        console.log(chalk.dim('Endpoints: /files, /file, /info, /branch, /test, /workspace, /apps, /app/launch'));
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
