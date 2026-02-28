import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { simpleGit, type SimpleGit } from 'simple-git';
import { ui } from '../ui/index.js';
import { generateApp } from '../app-generator/index.js';

export interface InitializeProjectOptions {
  prompt?: string;
  skipInstall?: boolean;
  skipGit?: boolean;
  silent?: boolean; // If true, suppress console logs
}

// Check if an Agentlang app is already initialized
export function isAppInitialized(targetDir: string): boolean {
  try {
    const packageJsonPath = join(targetDir, 'package.json');
    const hasPackageJson = existsSync(packageJsonPath);
    const hasAgentlangFiles = findAgentlangFiles(targetDir).length > 0;
    return hasPackageJson || hasAgentlangFiles;
  } catch {
    return false;
  }
}

// Helper function to recursively find .al files (excluding config.al)
function findAgentlangFiles(dir: string, fileList: string[] = []): string[] {
  try {
    const files = readdirSync(dir);
    files.forEach(file => {
      const filePath = join(dir, file);
      try {
        const stat = statSync(filePath);
        if (stat.isDirectory()) {
          if (file !== 'node_modules' && file !== '.git') {
            findAgentlangFiles(filePath, fileList);
          }
        } else if (file.endsWith('.al') && file !== 'config.al') {
          fileList.push(filePath);
        }
      } catch {
        // Skip files/directories we can't access
      }
    });
  } catch {
    // Directory doesn't exist or can't be read
  }
  return fileList;
}

const defaultGitignoreContent = `node_modules/
dist/
build/
tmp/
temp/
.env
.env.local
.env.*.local
npm-debug.log*
pnpm-debug.log*
yarn-error.log*
.DS_Store
*.sqlite
*.db
`;

function writeGitignore(targetDir: string, silent = false): void {
  const gitignorePath = join(targetDir, '.gitignore');
  if (existsSync(gitignorePath)) {
    return;
  }

  writeFileSync(gitignorePath, defaultGitignoreContent, 'utf-8');
  if (!silent) ui.step('✓', ' Created ', '.gitignore');
}

async function initializeGitRepository(targetDir: string, silent = false): Promise<SimpleGit | null> {
  try {
    const git = simpleGit(targetDir);
    const isRepo = await git.checkIsRepo();

    if (!isRepo) {
      await git.init();
      await git.checkoutLocalBranch('main');
      if (!silent) ui.step('✓', ' Initialized ', 'git repository');
    } else {
      if (!silent) ui.dim('Git repository already initialized.');
    }

    return git;
  } catch (error) {
    if (!silent) {
      ui.warn(`Skipping git initialization: ${error instanceof Error ? error.message : String(error)}`);
    }
    return null;
  }
}

function installDependencies(targetDir: string, silent = false) {
  execSync('npm install', { cwd: targetDir, stdio: silent ? 'ignore' : 'inherit' });
}

export async function setupGitRepository(targetDir: string, silent = false): Promise<SimpleGit | null> {
  writeGitignore(targetDir, silent);

  const git = await initializeGitRepository(targetDir, silent);
  if (!git) return null;

  try {
    await git.add('.');
    const status = await git.status();
    if (status.files.length > 0) {
      await git.commit('chore: initial Agentlang app scaffold');
      if (!silent) ui.step('✓', ' Created initial git commit');
    }
  } catch (error) {
    if (!silent) {
      ui.warn(`Skipping commit: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return git;
}

export const initializeProject = async (
  targetDir: string,
  appName: string,
  options: InitializeProjectOptions = {},
): Promise<void> => {
  const { prompt, skipInstall, skipGit, silent } = options;

  let coreContent: string;

  if (prompt) {
    if (!silent) ui.dim('Generating app template via AI...');
    coreContent = await generateApp(prompt, appName);
    if (!silent) ui.step('✓', ' Finished generating app template via AI');
  } else {
    coreContent = `module ${appName}.core`;
  }

  // Check if already initialized
  if (isAppInitialized(targetDir)) {
    if (!silent) {
      ui.warn('This directory already contains an Agentlang application.');
      ui.dim('Found existing package.json or .al files.');
      ui.dim('No initialization needed.');
    }
    throw new Error('Directory already initialized');
  }

  try {
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    // Create package.json
    const packageJson = {
      name: appName,
      version: '0.0.1',
      dependencies: {
        agentlang: '*',
      },
      devDependencies: {
        '@agentlang/lstudio': '*',
      },
    };
    writeFileSync(join(targetDir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf-8');
    if (!silent) ui.step('✓', ' Created ', 'package.json');

    // Create config.al with Agentlang syntax for LLM and JSON for the rest
    const configAlContent = `{
  "agentlang": {
    "service": {
      "port": 8080
    },
    "store": {
      "type": "sqlite",
      "dbname": "${appName}.db"
    },
    "rbac": {
      "enabled": false
    },
    "auth": {
      "enabled": false
    },
    "auditTrail": {
      "enabled": true
    },
    "monitoring": {
      "enabled": true
    }
  },
  "agentlang.ai": [
    {
      "agentlang.ai/LLM": {
        "name": "llm01",
        "service": "openai",
        "config": {
          "model": "gpt-4o"
        }
      }
    }
  ]
}`;

    writeFileSync(join(targetDir, 'config.al'), configAlContent, 'utf-8');
    if (!silent) ui.step('✓', ' Created ', 'config.al');

    // Create src directory
    const srcDir = join(targetDir, 'src');
    mkdirSync(srcDir, { recursive: true });

    writeFileSync(join(srcDir, 'core.al'), coreContent, 'utf-8');
    if (!silent) ui.step('✓', ' Created ', 'src/core.al');

    // Install dependencies
    if (!skipInstall) {
      if (!silent) ui.info('Installing dependencies...');
      try {
        installDependencies(targetDir, silent);
      } catch {
        if (!silent) ui.warn('Failed to install dependencies. You may need to run npm install manually.');
      }
      if (!silent) ui.step('✓', ' Dependencies installed');
    }

    if (!skipGit) {
      await setupGitRepository(targetDir, silent);
    }
  } catch (error) {
    if (!silent) ui.error(`Error initializing application: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
};
