import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { UISpec } from './specLoader.js';

interface ProjectAnalysis {
  exists: boolean;
  isEmpty: boolean;
  fileCount: number;
  hasPackageJson: boolean;
  hasSourceFiles: boolean;
  structure: string; // Tree-like structure of the project
}

/* eslint-disable no-console */
/**
 * Analyzes the existing UI directory to determine if it exists and what's in it
 */
async function analyzeExistingProject(projectDir: string): Promise<ProjectAnalysis> {
  const analysis: ProjectAnalysis = {
    exists: false,
    isEmpty: true,
    fileCount: 0,
    hasPackageJson: false,
    hasSourceFiles: false,
    structure: '',
  };

  try {
    // Check if directory exists
    if (!(await fs.pathExists(projectDir))) {
      return analysis;
    }

    analysis.exists = true;

    // Get all files in the directory (excluding node_modules, etc.)
    const files: string[] = [];
    async function scanDirectory(dir: string, prefix = ''): Promise<void> {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        // Skip common directories
        if (['node_modules', '.git', 'dist', 'build', '.vscode'].includes(entry.name)) {
          continue;
        }

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(projectDir, fullPath);
        files.push(relativePath);

        if (entry.name === 'package.json') {
          analysis.hasPackageJson = true;
        }

        if (entry.name.endsWith('.tsx') || entry.name.endsWith('.ts') || entry.name.endsWith('.jsx')) {
          analysis.hasSourceFiles = true;
        }

        if (entry.isDirectory()) {
          await scanDirectory(fullPath, `${prefix}  `);
        }
      }
    }

    await scanDirectory(projectDir);

    analysis.fileCount = files.length;
    analysis.isEmpty = files.length === 0;

    // Generate structure string (show first 20 files)
    if (files.length > 0) {
      const displayFiles = files.slice(0, 20).sort();
      analysis.structure = displayFiles.join('\n');
      if (files.length > 20) {
        analysis.structure += `\n... and ${files.length - 20} more files`;
      }
    }

    return analysis;
  } catch (error) {
    console.log(
      chalk.yellow(`  ⚠️  Error analyzing directory: ${error instanceof Error ? error.message : String(error)}`),
    );
    return analysis;
  }
}
/* eslint-enable no-console */

