import path from 'path';
import { existsSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ignoredPaths = new Set(['node_modules', '.git', 'dist', 'out', 'logs']);

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileTreeNode[];
}

/**
 * Check if a directory is a valid Agentlang project
 * A valid project has either a package.json or .al files
 */
export function isValidAgentlangProject(dirPath: string): boolean {
  try {
    // Check for package.json
    if (existsSync(path.join(dirPath, 'package.json'))) {
      return true;
    }

    // Check for .al files in the directory
    const files = readdirSync(dirPath);
    return files.some(f => f.endsWith('.al'));
  } catch {
    return false;
  }
}

/**
 * Smart Parent Detection: Determine the workspace root
 * If the given directory is itself a project, use its parent as the workspace root
 * This allows sibling projects to be discovered and new projects to be created as siblings
 */
export function getWorkspaceRoot(dirPath: string): { workspaceRoot: string; initialAppPath: string | null } {
  const isProject = isValidAgentlangProject(dirPath);

  if (isProject) {
    const parentDir = path.dirname(dirPath);
    // Check if parent has other valid projects (siblings)
    try {
      const siblings = readdirSync(parentDir).filter(name => {
        if (ignoredPaths.has(name)) return false;
        const siblingPath = path.join(parentDir, name);
        try {
          return statSync(siblingPath).isDirectory() && isValidAgentlangProject(siblingPath);
        } catch {
          return false;
        }
      });

      // If there are sibling projects (including current), use parent as workspace
      if (siblings.length >= 1) {
        return {
          workspaceRoot: parentDir,
          initialAppPath: dirPath, // The project we launched from
        };
      }
    } catch {
      // If we can't read parent, fall back to using dirPath as workspace
    }

    // Even if no siblings, if dirPath is a project, use parent as workspace
    // This allows creating new sibling projects
    return {
      workspaceRoot: parentDir,
      initialAppPath: dirPath,
    };
  }

  // dirPath is not a project, use it as workspace root
  return {
    workspaceRoot: dirPath,
    initialAppPath: null,
  };
}

export function findLStudioPath(projectDir: string): string | null {
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
  // Note: We need to go up one level from src/studio to get to root, then to node_modules if running from src
  // But if this file is in dist, __dirname structure might be different.
  // Assuming standard structure where this runs from dist/studio or src/studio
  const cliLStudioDistPath = path.join(__dirname, '..', '..', 'node_modules', '@agentlang', 'lstudio', 'dist');
  if (existsSync(cliLStudioDistPath) && existsSync(path.join(cliLStudioDistPath, 'index.html'))) {
    return cliLStudioDistPath;
  }

  // Check root of package in cli's node_modules
  const cliLStudioRootPath = path.join(__dirname, '..', '..', 'node_modules', '@agentlang', 'lstudio');
  if (existsSync(path.join(cliLStudioRootPath, 'index.html'))) {
    return cliLStudioRootPath;
  }

  return null;
}
