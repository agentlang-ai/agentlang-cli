/* eslint-disable no-console */
import path from 'path';
import { readdirSync, statSync } from 'fs';
import { isValidAgentlangProject, ignoredPaths } from '../utils.js';
import { AppInfo, WorkspaceInfo } from '../types.js';

export class WorkspaceService {
  constructor(
    private workspaceRoot: string,
    private initialAppPath: string | null,
  ) {}

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

  getWorkspaceInfo(currentApp: string | null): WorkspaceInfo {
    return {
      workspaceRoot: this.workspaceRoot,
      initialAppPath: this.initialAppPath,
      currentApp,
      apps: this.discoverApps(),
    };
  }
}