/* eslint-disable no-console */
export async function generateUI(
  uiSpec: UISpec,
  outputBaseDir: string,
  apiKey: string,
  shouldPush = false,
  userMessage?: string,
): Promise<void> {
  const spinner = ora('Initializing UI generation...').start();
  const startTime = Date.now();

  try {
    // Create output directory as 'ui' in the specified base directory
    const projectDir = path.join(outputBaseDir, 'ui');

    // Analyze existing project
    spinner.text = 'Analyzing existing project...';
    const projectAnalysis = await analyzeExistingProject(projectDir);

    // Determine the generation mode
    let mode: 'fresh' | 'update' | 'incremental';
    if (userMessage) {
      // User provided a message
      if (projectAnalysis.exists && !projectAnalysis.isEmpty) {
        mode = 'update'; // Update existing project based on user message
      } else {
        mode = 'fresh'; // Generate fresh, then apply user message
      }
    } else {
      // No user message
      if (projectAnalysis.exists && !projectAnalysis.isEmpty) {
        mode = 'incremental'; // Add missing files based on spec
      } else {
        mode = 'fresh'; // Fresh generation
      }
    }

    // Display mode info on separate line
    if (mode === 'fresh') {
      spinner.text = `Creating new project: ${projectDir}`;
      console.log(''); // Empty line for spacing

      // Warn if directory exists with files but we're in fresh mode (shouldn't happen)
      if (projectAnalysis.exists && projectAnalysis.fileCount > 0) {
        console.log(chalk.yellow(`  ⚠️  Warning: Directory exists with ${projectAnalysis.fileCount} files`));
        console.log(chalk.yellow('  ⚠️  Switching to incremental mode to preserve existing files'));
        mode = 'incremental';
      } else {
        console.log(chalk.cyan('  📦 Mode: Fresh generation'));
      }
    }

    if (mode === 'incremental') {
      spinner.succeed('Project analyzed');
      console.log(''); // Empty line for spacing
      console.log(chalk.cyan('  🔄 Mode: Incremental update'));
      console.log(chalk.gray(`  📂 Found existing project with ${projectAnalysis.fileCount} files`));
      console.log(chalk.gray('  📝 Will add missing files based on spec'));
      spinner.start('Preparing incremental update...');
    } else if (mode === 'update') {
      spinner.succeed('Project analyzed');
      console.log(''); // Empty line for spacing
      console.log(chalk.cyan('  ✏️  Mode: User-directed update'));
      console.log(chalk.gray(`  📂 Found existing project with ${projectAnalysis.fileCount} files`));
      console.log(chalk.gray(`  💬 User message: "${userMessage}"`));

      // Check if request is vague
      const vagueKeywords = ['fix', 'make sure', 'properly', 'work', 'working', 'issue', 'problem', 'error'];
      const isVague = vagueKeywords.some(keyword => userMessage?.toLowerCase().includes(keyword));
      if (isVague) {
        console.log(chalk.yellow('  ⚠️  Note: Request is general - agent will first diagnose issues'));
      }

      spinner.start('Preparing update...');
    }

    await fs.ensureDir(projectDir);

    // Track generated files and operations
    const generatedFiles: string[] = [];
    const filesCreated: string[] = [];
    const directoriesCreated: string[] = [];
    let lastFileCreated = '';

    // Define tools for the agent using the correct API
    const writeFile = tool(
      'write_file',
      'Write content to a file in the project directory',
      z.object({
        file_path: z.string().describe('Relative path from project root (e.g., "src/App.tsx")'),
        content: z.string().describe('The content to write to the file'),
      }).shape,
      async args => {
        const fullPath = path.join(projectDir, args.file_path);

        // Ensure directory exists
        await fs.ensureDir(path.dirname(fullPath));

        // Write the file
        await fs.writeFile(fullPath, args.content, 'utf-8');

        // Track file creation
        generatedFiles.push(args.file_path);
        filesCreated.push(args.file_path);
        lastFileCreated = args.file_path;

        return {
          content: [
            {
              type: 'text',
              text: `Successfully wrote file: ${args.file_path}`,
            },
          ],
        };
      },
    );

    const createDirectory = tool(
      'create_directory',
      'Create a directory in the project',
      z.object({
        dir_path: z.string().describe('Relative directory path from project root'),
      }).shape,
      async args => {
        const fullPath = path.join(projectDir, args.dir_path);
        await fs.ensureDir(fullPath);

        // Track silently
        directoriesCreated.push(args.dir_path);

        return {
          content: [
            {
              type: 'text',
              text: `Successfully created directory: ${args.dir_path}`,
            },
          ],
        };
      },
    );

    const listFiles = tool('list_files', 'List files that have been generated so far', z.object({}).shape, () =>
      Promise.resolve({
        content: [
          {
            type: 'text',
            text: `Generated files:\n${generatedFiles.map(f => `- ${f}`).join('\n')}`,
          },
        ],
      }),
    );

    // Create MCP server with our tools
    const mcpServer = createSdkMcpServer({
      name: 'ui-generator-tools',
      version: '1.0.0',
      tools: [writeFile, createDirectory, listFiles],
    });

    // Create the generation prompt
    const prompt = createGenerationPrompt(uiSpec, projectDir, mode, projectAnalysis, userMessage);

    // Configure SDK with API key
    process.env.ANTHROPIC_API_KEY = apiKey;

    // Change working directory to projectDir so Write tool creates files in the right place
    const originalCwd = process.cwd();
    process.chdir(projectDir);

    // Start clean generation
    console.log('');
    spinner.start(chalk.cyan('Starting agent...'));

    // Query Claude with our MCP server
    const session = query({
      prompt,
      options: {
        mcpServers: {
          'ui-generator-tools': mcpServer,
        },
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
        },
        permissionMode: 'bypassPermissions', // Allow all tool operations without asking
        // Allow all tools - agent can use MCP tools, Write, Read, Edit, Bash, etc.
      },
    });

    // Helper function to count files in real-time
    const countCurrentFiles = async (): Promise<number> => {
      try {
        let count = 0;
        const scan = async (dir: string): Promise<void> => {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (['node_modules', '.git', 'dist', 'build'].includes(entry.name)) continue;
            if (entry.isDirectory()) {
              await scan(path.join(dir, entry.name));
            } else {
              count++;
            }
          }
        };
        await scan(projectDir);
        return count;
      } catch {
        return 0;
      }
    };

    // Process messages from the agent
    let toolCallCount = 0;
    let lastProgressUpdate = Date.now();
    let currentThinking = '';
    let currentTool = '';
    let cachedFileCount = 0;
    let lastFileCountUpdate = Date.now();
    let sessionSucceeded = false;
    let sessionError: string | undefined;
    const PROGRESS_UPDATE_INTERVAL = 10000; // Update every 10 seconds
    const FILE_COUNT_UPDATE_INTERVAL = 2000; // Update file count every 2 seconds

    for await (const message of session) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const now = Date.now();

      if (message.type === 'assistant') {
        // Extract text content and tool calls from assistant message
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              // Extract thinking message
              const text = block.text;
              if (text.trim()) {
                // Clean up the text: take first sentence or first 60 chars
                const firstSentence = text.split(/[.!?]\s/)[0];
                const cleaned = firstSentence.replace(/\n/g, ' ').slice(0, 60);
                currentThinking = cleaned;
              }
            } else if (block.type === 'tool_use') {
              toolCallCount++;
              // Extract tool name
              const toolName = block.name;
              currentTool = toolName;
            }
          }
        }

        // Update file count periodically (not on every message to avoid slowdown)
        if (now - lastFileCountUpdate > FILE_COUNT_UPDATE_INTERVAL) {
          cachedFileCount = await countCurrentFiles();
          lastFileCountUpdate = now;
        }

        // Update spinner with clean progress info
        let spinnerText = chalk.cyan(`Generating... ${cachedFileCount} files • ${elapsed}s`);

        // Show current tool being used
        if (currentTool) {
          spinnerText += chalk.blue(` • Tool: ${currentTool}`);
        }

        // Show current thinking or last file created
        if (currentThinking) {
          spinnerText += chalk.gray(` • ${currentThinking}${currentThinking.length >= 60 ? '...' : ''}`);
        } else if (lastFileCreated) {
          spinnerText += chalk.gray(` • ${lastFileCreated}`);
        }

        spinner.text = spinnerText;

        // Show periodic progress updates (every 10 seconds)
        if (now - lastProgressUpdate > PROGRESS_UPDATE_INTERVAL && cachedFileCount > 0) {
          spinner.stop();
          console.log(
            chalk.gray(
              `  📊 Progress: ${cachedFileCount} files created, ${toolCallCount} operations, ${elapsed}s elapsed`,
            ),
          );
          spinner.start(spinnerText);
          lastProgressUpdate = now;
        }
      } else if (message.type === 'result') {
        // Final result
        spinner.stop();
        const finalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (message.subtype === 'success') {
          sessionSucceeded = true;
          console.log(chalk.green('\n✅ Agent completed successfully'));
          console.log(chalk.gray(`  ⏱  Time: ${finalElapsed}s`));
          console.log(chalk.gray(`  🔄 Turns: ${message.num_turns}`));
          console.log(chalk.gray(`  🔧 Operations: ${toolCallCount}`));
          console.log(chalk.gray(`  💰 Cost: $${message.total_cost_usd.toFixed(4)}`));
        } else {
          sessionSucceeded = false;
          sessionError = message.subtype;
          console.log(chalk.yellow(`\n⚠️  Agent finished with status: ${message.subtype}`));
          console.log(chalk.gray(`  ⏱  Time: ${finalElapsed}s`));

          // Check if agent did no work
          if (toolCallCount === 0) {
            console.log(chalk.yellow('\n⚠️  Warning: Agent completed but performed no operations.'));
            console.log(chalk.gray('  This might indicate:'));
            console.log(chalk.gray('  • The task description was unclear or too vague'));
            console.log(chalk.gray('  • The agent thought no changes were needed'));
            console.log(chalk.gray('  • An error occurred before tools could be used'));
          }
        }
      }
    }

    // Check if session failed
    if (!sessionSucceeded) {
      throw new Error(
        `Agent session failed with status: ${sessionError || 'unknown'}. ` +
          `The agent completed ${toolCallCount} operations before stopping.`,
      );
    }

    // Restore original working directory
    process.chdir(originalCwd);

    // Count actual files generated in the ui/ directory
    const actualFileCount = await countGeneratedFiles(projectDir);

    console.log(chalk.green('\n✅ Generation complete!'));
    console.log(chalk.green('\n📊 Summary:'));
    console.log(chalk.gray('  • Files created: ') + chalk.white(actualFileCount));
    console.log(chalk.gray('  • Time elapsed: ') + chalk.white(`${((Date.now() - startTime) / 1000).toFixed(1)}s`));
    console.log(chalk.gray('  • Output location: ') + chalk.white(projectDir));

    // Show sample files created (first 8)
    if (filesCreated.length > 0) {
      console.log(chalk.cyan('\n📄 Sample files created:'));
      const sampleFiles = filesCreated.slice(0, 8);
      sampleFiles.forEach(file => {
        console.log(chalk.gray(`  • ${file}`));
      });
      if (filesCreated.length > 8) {
        console.log(chalk.gray(`  ... and ${filesCreated.length - 8} more files`));
      }
    }

    // Git operations if requested
    if (shouldPush) {
      console.log(''); // Add newline
      await performGitOperations(projectDir, outputBaseDir, uiSpec.appInfo.title);
    }

    console.log(chalk.cyan('\n📝 Next steps:'));
    console.log(chalk.white(`   cd ${projectDir}`));
    console.log(chalk.white('   npm install'));
    console.log(chalk.white('   npm run dev'));
  } catch (error) {
    spinner.fail('UI generation failed');
    throw error;
  }
}
/* eslint-enable no-console */

