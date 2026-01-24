/* eslint-disable no-console */
import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import chalk from 'chalk';
import { simpleGit, type SimpleGit } from 'simple-git';
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
  if (!silent) console.log(`${chalk.green('✓')} Created ${chalk.cyan('.gitignore')}`);
}

async function initializeGitRepository(targetDir: string, silent = false): Promise<SimpleGit | null> {
  try {
    const git = simpleGit(targetDir);
    const isRepo = await git.checkIsRepo();

    if (!isRepo) {
      await git.init();
      await git.checkoutLocalBranch('main');
      if (!silent) console.log(`${chalk.green('✓')} Initialized ${chalk.cyan('git')} repository`);
    } else {
      if (!silent) console.log(chalk.dim('ℹ️  Git repository already initialized.'));
    }

    return git;
  } catch (error) {
    if (!silent) {
      console.log(
        chalk.yellow(`⚠️  Skipping git initialization: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    return null;
  }
}

export async function setupGitRepository(targetDir: string, silent = false): Promise<SimpleGit | null> {
  console.log(`[ProjectInitializer] Setting up git repository at ${targetDir}`);
  writeGitignore(targetDir, silent);

  const git = await initializeGitRepository(targetDir, silent);
  if (!git) {
    console.log('[ProjectInitializer] Git repository initialization skipped or failed');
    return null;
  }

  try {
    console.log('[ProjectInitializer] Adding files to git repository');
    await git.add('.');
    const status = await git.status();
    if (status.files.length > 0) {
      console.log(`[ProjectInitializer] Creating initial git commit with ${status.files.length} files`);
      await git.commit('chore: initial Agentlang app scaffold');
      if (!silent) console.log(`${chalk.green('✓')} Created initial git commit`);
      console.log('[ProjectInitializer] Initial git commit created successfully');
    } else {
      console.log('[ProjectInitializer] No files to commit');
    }
  } catch (error) {
    console.error('[ProjectInitializer] Error setting up git repository:', error);
    if (!silent) {
      console.log(chalk.yellow(`⚠️  Skipping commit: ${error instanceof Error ? error.message : String(error)}`));
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
    if (!silent) console.log(chalk.dim('Generating app template via AI...'));
    coreContent = await generateApp(prompt, appName);
    if (!silent) console.log(`${chalk.green('✓')} Finished generating app template via AI`);
  } else {
    coreContent = `module ${appName}.core`;
  }

  // Check if already initialized
  if (isAppInitialized(targetDir)) {
    if (!silent) {
      console.log(chalk.yellow('⚠️  This directory already contains an Agentlang application.'));
      console.log(chalk.dim('   Found existing package.json or .al files.'));
      console.log(chalk.dim('   No initialization needed.'));
    }
    throw new Error('Directory already initialized');
  }

  try {
    console.log(`[ProjectInitializer] Starting initialization for "${appName}" at ${targetDir}`);
    if (!silent) console.log(chalk.cyan(`🚀 Initializing Agentlang application: ${chalk.bold(appName)}\n`));

    if (!existsSync(targetDir)) {
      console.log(`[ProjectInitializer] Creating directory: ${targetDir}`);
      mkdirSync(targetDir, { recursive: true });
    } else {
      console.log(`[ProjectInitializer] Directory already exists: ${targetDir}`);
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
    console.log(`[ProjectInitializer] Creating package.json for "${appName}"`);
    writeFileSync(join(targetDir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf-8');
    if (!silent) console.log(`${chalk.green('✓')} Created ${chalk.cyan('package.json')}`);

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

    console.log(`[ProjectInitializer] Creating config.al for "${appName}"`);
    writeFileSync(join(targetDir, 'config.al'), configAlContent, 'utf-8');
    if (!silent) console.log(`${chalk.green('✓')} Created ${chalk.cyan('config.al')}`);

    // Create src directory
    const srcDir = join(targetDir, 'src');
    mkdirSync(srcDir, { recursive: true });

    console.log(`[ProjectInitializer] Creating src/core.al for "${appName}"`);
    writeFileSync(join(srcDir, 'core.al'), coreContent, 'utf-8');
    if (!silent) console.log(`${chalk.green('✓')} Created ${chalk.cyan('src/core.al')}`);

    // Install dependencies
    if (!skipInstall) {
      console.log(`[ProjectInitializer] Installing dependencies for "${appName}" (this may take a while)...`);
      const installStartTime = Date.now();
      if (!silent) console.log(chalk.cyan('\n📦 Installing dependencies...'));
      try {
        execSync('npm install', { cwd: targetDir, stdio: silent ? 'ignore' : 'inherit' });
        const installDuration = Date.now() - installStartTime;
        console.log(`[ProjectInitializer] Dependencies installed for "${appName}" in ${installDuration}ms`);
        if (!silent) console.log(`${chalk.green('✓')} Dependencies installed`);
      } catch (error) {
        const installDuration = Date.now() - installStartTime;
        console.error(
          `[ProjectInitializer] Failed to install dependencies for "${appName}" after ${installDuration}ms:`,
          error,
        );
        if (!silent)
          console.log(chalk.yellow('⚠️  Failed to install dependencies. You may need to run npm install manually.'));
      }
    } else {
      console.log(`[ProjectInitializer] Skipping dependency installation for "${appName}"`);
    }

    if (!skipGit) {
      console.log(`[ProjectInitializer] Initializing git repository for "${appName}"`);
      await setupGitRepository(targetDir, silent);
      console.log(`[ProjectInitializer] Git repository initialized for "${appName}"`);
    } else {
      console.log(`[ProjectInitializer] Skipping git initialization for "${appName}"`);
    }

    console.log(`[ProjectInitializer] Successfully completed initialization for "${appName}"`);
  } catch (error) {
    console.error(`[ProjectInitializer] Error initializing application "${appName}":`, error);
    if (!silent)
      console.error(chalk.red('❌ Error initializing application:'), error instanceof Error ? error.message : error);
    throw error;
  }
};
