/* eslint-disable no-console */
import { Router } from 'express';
import path from 'path';
import { StudioServer } from './services/StudioServer.js';
import { FileService } from './services/FileService.js';
import { FileController } from './controllers/FileController.js';

export function createRoutes(studioServer: StudioServer, fileService: FileService): Router {
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

  // Workspace Info Route - returns workspace metadata including initial app
  router.get('/workspace', (_req, res) => {
    const workspaceInfo = studioServer.getWorkspaceInfo();
    res.json(workspaceInfo);
  });

  // App Management Routes
  router.get('/apps', (_req, res) => {
    const apps = studioServer.discoverApps();
    res.json(apps);
  });

  router.post('/app/create', async (req, res) => {
    const { name } = req.body as { name?: string };
    if (!name) {
      res.status(400).json({ error: 'App name is required' });
      return;
    }

    try {
      const appInfo = await studioServer.createApp(name);
      res.json(appInfo);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post('/app/import', async (req, res) => {
    const { path: sourcePath, name: newName, branch, githubUsername, githubToken } = req.body as {
      path?: string;
      name?: string;
      branch?: string;
      githubUsername?: string;
      githubToken?: string;
    };

    if (!sourcePath) {
      res.status(400).json({ error: 'Source path is required' });
      return;
    }

    // If no new name provided, use the folder name from the source path
    let appName = newName;
    if (!appName) {
      if (sourcePath.startsWith('http') || sourcePath.startsWith('git@')) {
        // Try to infer from URL
        const parts = sourcePath.split('/');
        const lastPart = parts[parts.length - 1].replace('.git', '');
        appName = lastPart;
      } else {
        appName = path.basename(sourcePath);
      }
    }

    // Build credentials object if provided
    const credentials = githubUsername && githubToken
      ? { username: githubUsername, token: githubToken }
      : undefined;

    try {
      const appInfo = await studioServer.forkApp(sourcePath, appName, { credentials, branch });
      res.json(appInfo);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
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

  router.delete('/app/delete', async (req, res) => {
    const { path: appPath } = req.body as { path?: string };
    if (!appPath) {
      res.status(400).json({ error: 'App path required' });
      return;
    }

    try {
      await studioServer.deleteApp(appPath);
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