/**
 * Count all files (recursively) in the generated project directory
 */
async function countGeneratedFiles(projectDir: string): Promise<number> {
  let count = 0;

  async function countInDirectory(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Skip node_modules and other common directories
          if (!['node_modules', '.git', 'dist', 'build', '.vscode'].includes(entry.name)) {
            await countInDirectory(fullPath);
          }
        } else if (entry.isFile()) {
          count++;
        }
      }
    } catch {
      // Ignore errors
    }
  }

  await countInDirectory(projectDir);
  return count;
}

/* eslint-disable no-console */
async function performGitOperations(projectDir: string, repoRoot: string, appTitle: string): Promise<void> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  const gitSpinner = ora('Preparing git operations...').start();

  try {
    // Save original directory
    const originalCwd = process.cwd();

    // Change to repo root directory
    process.chdir(repoRoot);
    gitSpinner.text = 'Checking git status...';

    // Check if it's a git repository
    try {
      await execAsync('git rev-parse --git-dir');
    } catch {
      gitSpinner.fail('Not a git repository');
      console.log(chalk.yellow('  ⚠️  Skipping git operations - not a git repository'));
      process.chdir(originalCwd);
      return;
    }

    // Check for uncommitted changes in ui/
    gitSpinner.text = 'Checking for changes...';
    const { stdout: statusOutput } = await execAsync('git status --porcelain ui/');

    if (!statusOutput.trim()) {
      gitSpinner.info('No changes to commit in ui/');
      process.chdir(originalCwd);
      return;
    }

    // Add all files in the ui directory
    gitSpinner.text = 'Adding files to git...';
    await execAsync('git add ui/');
    gitSpinner.succeed('Added ui/ to git');

    // Commit changes
    gitSpinner.start('Committing changes...');
    const commitMessage = `Add generated UI for ${appTitle}\n\n🤖 Generated with Agentlang CLI`;
    await execAsync(`git commit -m "${commitMessage}"`);
    gitSpinner.succeed('Committed changes');

    // Check if remote exists
    gitSpinner.start('Checking remote...');
    try {
      await execAsync('git remote get-url origin');
    } catch {
      gitSpinner.warn('No remote repository configured');
      console.log(chalk.yellow('  ⚠️  Skipping push - no remote configured'));
      process.chdir(originalCwd);
      return;
    }

    // Get current branch
    const { stdout: branchOutput } = await execAsync('git branch --show-current');
    const currentBranch = branchOutput.trim();

    // Push to remote
    gitSpinner.text = `Pushing to remote (${currentBranch})...`;
    await execAsync(`git push origin ${currentBranch}`);
    gitSpinner.succeed(`Pushed to remote (${currentBranch})`);

    console.log(chalk.green('\n✅ Successfully committed and pushed UI changes'));

    // Restore original directory
    process.chdir(originalCwd);
  } catch (error) {
    gitSpinner.fail('Git operations failed');
    console.log(chalk.yellow('\n⚠️  Warning: Git operations encountered an error'));
    if (error instanceof Error) {
      // Extract the meaningful part of the error message
      const errorMessage = error.message.split('\n')[0];
      console.log(chalk.gray(`  ${errorMessage}`));
    }
    console.log(chalk.yellow('  💡 You may need to commit and push manually:'));
    console.log(chalk.gray('     git add ui/'));
    console.log(chalk.gray(`     git commit -m "Add generated UI for ${appTitle}"`));
    console.log(chalk.gray('     git push'));
  }
}
/* eslint-enable no-console */

