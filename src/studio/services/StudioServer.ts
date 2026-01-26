/* eslint-disable no-console */
import { FileService } from './FileService.js';
import { AppManagementService } from './AppManagementService.js';
import { AppRuntimeService } from './AppRuntimeService.js';
import { GitHubService } from './GitHubService.js';
import { WorkspaceService } from './WorkspaceService.js';
import { AppInfo, WorkspaceInfo } from '../types.js';
import { ForkOptions } from '../../utils/forkApp.js';

export class StudioServer {
  private appManagementService: AppManagementService;
  private appRuntimeService: AppRuntimeService;
  private githubService: GitHubService;
  private workspaceService: WorkspaceService;

  constructor(workspaceRoot: string, initialAppPath: string | null, fileService: FileService) {
    this.appManagementService = new AppManagementService(workspaceRoot);
    this.appRuntimeService = new AppRuntimeService(fileService);
    this.githubService = new GitHubService();
    this.workspaceService = new WorkspaceService(workspaceRoot, initialAppPath);
  }

  getWorkspaceRoot(): string {
    return this.workspaceService.getWorkspaceInfo(this.appRuntimeService.getCurrentApp()).workspaceRoot;
  }

  getInitialAppPath(): string | null {
    return this.workspaceService.getWorkspaceInfo(this.appRuntimeService.getCurrentApp()).initialAppPath;
  }

  discoverApps(): AppInfo[] {
    return this.workspaceService.discoverApps();
  }

  getWorkspaceInfo(): WorkspaceInfo {
    return this.workspaceService.getWorkspaceInfo(this.appRuntimeService.getCurrentApp());
  }

  async createApp(name: string): Promise<AppInfo> {
    return this.appManagementService.createApp(name);
  }

  async forkApp(
    sourcePath: string,
    newAppName: string,
    options?: ForkOptions,
  ): Promise<AppInfo> {
    return this.appManagementService.forkApp(sourcePath, newAppName, options);
  }

  async deleteApp(appPath: string): Promise<void> {
    const currentAppPath = this.appRuntimeService.getCurrentApp();
    if (currentAppPath === appPath) {
      this.appRuntimeService.stopApp(true, this.getWorkspaceRoot());
    }
    return this.appManagementService.deleteApp(appPath);
  }

  async launchApp(appPath: string): Promise<void> {
    return this.appRuntimeService.launchApp(appPath);
  }

  stopApp(resetToRoot = true): void {
    this.appRuntimeService.stopApp(resetToRoot, this.getWorkspaceRoot());
  }

  getCurrentApp(): string | null {
    return this.appRuntimeService.getCurrentApp();
  }

  async pushToGitHub(
    appPath: string,
    options: {
      githubToken: string;
      githubUsername: string;
      repoName: string;
    },
  ): Promise<{ success: boolean; message: string }> {
    return this.githubService.pushToGitHub(appPath, options);
  }
}
