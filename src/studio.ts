/* eslint-disable no-console */
import express from 'express';
import cors from 'cors';
import path from 'path';
import ora from 'ora';
import { ui } from './ui/index.js';
import open from 'open';
import { getWorkspaceRoot, findLStudioPath } from './studio/utils.js';
import { FileService } from './studio/services/FileService.js';
import { StudioServer } from './studio/services/StudioServer.js';
import { createRoutes } from './studio/routes.js';

export async function startStudio(projectPath = '.', studioPort = 4000, serverOnly = false): Promise<void> {
  const inputDir = path.resolve(process.cwd(), projectPath);

  // Smart Parent Detection: Determine workspace root and initial app
  const { workspaceRoot, initialAppPath } = getWorkspaceRoot(inputDir);

  // ── Startup banner ──────────────────────────────────────────────────────────
  ui.blank();
  ui.banner(serverOnly ? 'Agent Studio' : 'Agent Studio', serverOnly ? 'Backend Server' : undefined);
  ui.blank();

  if (initialAppPath) {
    ui.label('Project', path.basename(initialAppPath), 'cyan');
  }
  ui.label('Workspace', workspaceRoot);
  ui.label('Port', String(studioPort), 'cyan');
  ui.blank();

  // ── Initialize ──────────────────────────────────────────────────────────────
  const spinner = ora({
    text: ui.format.dim('Initializing...'),
    spinner: 'dots',
  }).start();

  // Initialize Services with workspace root
  const fileService = new FileService(workspaceRoot);
  const studioServer = new StudioServer(workspaceRoot, initialAppPath, fileService);

  if (initialAppPath) {
    spinner.text = ui.format.dim(`Launching ${path.basename(initialAppPath)}...`);
    await studioServer.launchApp(initialAppPath);
  } else {
    spinner.text = ui.format.dim('Starting Dashboard Mode...');
  }

  spinner.succeed(ui.format.success('Studio initialized'));

  // Find @agentlang/lstudio (skip in server-only mode)
  let lstudioPath: string | null = null;
  if (!serverOnly) {
    lstudioPath = findLStudioPath(inputDir);
    if (!lstudioPath && inputDir !== workspaceRoot) {
      lstudioPath = findLStudioPath(workspaceRoot);
    }
    if (!lstudioPath) {
      ui.warn('Could not find @agentlang/lstudio UI files.');
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
    app.use(express.static(lstudioPath, { fallthrough: true }));

    app.use((req, res, next) => {
      if (
        req.path.startsWith('/files') ||
        req.path.startsWith('/file') ||
        req.path.startsWith('/test') ||
        req.path.startsWith('/info') ||
        req.path.startsWith('/branch') ||
        req.path.startsWith('/install') ||
        req.path.startsWith('/env-config.js') ||
        req.path.startsWith('/workspace') ||
        req.path.startsWith('/apps') ||
        req.path.startsWith('/app/') ||
        req.path.startsWith('/documents')
      ) {
        return next();
      }

      const staticFileExtensions = [
        '.js', '.css', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
        '.woff', '.woff2', '.ttf', '.eot', '.json', '.map', '.html',
      ];
      const hasStaticExtension = staticFileExtensions.some(ext => req.path.toLowerCase().endsWith(ext));

      if (hasStaticExtension) {
        return res.status(404).send('File not found');
      }

      if (req.method === 'GET' && lstudioPath) {
        res.sendFile(path.join(lstudioPath, 'index.html'));
      } else {
        next();
      }
    });
  }

  // ── Start server ────────────────────────────────────────────────────────────
  await new Promise<void>(resolve => {
    app.listen(studioPort, () => {
      const studioUrl = `http://localhost:${studioPort}`;

      ui.blank();
      ui.divider(50);
      ui.success('Studio is ready');
      ui.blank();

      if (serverOnly) {
        ui.label('API', studioUrl, 'cyan');
        ui.dim('  Endpoints: /files, /file, /info, /branch, /test, /workspace, /apps, /app/launch');
      } else {
        ui.label('Local', studioUrl, 'cyan');
      }

      ui.blank();
      ui.divider(50);
      ui.blank();

      if (!serverOnly) {
        void open(studioUrl).catch(() => {});
      }

      const cleanup = () => {
        ui.blank();
        ui.warn('Shutting down...');
        studioServer.stopApp(false);
        process.exit(0);
      };

      process.on('SIGINT', cleanup);
      process.on('SIGTERM', cleanup);

      resolve();
    });
  });
}