function createGenerationPrompt(
  uiSpec: UISpec,
  projectDir: string,
  mode: 'fresh' | 'update' | 'incremental',
  projectAnalysis: ProjectAnalysis,
  userMessage?: string,
): string {
  const referenceAppPath =
    '/home/prertik/Developer/fractl/ui-generator-from-spec/generated-apps/modern-car-dealership-management';

  // Mode-specific instructions
  let modeInstructions = '';
  if (mode === 'fresh') {
    modeInstructions = `
# MODE: Fresh Generation

You are creating a NEW React + TypeScript + Vite application from scratch.

⚠️ CRITICAL: You MUST generate files. Do not skip file generation thinking the task is unclear.

Your task:
1. Generate ALL required files for a complete working application
2. Follow the template structure exactly as specified below
3. Use the Write tool to create each file with its full content
4. Do not stop until all files are created

${userMessage ? `\n# ADDITIONAL REQUIREMENT\n\nAfter generating the complete base application, also implement this:\n${userMessage}` : ''}

IMPORTANT: Start creating files immediately. This is a fresh project with no existing files.`;
  } else if (mode === 'incremental') {
    modeInstructions = `
# MODE: Incremental Update

An existing UI project was found at: ${projectDir}
Existing project has ${projectAnalysis.fileCount} files.

⚠️ CRITICAL: You MUST take action. Do not complete without making changes.

Your task:
1. Use Read tool to examine the existing project structure (start with package.json)
2. Compare it with the UI spec below
3. Identify MISSING files or features based on the spec
4. Add ONLY the missing files/features using Write tool
5. If files already exist and are complete, DO NOT regenerate them
6. Update existing files ONLY if they're missing required features from the spec (use Edit tool)

Existing files (showing first 20):
\`\`\`
${projectAnalysis.structure}
\`\`\`

IMPORTANT: Read the existing files first, then make necessary additions/updates. Do not complete without doing any work.`;
  } else if (mode === 'update') {
    // Check if user message is vague/generic
    const vagueKeywords = ['fix', 'make sure', 'properly', 'work', 'working', 'issue', 'problem', 'error'];
    const isVagueRequest = vagueKeywords.some(keyword => userMessage?.toLowerCase().includes(keyword));

    modeInstructions = `
# MODE: User-Directed Update

An existing UI project was found at: ${projectDir}
Existing project has ${projectAnalysis.fileCount} files.

# USER REQUEST:
${userMessage}

Your task:
1. Use Read tool to examine relevant existing files (start with package.json, key config files, and entry points)
2. Understand the user's request: "${userMessage}"
${
  isVagueRequest
    ? `
3. IMPORTANT: The user's request is general/vague. First DIAGNOSE issues:
   - Read package.json to check dependencies and scripts
   - Read configuration files (vite.config.ts, tsconfig.json, .env)
   - Read main entry point (src/main.tsx, src/App.tsx)
   - Look for common issues: missing dependencies, incorrect imports, configuration errors
   - Check if the project structure matches the UI spec
   - Identify any incomplete features or broken components
4. Once you've identified specific issues, FIX them:
   - Add missing dependencies to package.json
   - Fix incorrect imports or paths
   - Complete incomplete features based on the UI spec
   - Fix configuration issues
   - Ensure all required files exist and are properly implemented`
    : `
3. Make TARGETED changes to implement the request
4. Modify existing files as needed using Edit tool
5. Add new files only if necessary
6. Test that your changes work with the existing codebase`
}

Existing files (showing first 20):
\`\`\`
${projectAnalysis.structure}
\`\`\`

${isVagueRequest ? 'Start by reading and diagnosing, then fix the issues you find.' : "Focus on the user's specific request. Be surgical - only change what's necessary."}`;
  }

  return `You are a UI generation agent. Your task is to work with a React + TypeScript + Vite web application based on a UI specification for an Agentlang backend system.
${modeInstructions}

⚠️ CRITICAL INSTRUCTIONS:
- You have FULL ACCESS to all tools: Write, Read, Edit, Bash, and MCP tools
- Your CURRENT WORKING DIRECTORY is: ${projectDir}
- When using Write tool, use RELATIVE paths (e.g., "src/App.tsx", "package.json")
- All files will be created in the current working directory (${projectDir})
- You have full permission - do not ask for approval
- Use the Write tool for creating files (preferred) or the MCP write_file tool
${mode !== 'fresh' ? '- Use Read tool to examine existing files before making changes\n- Use Edit tool to modify existing files' : ''}

# UI Specification

Here is the complete UI spec you need to implement:

\`\`\`json
${JSON.stringify(uiSpec, null, 2)}
\`\`\`

# Reference Application

There is a reference application at: ${referenceAppPath}

# Template System Convention

This generator follows a strict **React + Vite + TypeScript** template convention:

## Technology Stack:
- **React 18.2.0** with TypeScript for type safety
- **Vite** as the build tool and dev server
- **React Router v6** for client-side routing
- **Iconify** for icons (mdi icons from spec)
- **Formik** for form handling
- **Recharts** for data visualization
- **date-fns** for date operations
- **Axios** for HTTP requests

## Project Structure Convention:
\`\`\`
project-root/
├── src/
│   ├── main.tsx              # Entry point
│   ├── App.tsx               # Root component with routing
│   ├── index.css             # Global styles
│   ├── types/
│   │   └── index.ts          # TypeScript interfaces
│   ├── api/
│   │   ├── client.ts         # Axios instance with .env config
│   │   └── endpoints.ts      # API endpoint functions
│   ├── data/
│   │   ├── uiSpec.ts         # UI spec export
│   │   └── mockData.ts       # Mock data fallback
│   ├── components/
│   │   ├── auth/             # Authentication
│   │   ├── navigation/       # Navbar and Sidebar
│   │   ├── entity/           # Generic entity CRUD
│   │   ├── dashboard/        # Dashboard widgets
│   │   └── relationships/    # Relationship components
│   ├── context/
│   │   └── AuthContext.tsx   # Auth state
│   ├── hooks/
│   │   ├── useEntityData.ts  # Entity data fetching
│   │   └── useBackend.ts     # Backend integration hook
│   └── utils/
│       └── validation.ts     # Validation utilities
├── .env                      # Backend URL configuration
├── .env.example              # Environment template
├── vite.config.ts
├── tsconfig.json
└── package.json
\`\`\`

# Agentlang Backend Integration

## 1. Environment Configuration (.env)

Create a **.env** file for backend configuration:
\`\`\`env
VITE_BACKEND_URL=http://localhost:8080/
VITE_USE_MOCK_DATA=true
\`\`\`

**IMPORTANT**: Default to \`VITE_USE_MOCK_DATA=true\` so the app works immediately without backend.
Also create **.env.example** with the same defaults.

## 2. API Client Structure

### src/api/client.ts
- Read \`VITE_BACKEND_URL\` from environment variables
- Create an Axios instance with base URL
- If \`VITE_USE_MOCK_DATA=true\` or no backend URL, use mock data

### src/api/endpoints.ts
**Agentlang API Convention:**

For **authentication** (special endpoints):
- **Login**: \`POST /agentlang_auth/login\` with body \`{ email: "...", password: "..." }\`
- **Sign Up**: \`POST /agentlang_auth/signUp\` with body \`{ email: "...", password: "...", name: "..." }\`
- **Forgot Password**: \`POST /agentlang_auth/forgotPassword\` with body \`{ email: "..." }\`

For **entities** (CRUD operations):
- **GET all**: \`GET /<ModelName>/<Entity>\`
- **GET one**: \`GET /<ModelName>/<Entity>/:id\`
- **POST (create)**: \`POST /<ModelName>/<Entity>\` with JSON body
- **PUT (update)**: \`PUT /<ModelName>/<Entity>/:id\` with JSON body
- **DELETE**: \`DELETE /<ModelName>/<Entity>/:id\`

For **workflows/events**:
- **POST**: \`POST /<ModelName>/<WorkflowName>\` with input parameters

**Examples:**
- **Authentication:**
  - Login: \`POST /agentlang_auth/login\` → \`{ email: "user@example.com", password: "pass123" }\`
  - Sign Up: \`POST /agentlang_auth/signUp\` → \`{ email: "...", password: "...", name: "..." }\`

- **Entity:** \`CarDealership/Customer\`
  - Create: \`POST /CarDealership/Customer\` with body \`{ name: "...", contactDetails: "..." }\`
  - Get all: \`GET /CarDealership/Customer\`
  - Get one: \`GET /CarDealership/Customer/123\`

- **Workflow:** \`ProcessSale\`
  - Execute: \`POST /CarDealership/ProcessSale\` with body \`{ customerId: "...", ... }\`

## 3. Routing Convention

Use **Agentlang path structure** for all routes:

\`\`\`tsx
<Route path="/:modelName/:entityName" element={<EntityList />} />
<Route path="/:modelName/:entityName/:id" element={<EntityDetail />} />
<Route path="/:modelName/workflow/:workflowName" element={<WorkflowPage />} />
\`\`\`

**Examples:**
- \`/CarDealership/Customer\` - List all customers
- \`/CarDealership/Customer/123\` - View customer with ID 123
- \`/CarDealership/Dealer/456\` - View dealer with ID 456
- \`/CarDealership/ProcessSale\` - Execute ProcessSale workflow

Parse the route params to extract \`modelName\` and \`entityName\`, then make API calls accordingly.

# UI Spec Structure - NEW SPEC FORMAT

The UI spec now uses a **composition-based structure** with the following key patterns:

## 1. Entity UI Definitions

Each entity has multiple UI configuration keys:

### Form Specification: \`<Entity>.ui.form\`
Defines form fields and their input types:
\`\`\`json
{
  "Form": {
    "name": { "inputType": "text" },
    "contactDetails": { "inputType": "text" },
    "preferences": { "inputType": "text" }
  },
  "order": ["name", "contactDetails", "preferences"]
}
\`\`\`

### Dashboard Specification: \`<Entity>.ui.dashboard\`
References to header and body components:
\`\`\`json
[
  "CarDealership/Customer.ui.dashboard.header",
  "CarDealership/Customer.ui.dashboard.body"
]
\`\`\`

### Instance Specification: \`<Entity>.ui.instance\`
References to header, summary, and related entity tables:
\`\`\`json
[
  "CarDealership/Customer.ui.instance.header",
  "CarDealership/Customer.ui.instance.summary",
  "CarDealership/Inquiry.ui.dashboard.body",    // Related child table
  "CarDealership/Sale.ui.dashboard.body"        // Related child table
]
\`\`\`

## 2. Component Specifications

### Header Component: \`<Entity>.ui.dashboard.header\` or \`<Entity>.ui.instance.header\`
\`\`\`json
{
  "type": "collection",  // or "instance"
  "view": {
    "Heading": {
      "title": "Customers",
      "subtitle": "List of Customers",
      "showBreadcrumbs": true
    }
  }
}
\`\`\`

### Dashboard Body: \`<Entity>.ui.dashboard.body\`
\`\`\`json
{
  "type": "collection",
  "view": {
    "create": {
      "type": "button",
      "text": "Add Customer",
      "icon": "mdi:plus",
      "style": "primary",
      "actionType": "navigation",
      "action": "Customer/new"
    },
    "Table": {
      "fields": ["id", "name", "contactDetails"],
      "showGlobalFilter": true,
      "showColumnFilter": true,
      "enableSelection": true,
      "pagination": { "enabled": true, "pageSize": 25 },
      "sorting": { "enabled": true, "defaultSort": "name" },
      "actions": {
        "row": ["view", "edit", "delete"],
        "bulk": ["delete", "export", "update_status"]
      }
    }
  }
}
\`\`\`

### Instance Summary: \`<Entity>.ui.instance.summary\`
\`\`\`json
{
  "type": "instance",
  "view": {
    "edit": { "type": "button", "text": "Edit", "icon": "mdi:pencil" },
    "delete": { "type": "button", "text": "Delete", "icon": "mdi:delete" },
    "Card": {
      "fields": ["id", "name", "contactDetails"],
      "layout": "grid",
      "columns": 2
    }
  }
}
\`\`\`

## 3. Relationships Array

The \`relationships\` array defines parent-child and association relationships:
\`\`\`json
{
  "name": "CustomerInquiries",
  "type": "contains",
  "parent": "Customer",
  "child": "Inquiry",
  "displayName": "Customer Inquiries",
  "ui": {
    "showInParentDetail": true,
    "showInChildDetail": false,
    "listComponent": "table",
    "allowInlineEdit": true,
    "allowCreate": true,
    "sortBy": "timestamp"
  }
}
\`\`\`

## 4. Agents Array

The \`agents\` array defines AI assistants with chat UI:
\`\`\`json
{
  "name": "customerServiceAgent",
  "displayName": "Customer Service",
  "description": "AI assistant for customer service",
  "instruction": "Handle general inquiries...",
  "ui": {
    "chatPosition": "sidebar",
    "icon": "mdi:robot",
    "color": "#3b82f6",
    "triggerText": "Ask Customer Service",
    "showOnPages": [],
    "autoSuggest": true,
    "welcomeMessage": "Hi! I can help you with customer service."
  },
  "tools": ["CarDealership/MakeInquiry"],
  "contextEntities": []
}
\`\`\`

## 5. Navigation Configuration

The \`navigation\` object defines sidebar structure:
\`\`\`json
{
  "type": "sidebar",
  "grouping": [
    {
      "title": "Entities",
      "items": ["CarDealership/Dealer", "CarDealership/Customer"],
      "icon": "bi:card-list",
      "color": "#19c381"
    },
    {
      "title": "Agents",
      "items": ["carModelExpertAgent", "customerServiceAgent"],
      "icon": "fluent:bot-sparkle-24-regular",
      "color": "#00bcd4"
    }
  ]
}
\`\`\`

# Relationships & Embedded Tables - IMPLEMENTATION DETAILS

## Relationship Resolution Strategy

The spec uses a **composition pattern** where instance views reference child entity dashboards:

### Step 1: Parse Instance View Array
When rendering an entity detail (e.g., Customer), read the instance view:
\`\`\`json
"CarDealership/Customer.ui.instance": [
  "CarDealership/Customer.ui.instance.header",
  "CarDealership/Customer.ui.instance.summary",
  "CarDealership/Inquiry.ui.dashboard.body",    // ← Child entity reference
  "CarDealership/Sale.ui.dashboard.body"        // ← Child entity reference
]
\`\`\`

### Step 2: Identify Child Entity References
For each reference that doesn't belong to the current entity (e.g., "Inquiry.ui.dashboard.body"):
1. Extract the entity name (e.g., "Inquiry")
2. Look up the relationship in \`relationships\` array where:
   - \`parent\` matches current entity ("Customer")
   - \`child\` matches the referenced entity ("Inquiry")

### Step 3: Render Relationship Section
For the found relationship:
1. Use \`displayName\` as the section title (e.g., "Customer Inquiries")
2. Use the child entity's dashboard body spec to render the table
3. Add "Create" button if \`ui.allowCreate: true\`
4. Enable inline editing if \`ui.allowInlineEdit: true\`
5. Apply sorting from \`ui.sortBy\`

### Step 4: Fetch Related Data
Query the child entity with parent filter:
\`\`\`
GET /CarDealership/Inquiry?customerId=<customer-id>
\`\`\`

### Relationship Types:
- **\`contains\`**: Parent owns children (1:many, cascade delete)
- **\`between\`**: Association/reference (many:many or lookup)

## Implementation Components Required:

1. **src/utils/specParser.ts** - Utility functions:
   - \`getFormSpec(entityName)\` - Get form configuration
   - \`getDashboardSpec(entityName)\` - Get dashboard configuration
   - \`getInstanceSpec(entityName)\` - Get instance view configuration
   - \`getChildRelationships(parentEntity)\` - Get all child relationships
   - \`resolveComponentRef(componentRef)\` - Resolve component reference to spec

2. **src/components/dynamic/ComponentResolver.tsx** - Component resolver:
   - Takes a component reference string
   - Looks up the spec from uiSpec object
   - Renders the appropriate component (Heading, Table, Card, etc.)

3. **src/components/entity/RelationshipSection.tsx** - Relationship renderer:
   - Receives relationship spec and child dashboard spec
   - Renders titled section with child entity table
   - Handles create/edit actions based on relationship UI config

4. **src/hooks/useRelationships.ts** - Relationship data hook:
   - Fetches related child entities for a parent
   - Returns array of \`{ relationship, data }\` objects

# Workflows & Custom Actions

The UI spec contains a **\`workflows\`** array defining events/workflows. These should be exposed as custom actions:

## Implementation:
1. **Parse workflows from UI spec**
   - Each workflow has \`name\`, \`displayName\`, \`ui.showOnPages\`, \`inputs\`

2. **Show workflows as action buttons**
   - On entity list/detail pages matching \`ui.showOnPages\`
   - Display button with \`ui.buttonText\`, \`ui.icon\`, \`ui.style\`
   - Position based on \`ui.position\` (header, floating, inline)

3. **Workflow execution**
   - When clicked, show a form with workflow \`inputs\`
   - On submit, POST to \`/<ModelName>/<WorkflowName>\`
   - Show confirmation if \`ui.confirmation\` is set

4. **Example workflows:**
   - \`CreateCarModel\`: Shows on "CarDealership/Dealer" page as "Add Car Model" button
   - \`ProcessSale\`: Shows on "CarDealership/Customer" and "CarDealership/CarModel" pages
   - When executed: \`POST /CarDealership/ProcessSale\` with form data

5. **UI Integration:**
   - Create \`src/components/workflows/WorkflowButton.tsx\` for rendering workflow actions
   - Create \`src/components/workflows/WorkflowDialog.tsx\` for workflow input forms

# Your Task

Generate a COMPLETE, production-ready web application with ALL the following:

## 1. Configuration Files
   - **package.json** - All dependencies (IMPORTANT: use "agentlang-ui" as the package name, not the app-specific name)
   - **tsconfig.json** and **tsconfig.node.json**
   - **vite.config.ts**
   - **index.html**
   - **.env** - Backend URL configuration with \`VITE_USE_MOCK_DATA=true\` as default
   - **.env.example** - Environment template (same as .env)
   - **.gitignore**
   - **README.md** - Setup instructions with backend config

## 2. API Layer
   - **src/api/client.ts** - Axios client with .env integration
   - **src/api/endpoints.ts** - Agentlang endpoint functions:
     * Auth: \`/agentlang_auth/login\`, \`/agentlang_auth/signUp\`, \`/agentlang_auth/forgotPassword\`
     * Entities: \`/<ModelName>/<Entity>\` pattern
     * Workflows: \`/<ModelName>/<WorkflowName>\` pattern

## 3. Core Application
   - **src/main.tsx** - Entry point
   - **src/App.tsx** - Routing with /:modelName/:entityName pattern
   - **src/index.css** - Global styles

## 4. Types
   - **src/types/index.ts** - TypeScript interfaces for all entities and workflows

## 5. Data
   - **src/data/uiSpec.ts** - Export UI spec
   - **src/data/mockData.ts** - Mock data for when backend is unavailable (include mock user data for auth)

## 6. Authentication
   - **src/components/auth/SignIn.tsx** - Uses \`POST /agentlang_auth/login\`
   - **src/components/auth/SignUp.tsx** - Uses \`POST /agentlang_auth/signUp\`
   - Add forgot password support using \`POST /agentlang_auth/forgotPassword\`

## 7. Navigation
   - **src/components/navigation/Sidebar.tsx** - With grouping from UI spec
   - **src/components/navigation/Navbar.tsx**

## 8. Spec Parser Utilities (NEW - CRITICAL)
   - **src/utils/specParser.ts** - Utility functions for parsing the UI spec:
     * \`getFormSpec(entityName)\` - Returns form configuration for an entity
     * \`getDashboardSpec(entityName)\` - Returns dashboard configuration
     * \`getInstanceSpec(entityName)\` - Returns instance view configuration
     * \`getChildRelationships(parentEntity)\` - Returns all child relationships
     * \`resolveComponentRef(componentRef)\` - Resolves component reference to spec object
     * \`getEntityFromPath(path)\` - Extracts entity name from path (e.g., "CarDealership/Customer")
     * \`parseComponentReference(ref)\` - Parses component refs like "CarDealership/Customer.ui.instance.header"

## 9. Dynamic Component System (NEW - CRITICAL)
   - **src/components/dynamic/ComponentResolver.tsx** - Resolves and renders components from spec:
     * Takes a component reference string (e.g., "CarDealership/Customer.ui.instance.header")
     * Looks up the spec from uiSpec object using resolveComponentRef
     * Determines component type (Heading, Table, Card, Form, Button)
     * Renders the appropriate component with spec data
   - **src/components/dynamic/DynamicHeading.tsx** - Renders heading from spec
   - **src/components/dynamic/DynamicTable.tsx** - Renders table from spec with:
     * Column configuration from \`fields\` array
     * Pagination from \`pagination\` config
     * Sorting from \`sorting\` config
     * Row/bulk actions from \`actions\` config
     * Global/column filters based on \`showGlobalFilter\` and \`showColumnFilter\`
   - **src/components/dynamic/DynamicCard.tsx** - Renders summary card from spec:
     * Grid layout based on \`layout\` and \`columns\`
     * Field display from \`fields\` array
   - **src/components/dynamic/DynamicForm.tsx** - Renders form from spec:
     * Maps \`inputType\` to form controls (text, number, datetime-local, select)
     * Applies field order from \`order\` array
     * Integrates with Formik for validation and submission
   - **src/components/dynamic/DynamicButton.tsx** - Renders action buttons from spec:
     * Handles \`actionType\`: navigation, modal, submit
     * Displays icon from Iconify based on \`icon\` field

## 10. Entity Management (Generic & Reusable - ENHANCED)
   - **src/components/entity/EntityList.tsx** - Lists with spec-driven rendering:
     * Uses ComponentResolver to render dashboard header and body
     * Reads dashboard spec: \`spec["<Entity>.ui.dashboard"]\`
     * Dynamically renders table/cards based on dashboard body spec
   - **src/components/entity/EntityDetail.tsx** - Details with spec-driven rendering:
     * Uses ComponentResolver to render instance components
     * Reads instance spec: \`spec["<Entity>.ui.instance"]\`
     * Iterates through instance view array and renders each component
     * **Identifies child entity references** (e.g., "Inquiry.ui.dashboard.body")
     * For child references, renders RelationshipSection component
   - **src/components/entity/EntityForm.tsx** - Uses DynamicForm component:
     * Reads form spec: \`spec["<Entity>.ui.form"]\`
     * Passes to DynamicForm for rendering
   - **src/components/entity/RelationshipSection.tsx** - Renders embedded child entity tables:
     * Receives relationship spec and child dashboard spec
     * Displays section title from \`relationship.displayName\`
     * Uses DynamicTable to render child entity data
     * Shows "Create" button if \`relationship.ui.allowCreate: true\`
     * Enables inline editing if \`relationship.ui.allowInlineEdit: true\`
     * Fetches data using useRelationships hook

## 11. Agent Integration (NEW - CRITICAL)
   - **src/components/agents/AgentChat.tsx** - Chat interface for AI agents:
     * Reads agent spec from \`spec.agents\` array
     * Positions chat based on \`ui.chatPosition\` (sidebar, modal, fullscreen)
     * Displays \`ui.welcomeMessage\` on open
     * Sends messages to: \`POST /agents/<agentName>/chat\`
     * Handles streaming responses
     * Executes agent tools (calls tool endpoints when agent requests)
   - **src/components/agents/AgentList.tsx** - Lists all available agents:
     * Displays agent cards with \`displayName\`, \`description\`, \`icon\`
     * Click to open agent chat
   - **src/components/agents/AgentTrigger.tsx** - Trigger button for context-aware agents:
     * Shows on pages listed in \`ui.showOnPages\`
     * Passes \`contextEntities\` data to agent when opened
   - **src/hooks/useAgentChat.ts** - Hook for agent chat functionality:
     * Manages chat state (messages, loading, streaming)
     * Sends messages to agent endpoint
     * Handles tool execution callbacks

## 12. Workflows
   - **src/components/workflows/WorkflowButton.tsx** - Workflow action button
   - **src/components/workflows/WorkflowDialog.tsx** - Workflow input form/dialog

## 13. Dashboard
   - **src/components/dashboard/Dashboard.tsx**
   - **src/components/dashboard/StatCard.tsx**
   - **src/components/dashboard/ChartWidget.tsx**

## 14. Context
   - **src/context/AuthContext.tsx**

## 15. Hooks (ENHANCED)
   - **src/hooks/useEntityData.ts** - Entity CRUD operations
   - **src/hooks/useBackend.ts** - Backend connection checking
   - **src/hooks/useRelationships.ts** - Fetch related entity data:
     * Takes parent entity name and parent ID
     * Finds all child relationships from spec
     * Fetches child data for each relationship
     * Returns array of \`{ relationship, data, loading, error }\`
   - **src/hooks/useAgentChat.ts** - Agent chat functionality (see Agent Integration section)

## 16. Utils (ENHANCED)
   - **src/utils/validation.ts** - Validation utilities
   - **src/utils/routeParser.ts** - Parse Agentlang routes
   - **src/utils/specParser.ts** - Spec parsing utilities (see Spec Parser section)

# Implementation Requirements

## Core Requirements (Keep All Previous):
✅ **Agentlang Routing**: Use /:modelName/:entityName format everywhere
✅ **Backend Integration**: Read .env for backend URL, fallback to mock data
✅ **Mock Mode Default**: Set \`VITE_USE_MOCK_DATA=true\` in .env so app works immediately
✅ **Auth Endpoints**: Use \`/agentlang_auth/login\`, \`/agentlang_auth/signUp\`, \`/agentlang_auth/forgotPassword\`
✅ **API Pattern**: Entities follow \`/<ModelName>/<Entity>\`, workflows follow \`/<ModelName>/<WorkflowName>\`
✅ **TypeScript**: Proper typing for all components
✅ **Error Handling**: Handle backend unavailable gracefully
✅ **Loading States**: Show spinners during API calls
✅ **Responsive**: Mobile-friendly design
✅ **Mock Data**: Include mock user/auth data for testing authentication flow

## NEW Spec-Driven Requirements (CRITICAL):

✅ **Spec Parser**: Create \`src/utils/specParser.ts\` with ALL utility functions:
   - \`getFormSpec(entityName)\` - Returns \`spec["<Entity>.ui.form"]\`
   - \`getDashboardSpec(entityName)\` - Returns \`spec["<Entity>.ui.dashboard"]\` array
   - \`getInstanceSpec(entityName)\` - Returns \`spec["<Entity>.ui.instance"]\` array
   - \`getChildRelationships(parentEntity)\` - Filters \`spec.relationships\` where parent matches
   - \`resolveComponentRef(componentRef)\` - Looks up spec object from reference string
   - All functions must handle full entity paths (e.g., "CarDealership/Customer")

✅ **Dynamic Components**: Create complete \`src/components/dynamic/\` directory:
   - **ComponentResolver.tsx** - Main resolver that:
     * Takes component reference (e.g., "CarDealership/Customer.ui.instance.header")
     * Uses \`resolveComponentRef\` to get spec object
     * Detects component type from spec.view keys (Heading, Table, Card, etc.)
     * Renders appropriate Dynamic* component
   - **DynamicHeading.tsx** - Renders heading from \`view.Heading\` spec
   - **DynamicTable.tsx** - Full-featured table with pagination, sorting, filtering, row/bulk actions
   - **DynamicCard.tsx** - Grid layout card for instance summaries
   - **DynamicForm.tsx** - Form builder with Formik integration and input type mapping
   - **DynamicButton.tsx** - Action button renderer with icon and action handling

✅ **Enhanced EntityDetail**: Make \`EntityDetail.tsx\` spec-driven:
   - Read \`spec["<Entity>.ui.instance"]\` array
   - Iterate through component references
   - Use ComponentResolver to render each reference
   - **Detect child entity references**: if reference contains different entity name than current
   - For child references, look up relationship and render RelationshipSection

✅ **Enhanced EntityList**: Make \`EntityList.tsx\` spec-driven:
   - Read \`spec["<Entity>.ui.dashboard"]\` array
   - Use ComponentResolver to render header and body components
   - Table configuration comes from dashboard body spec

✅ **Relationship Resolution**:
   - In EntityDetail, when processing instance view array
   - If component reference is for different entity (e.g., viewing Customer but see "Inquiry.ui.dashboard.body")
   - Look up relationship: \`spec.relationships.find(r => r.parent === currentEntity && r.child === refEntity)\`
   - Pass relationship spec + child dashboard spec to RelationshipSection

✅ **Agent Integration**:
   - Create \`/agents\` route listing all agents from \`spec.agents\`
   - Create \`/agents/:agentName\` route for agent chat
   - Agent chat sends to: \`POST /agents/:agentName/chat\`
   - Handle agent tool execution by calling tool endpoints

✅ **Navigation from Spec**:
   - Read \`spec.navigation.grouping\`
   - Build sidebar with groups and items
   - Entity items link to \`/:modelName/:entityName\`
   - Agent items link to \`/agents/:agentName\`

✅ **Branding from Spec**:
   - Apply \`spec.branding.primaryColor\` and \`spec.branding.secondaryColor\` to theme
   - Use \`spec.branding.logo\` and \`spec.branding.favicon\`
   - Apply colors to navigation groups from \`navigation.grouping[].color\`

✅ **Form Validation from Spec**:
   - Read \`spec.login.form.validation\` and \`spec.signUp.form.validation\`
   - Apply validation rules to auth forms
   - Use validation patterns (email, minLength, pattern) in DynamicForm

# Tools Available

You have FULL PERMISSION to use ALL tools without asking:

**Primary Tools (Use These):**
- **Write** - Create new files with content (PREFERRED for file creation)
- **Read** - Read existing files
- **Edit** - Edit existing files
- **Bash** - Run shell commands

**MCP Tools (Alternative):**
- **write_file** - Alternative way to write files
- **create_directory** - Creates a directory
- **list_files** - Lists all generated files

IMPORTANT:
- Use the **Write** tool for creating files (this is preferred and will work correctly)
- All paths should be RELATIVE (e.g., "src/App.tsx", not "/full/path/src/App.tsx")
- The current working directory is already set to ${projectDir}
- You have full permission - do not ask for approval
- Focus on generating a complete, working application

# Process - UPDATED FOR NEW SPEC FORMAT

Follow this order for generation:

## Phase 1: Project Setup
1. Create project directory structure
2. Generate configuration files:
   - **package.json** - Use "agentlang-ui" as package name
   - **tsconfig.json** and **tsconfig.node.json**
   - **vite.config.ts**
   - **index.html** - Use \`${uiSpec.appInfo.title}\` as title
   - **.env** - Set \`VITE_USE_MOCK_DATA=true\`, \`VITE_BACKEND_URL=http://localhost:8080/\`
   - **.env.example** - Same as .env
   - **.gitignore**

## Phase 2: Utilities & Types (CRITICAL - DO THIS FIRST)
3. Generate **src/utils/specParser.ts** - ALL parsing functions:
   - \`getFormSpec(entityName)\`
   - \`getDashboardSpec(entityName)\`
   - \`getInstanceSpec(entityName)\`
   - \`getChildRelationships(parentEntity)\`
   - \`resolveComponentRef(componentRef)\`
   - \`getEntityFromPath(path)\`
   - \`parseComponentReference(ref)\`
4. Generate **src/types/index.ts** - TypeScript interfaces for all entities
5. Generate **src/data/uiSpec.ts** - Export the full UI spec object
6. Generate **src/data/mockData.ts** - Mock data for all entities + auth

## Phase 3: API Layer
7. Generate **src/api/client.ts** - Axios client with .env integration
8. Generate **src/api/endpoints.ts** - Agentlang endpoint functions (entities, auth, agents)

## Phase 4: Hooks
9. Generate **src/hooks/useBackend.ts** - Backend connection checking
10. Generate **src/hooks/useEntityData.ts** - Entity CRUD operations
11. Generate **src/hooks/useRelationships.ts** - Fetch child relationships
12. Generate **src/hooks/useAgentChat.ts** - Agent chat functionality

## Phase 5: Dynamic Component System (CRITICAL)
13. Generate **src/components/dynamic/ComponentResolver.tsx** - Main resolver
14. Generate **src/components/dynamic/DynamicHeading.tsx** - Heading renderer
15. Generate **src/components/dynamic/DynamicTable.tsx** - Table renderer with full features
16. Generate **src/components/dynamic/DynamicCard.tsx** - Card renderer for summaries
17. Generate **src/components/dynamic/DynamicForm.tsx** - Form builder with Formik
18. Generate **src/components/dynamic/DynamicButton.tsx** - Button renderer

## Phase 6: Entity Components (Spec-Driven)
19. Generate **src/components/entity/EntityList.tsx** - Uses ComponentResolver
20. Generate **src/components/entity/EntityDetail.tsx** - Uses ComponentResolver + relationship detection
21. Generate **src/components/entity/EntityForm.tsx** - Uses DynamicForm
22. Generate **src/components/entity/RelationshipSection.tsx** - Embedded child tables

## Phase 7: Navigation & Auth
23. Generate **src/components/navigation/Sidebar.tsx** - Reads \`spec.navigation.grouping\`
24. Generate **src/components/navigation/Navbar.tsx**
25. Generate **src/components/auth/SignIn.tsx** - Uses validation from spec
26. Generate **src/components/auth/SignUp.tsx** - Uses validation from spec
27. Generate **src/context/AuthContext.tsx**

## Phase 8: Agent Integration
28. Generate **src/components/agents/AgentChat.tsx** - Chat UI
29. Generate **src/components/agents/AgentList.tsx** - List all agents
30. Generate **src/components/agents/AgentTrigger.tsx** - Context-aware trigger

## Phase 9: Workflows & Dashboard
31. Generate **src/components/workflows/WorkflowButton.tsx**
32. Generate **src/components/workflows/WorkflowDialog.tsx**
33. Generate **src/components/dashboard/Dashboard.tsx**
34. Generate **src/components/dashboard/StatCard.tsx**
35. Generate **src/components/dashboard/ChartWidget.tsx**

## Phase 10: Core Application
36. Generate **src/App.tsx** - Routing with spec-driven navigation
   - Routes: \`/:modelName/:entityName\`, \`/:modelName/:entityName/:id\`
   - Agent routes: \`/agents\`, \`/agents/:agentName\`
37. Generate **src/main.tsx** - Entry point
38. Generate **src/index.css** - Global styles with branding colors from spec
39. Generate **src/utils/validation.ts** - Validation utilities
40. Generate **src/utils/routeParser.ts** - Route parsing utilities

## Phase 11: Documentation
41. Generate **README.md** - Setup instructions, backend configuration, feature list

## IMPORTANT REMINDERS:
- **Start with specParser.ts** - Everything else depends on it
- **Dynamic components are critical** - EntityList and EntityDetail use ComponentResolver
- **Test relationship detection** - EntityDetail must detect and render child entities
- **Agent routes** - Add agent listing and chat routes to App.tsx
- **Apply branding** - Use colors from spec.branding in CSS

START NOW! Generate the complete application following this exact process.`;
}
