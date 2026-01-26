/* eslint-disable no-console */
import path from 'path';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import chalk from 'chalk';
import { initializeProject } from '../../utils/projectInitializer.js';
import { forkApp as forkAppUtil, type ForkOptions } from '../../utils/forkApp.js';
import { AppInfo } from '../types.js';

export class AppManagementService {
  constructor(private workspaceRoot: string) {}

  async createApp(name: string): Promise<AppInfo> {
    const appPath = path.join(this.workspaceRoot, name);
    console.log(`[AppManagement] createApp: Creating app "${name}" at path: ${appPath}`);

    try {
      // Use the shared initialization logic
      console.log(`[AppManagement] createApp: Starting project initialization for "${name}"`);
      const initStartTime = Date.now();

      await initializeProject(appPath, name, {
        silent: false, // Enable logging for better visibility
        skipInstall: false, // Install dependencies so the app is ready to run
        skipGit: false, // Initialize git repo
      });

      const initDuration = Date.now() - initStartTime;
      console.log(`[AppManagement] createApp: Project initialization completed for "${name}" in ${initDuration}ms`);

      const appInfo = {
        name,
        path: appPath,
        isInitialApp: false,
      };

      console.log(`[AppManagement] createApp: Successfully created app "${name}"`);
      return appInfo;
    } catch (error) {
      console.error(`[AppManagement] createApp: Failed to create app "${name}":`, error);
      throw error;
    }
  }

  async forkApp(sourcePath: string, newAppName: string, options?: ForkOptions): Promise<AppInfo> {
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

    // Delete the app directory
    console.log(chalk.yellow(`Deleting app: ${appPath}`));
    await rm(appPath, { recursive: true, force: true });
    console.log(chalk.green(`Successfully deleted app: ${appPath}`));
  }
}
