export interface AppInfo {
  name: string;
  path: string;
  isInitialApp?: boolean; // True if this is the app we launched from
}

export interface WorkspaceInfo {
  workspaceRoot: string;
  initialAppPath: string | null;
  currentApp: string | null;
  apps: AppInfo[];
}
