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
    console.log(chalk.white('   npm run build    # Verify build succeeds'));
    console.log(chalk.white('   npm run dev      # Start development server'));
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


  return `
You are a UI generation agent for creating React + TypeScript + Tailwind applications from AgentLang specs.

${modeInstructions}

# UI SPEC
\`\`\`json
${JSON.stringify(uiSpec, null, 2)}
\`\`\`

# GOAL
Generate a complete, working, polished React admin UI that looks deployment-ready.

# APPLICATION STRUCTURE

**Navigation (Sidebar):**
- **Home Button** → Dashboard page
- **Entities Section** → List of all entities
  * Click entity → Entity list page
  * Click instance → Entity detail page (shows relationships if any)
- **Workflows Section** → List of all workflows
  * Click workflow → Opens workflow dialog

**Dashboard:**
- Stat cards (entity counts)
- Quick Actions (workflow cards)
- Recent activity/status

**Entity Detail Page (when entity has relationships):**
- Entity details at top
- Embedded relationship tables below
- Each relationship table has Search + Create button

**Chatbot Bubble (floating, bottom-right):**
- Click to open chat panel
- Agent dropdown INSIDE chat panel header
- Chat interface with message history

# PHASE 1: GENERATE ALL FILES

## Step 1: Project Setup
1. Create package.json with dependencies:
   - react, react-dom, react-router-dom
   - typescript, @types/react, @types/react-dom
   - vite, @vitejs/plugin-react
   - tailwindcss, postcss, autoprefixer
   - @iconify/react, formik, yup

2. Create configuration files:
   - tsconfig.json (strict mode)
   - vite.config.ts (standard React setup)
   - tailwind.config.js (with content paths)
   - postcss.config.js
   - index.html

3. Create **.env** file:
\`\`\`env
# Backend API URL (AgentLang server)
VITE_BACKEND_URL=http://localhost:8080/

# Mock data mode - set to true by default so app works without backend
VITE_USE_MOCK_DATA=true

# Agent chat is backend-powered - no LLM keys in frontend!
# Keys are configured in backend only
\`\`\`

Also create **.env.example** with same structure (without sensitive values).

## Step 2: API Client Setup

Create **src/api/client.ts**:
\`\`\`typescript
const API_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:8080';
const USE_MOCK = import.meta.env.VITE_USE_MOCK_DATA === 'true';

export const apiClient = {
  baseURL: API_URL,
  useMock: USE_MOCK
};
\`\`\`

Create **src/api/endpoints.ts** - AgentLang API patterns:
\`\`\`typescript
// Authentication endpoints (special)
export const authEndpoints = {
  login: '/agentlang.auth/login',        // POST { email, password }
  signUp: '/agentlang.auth/signUp',      // POST { email, password, name }
  forgotPassword: '/agentlang.auth/forgotPassword'  // POST { email }
};

// Entity CRUD endpoints (dynamic)
export const entityEndpoints = {
  list: (model: string, entity: string) => \`/\${model}/\${entity}\`,           // GET
  get: (model: string, entity: string, id: string) => \`/\${model}/\${entity}/\${id}\`,  // GET
  create: (model: string, entity: string) => \`/\${model}/\${entity}\`,         // POST
  update: (model: string, entity: string, id: string) => \`/\${model}/\${entity}/\${id}\`,  // PUT
  delete: (model: string, entity: string, id: string) => \`/\${model}/\${entity}/\${id}\`   // DELETE
};

// Workflow endpoints (dynamic)
export const workflowEndpoints = {
  execute: (model: string, workflow: string) => \`/\${model}/\${workflow}\`  // POST
};

// Agent chat endpoint
export const agentEndpoints = {
  chat: (agentName: string) => \`/agents/\${agentName}/chat\`  // POST (backend handles LLM)
};
\`\`\`

**Examples:**
- Create customer: \`POST /CarDealership/Customer\` with \`{ name: "John", contactDetails: "john@email.com" }\`
- Get all dealers: \`GET /CarDealership/Dealer\`
- Execute workflow: \`POST /CarDealership/ProcessSale\` with workflow inputs
- Login: \`POST /agentlang.auth/login\` with \`{ email: "...", password: "..." }\`

## Step 3: Mock Data Layer

Create **src/data/mockData.ts**:
\`\`\`typescript
// Generate mock data for ALL entities in the spec
export const mockData = {
  'ModelName/EntityName': [
    { id: '1', field1: 'value', field2: 'value', ... },
    { id: '2', ...},
    // At least 3-5 records per entity
  ],
  // ... all other entities
};

// Mock users for authentication (CRITICAL for login/signup to work!)
export const mockUsers = [
  {
    id: '1',
    email: 'admin@example.com',
    password: 'admin123',
    name: 'Admin User',
    role: 'admin',
    token: 'mock-token-admin-123'
  },
  {
    id: '2',
    email: 'user@example.com',
    password: 'user123',
    name: 'Demo User',
    role: 'user',
    token: 'mock-token-user-456'
  }
];

// Mock API following AgentLang patterns
export const mockApi = {
  // Authentication endpoints
  async login(email: string, password: string) {
    await new Promise(resolve => setTimeout(resolve, 500)); // Simulate network
    const user = mockUsers.find(u => u.email === email && u.password === password);
    if (!user) return { error: 'Invalid credentials', status: 'error' };
    return {
      data: {
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
        token: user.token
      },
      status: 'success'
    };
  },

  async signUp(email: string, password: string, name: string) {
    await new Promise(resolve => setTimeout(resolve, 500));
    // Check if user already exists
    if (mockUsers.find(u => u.email === email)) {
      return { error: 'User already exists', status: 'error' };
    }
    const newUser = {
      id: Date.now().toString(),
      email,
      password,
      name,
      role: 'user',
      token: \`mock-token-\${Date.now()}\`
    };
    mockUsers.push(newUser);
    return {
      data: {
        user: { id: newUser.id, email: newUser.email, name: newUser.name, role: newUser.role },
        token: newUser.token
      },
      status: 'success'
    };
  },

  async forgotPassword(email: string) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const user = mockUsers.find(u => u.email === email);
    if (!user) return { error: 'User not found', status: 'error' };
    return { data: { message: 'Password reset email sent' }, status: 'success' };
  },

  // Entity CRUD endpoints
  async list(model: string, entity: string) {
    const key = \`\${model}/\${entity}\`;
    await new Promise(resolve => setTimeout(resolve, 300));
    return { data: mockData[key] || [], status: 'success' };
  },

  async get(model: string, entity: string, id: string) {
    const key = \`\${model}/\${entity}\`;
    await new Promise(resolve => setTimeout(resolve, 200));
    const item = (mockData[key] || []).find(i => i.id === id);
    if (!item) return { error: 'Not found', status: 'error' };
    return { data: item, status: 'success' };
  },

  async create(model: string, entity: string, data: any) {
    const key = \`\${model}/\${entity}\`;
    await new Promise(resolve => setTimeout(resolve, 400));
    const newItem = { id: Date.now().toString(), ...data };
    if (!mockData[key]) mockData[key] = [];
    mockData[key].push(newItem);
    return { data: newItem, status: 'success' };
  },

  async update(model: string, entity: string, id: string, data: any) {
    const key = \`\${model}/\${entity}\`;
    await new Promise(resolve => setTimeout(resolve, 400));
    const index = (mockData[key] || []).findIndex(i => i.id === id);
    if (index === -1) return { error: 'Not found', status: 'error' };
    mockData[key][index] = { ...mockData[key][index], ...data };
    return { data: mockData[key][index], status: 'success' };
  },

  async delete(model: string, entity: string, id: string) {
    const key = \`\${model}/\${entity}\`;
    await new Promise(resolve => setTimeout(resolve, 300));
    mockData[key] = (mockData[key] || []).filter(i => i.id !== id);
    return { status: 'success' };
  },

  // Workflow execution endpoint
  async executeWorkflow(model: string, workflowName: string, inputs: any) {
    await new Promise(resolve => setTimeout(resolve, 500));
    console.log(\`Executing workflow: \${model}/\${workflowName}\`, inputs);
    // Mock successful execution
    return { status: 'success', data: { message: 'Workflow executed successfully' } };
  }
};
\`\`\`

## Step 4: Core Utilities

Create **src/data/uiSpec.ts** - export the UI spec

Create **src/utils/specParser.ts**:
\`\`\`typescript
export function getFormSpec(entityName: string) {
  return spec[\`\${entityName}.ui.form\`];
}
export function getDashboardSpec(entityName: string) {
  return spec[\`\${entityName}.ui.dashboard\`];
}
export function getInstanceSpec(entityName: string) {
  return spec[\`\${entityName}.ui.instance\`];
}
export function getChildRelationships(parentEntity: string) {
  return spec.relationships?.filter(r => r.parent === parentEntity) || [];
}
\`\`\`

Create **src/utils/workflowParser.ts**:
\`\`\`typescript
export function getWorkflows(spec: any) {
  return (spec.workflows || []).map(name => ({
    name,
    displayName: spec[name].displayName,
    description: spec[name].description,
    icon: spec[name].icon,
    ui: spec[\`\${name}.ui\`],
    inputs: spec[\`\${name}.inputs\`] || {}
  }));
}
\`\`\`

Create **src/hooks/useEntityData.ts** - CRUD hook with defensive patterns:
\`\`\`typescript
export function useEntityData(model: string, entity: string) {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const useMock = import.meta.env.VITE_USE_MOCK_DATA === 'true';
      const result = useMock
        ? await mockApi.list(model, entity)
        : await fetch(\`\${API_URL}/\${model}/\${entity}\`).then(r => r.json());

      // DEFENSIVE: Always ensure array
      setData(Array.isArray(result.data) ? result.data : []);
    } catch (err) {
      setError(err.message);
      setData([]); // DEFENSIVE: Empty array on error
    } finally {
      setLoading(false);
    }
  };

  return {
    data: Array.isArray(data) ? data : [], // DEFENSIVE: Always return array
    loading,
    error,
    fetchData
  };
}
\`\`\`

## Step 5: Dynamic Components

Create **src/components/dynamic/DynamicTable.tsx** - Reusable table with row actions:

**CRITICAL - Must include Actions column:**
\`\`\`typescript
export function DynamicTable({ data, spec, onRowClick, onCreateClick, onEdit, onDelete, showCreateButton = true }: Props) {
  // DEFENSIVE: Always validate array first
  const safeData = Array.isArray(data) ? data : [];

  const [searchTerm, setSearchTerm] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  // DEFENSIVE: Filter safely
  const filteredData = useMemo(() => {
    if (!searchTerm) return safeData;
    return safeData.filter(item =>
      Object.values(item || {}).some(v =>
        String(v || '').toLowerCase().includes(searchTerm.toLowerCase())
      )
    );
  }, [safeData, searchTerm]);

  // DEFENSIVE: Always check before spreading
  const sortedData = useMemo(() => {
    if (!Array.isArray(filteredData)) return [];
    return [...filteredData];
  }, [filteredData]);

  const paginatedData = useMemo(() => {
    if (!Array.isArray(sortedData)) return [];
    const start = (currentPage - 1) * pageSize;
    return sortedData.slice(start, start + pageSize);
  }, [sortedData, currentPage, pageSize]);

  if (safeData.length === 0) {
    return (
      <div className="text-center py-12 bg-gray-50 rounded-lg">
        <Icon icon="mdi:database-off" className="text-4xl text-gray-400 mb-2" />
        <p className="text-gray-600">No data available</p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      {/* Header with Search + Create Button TOGETHER on right */}
      <div className="flex justify-between items-center p-4 border-b border-gray-200">
        <h2 className="text-xl font-semibold text-gray-900">{spec.title}</h2>

        {/* Search and Create together on the right */}
        <div className="flex gap-3 items-center">
          <div className="relative">
            <Icon icon="mdi:magnify" className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg w-64 focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          {showCreateButton && (
            <button
              onClick={onCreateClick}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
            >
              <Icon icon="mdi:plus" />
              <span>Create</span>
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-50 border-b border-gray-200">
            <tr>
              {spec.columns.map(col => (
                <th key={col.key} className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                  {col.label}
                </th>
              ))}
              {/* CRITICAL: Actions column header */}
              <th className="px-6 py-3 text-right text-xs font-semibold text-gray-700 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {paginatedData.map((row, idx) => (
              <tr key={row.id || idx} className="hover:bg-gray-50 transition-colors">
                {spec.columns.map(col => (
                  <td
                    key={col.key}
                    onClick={() => onRowClick(row)}
                    className="px-6 py-4 text-sm text-gray-900 cursor-pointer"
                  >
                    {row[col.key]}
                  </td>
                ))}
                {/* CRITICAL: Actions column with Edit and Delete buttons */}
                <td className="px-6 py-4 text-right whitespace-nowrap">
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onEdit(row);
                      }}
                      className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                      title="Edit"
                    >
                      <Icon icon="mdi:pencil" className="text-lg" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDelete(row);
                      }}
                      className="p-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      title="Delete"
                    >
                      <Icon icon="mdi:delete" className="text-lg" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex justify-between items-center px-6 py-4 border-t border-gray-200 bg-gray-50">
        <div className="text-sm text-gray-700">
          Showing <span className="font-medium">{Math.min((currentPage - 1) * pageSize + 1, sortedData.length)}</span> to{' '}
          <span className="font-medium">{Math.min(currentPage * pageSize, sortedData.length)}</span> of{' '}
          <span className="font-medium">{sortedData.length}</span> results
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="px-3 py-1 border border-gray-300 rounded-md hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <button
            onClick={() => setCurrentPage(p => p + 1)}
            disabled={currentPage * pageSize >= sortedData.length}
            className="px-3 py-1 border border-gray-300 rounded-md hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
\`\`\`

**CRITICAL Requirements:**
1. **Header Layout**: Title on left, Search + Create button on right (TOGETHER)
2. **Actions Column**: MUST have "Actions" column at the end with Edit and Delete icon buttons
3. **Edit Button**: Blue pencil icon (mdi:pencil), opens edit form dialog
4. **Delete Button**: Red trash icon (mdi:delete), shows confirmation dialog then deletes
5. **Stop Propagation**: Action buttons must call \`e.stopPropagation()\` to prevent row click
6. **Search Input**: Has search icon, placeholder "Search...", 256px width
7. **Empty State**: Show nice empty state with icon and message
8. **Pagination**: Show count and prev/next buttons
9. **Defensive**: Always check \`Array.isArray(data)\` before operations

Create **src/components/dynamic/DynamicForm.tsx** - Standard form with Formik
Create **src/components/dynamic/DynamicCard.tsx** - Card layout for entity details
Create **src/components/dynamic/ComponentResolver.tsx** - Resolves spec references to components

## Step 6: Entity Components

Create **src/components/entity/EntityList.tsx** - Uses DynamicTable to show entities

Create **src/components/entity/EntityDetail.tsx** - Detail page with embedded relationship tables:

**CRITICAL - Structure:**
\`\`\`typescript
export function EntityDetail() {
  const { model, entity, id } = useParams();
  const { data: item, loading } = useEntityDetail(model, entity, id);

  // Get child relationships for this entity
  const relationships = getChildRelationships(\`\${model}/\${entity}\`);

  return (
    <div className="space-y-6 p-6">
      {/* Entity Instance Details Card */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">{entity} Details</h2>
        <DynamicCard data={item} spec={getInstanceSpec(\`\${model}/\${entity}\`)} />
      </div>

      {/* Child Relationships - EMBEDDED TABLES */}
      {relationships.map(rel => {
        const childData = useRelationshipData(rel, item.id);
        return (
          <div key={rel.name} className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <h3 className="text-xl font-semibold text-gray-900 mb-4">{rel.displayName}</h3>

            {/* CRITICAL: DynamicTable with Create button */}
            <DynamicTable
              data={childData}  {/* NEVER JSON.stringify! Must be array */}
              spec={getDashboardSpec(rel.child)}
              onRowClick={(child) => navigate(\`/\${rel.child}/\${child.id}\`)}
              onCreateClick={() => openCreateDialog(rel.child)}
              showCreateButton={true}  {/* CRITICAL: Show create button beside search */}
            />
          </div>
        );
      })}
    </div>
  );
}
\`\`\`

**CRITICAL Requirements:**
1. **Entity Details**: Show in card at top with field labels and values
2. **Relationship Tables**: Each relationship shown as DynamicTable (NOT JSON)
3. **Create Button**: MUST appear beside search input in EACH relationship table
   - Position: Top-right, next to search input
   - Label: "Add {RelationshipName}" or "Create"
   - Opens form dialog to create new child record
4. **Click Behavior**: Clicking row navigates to child detail page
5. **Spacing**: Each section in separate white card with border
6. **No Relationships?**: If entity has no relationships, only show details card

## Step 7: Workflows

Create **src/components/workflows/WorkflowDialog.tsx** - Modal dialog for workflow execution:

**CRITICAL - Must read form fields from spec:**
\`\`\`typescript
interface WorkflowDialogProps {
  workflow: WorkflowInfo;  // Has name, displayName, description, icon, inputs
  onClose: () => void;
}

export function WorkflowDialog({ workflow, onClose }: WorkflowDialogProps) {
  const [formData, setFormData] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // CRITICAL: Read input fields from spec["WorkflowName.inputs"]
  const inputFields = workflow.inputs || {};
  const fieldNames = Object.keys(inputFields);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      // Extract model and workflow name
      const [model, workflowName] = workflow.name.split('/');

      // Submit to workflow endpoint
      const useMock = import.meta.env.VITE_USE_MOCK_DATA === 'true';
      const result = useMock
        ? await mockApi.executeWorkflow(model, workflowName, formData)
        : await fetch(\`\${API_URL}/\${model}/\${workflowName}\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(formData)
          }).then(r => r.json());

      if (result.status === 'success') {
        // Show success toast
        toast.success('Workflow executed successfully!');
        onClose();
      } else {
        setError(result.error || 'Workflow execution failed');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex justify-between items-center p-6 border-b">
          <div className="flex items-center gap-3">
            <Icon icon={workflow.icon || 'mdi:lightning-bolt'} className="text-3xl text-blue-600" />
            <div>
              <h2 className="text-2xl font-bold text-gray-900">{workflow.displayName}</h2>
              <p className="text-sm text-gray-600">{workflow.description}</p>
            </div>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <Icon icon="mdi:close" className="text-2xl" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6">
          <div className="space-y-4">
            {fieldNames.map(fieldName => {
              const field = inputFields[fieldName];
              return (
                <div key={fieldName}>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {field.label || fieldName}
                    {field.required && <span className="text-red-600">*</span>}
                  </label>

                  {/* Render input based on field type */}
                  {field.inputType === 'select' || field.dataSource ? (
                    <select
                      required={field.required}
                      value={formData[fieldName] || ''}
                      onChange={(e) => setFormData({ ...formData, [fieldName]: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Select...</option>
                      {/* Options from field.dataSource or field.options */}
                    </select>
                  ) : field.inputType === 'textarea' ? (
                    <textarea
                      required={field.required}
                      value={formData[fieldName] || ''}
                      onChange={(e) => setFormData({ ...formData, [fieldName]: e.target.value })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                      rows={3}
                    />
                  ) : (
                    <input
                      type={field.inputType || 'text'}
                      required={field.required}
                      value={formData[fieldName] || ''}
                      onChange={(e) => setFormData({ ...formData, [fieldName]: e.target.value })}
                      placeholder={field.placeholder}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500"
                    />
                  )}

                  {field.helpText && (
                    <p className="text-xs text-gray-500 mt-1">{field.helpText}</p>
                  )}
                </div>
              );
            })}
          </div>

          {error && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
              {error}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-3 mt-6">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
            >
              {loading && <Icon icon="mdi:loading" className="animate-spin" />}
              Execute
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
\`\`\`

**CRITICAL Requirements:**
1. **Read inputs from spec**: workflow.inputs contains all form fields from spec["\${workflowName}.inputs"]
2. **Dynamic form fields**: Render inputs based on field.inputType (text, select, textarea, number, etc.)
3. **Required fields**: Show red asterisk, enforce with HTML5 required attribute
4. **Field types**:
   - \`inputType: 'text'\` → text input
   - \`inputType: 'select'\` or \`dataSource\` → dropdown select
   - \`inputType: 'textarea'\` → textarea
   - \`inputType: 'number'\` → number input
5. **Submit**: POST to \`/:model/:workflowName\` with form data
6. **Show errors**: Display error message if execution fails
7. **Success**: Show success toast and close dialog
8. **Loading state**: Disable submit button, show spinner while executing

Create **src/components/dashboard/QuickActions.tsx** - Workflow cards for dashboard:
\`\`\`typescript
import { getWorkflows } from '@/utils/workflowParser';
import { uiSpec } from '@/data/uiSpec';
import { Icon } from '@iconify/react';
import { useState } from 'react';
import { WorkflowDialog } from '@/components/workflows/WorkflowDialog';

export function QuickActions() {
  // Get workflows that should show on dashboard
  const workflows = getWorkflows(uiSpec).filter(w => w.ui?.showOnDashboard === true);
  const [selectedWorkflow, setSelectedWorkflow] = useState(null);

  if (workflows.length === 0) {
    return (
      <div className="text-center py-8 text-gray-500">
        <p>No quick actions configured</p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {workflows.map(workflow => (
          <button
            key={workflow.name}
            onClick={() => setSelectedWorkflow(workflow)}
            className="p-6 border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:shadow-md transition-all text-left bg-white"
          >
            <div className="flex items-start gap-4">
              <div className="bg-blue-50 p-3 rounded-lg">
                <Icon icon={workflow.icon || 'mdi:lightning-bolt'} className="text-3xl text-blue-600" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold text-gray-900 mb-1">{workflow.displayName}</h3>
                <p className="text-sm text-gray-600 line-clamp-2">{workflow.description}</p>
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* Workflow Dialog */}
      {selectedWorkflow && (
        <WorkflowDialog
          workflow={selectedWorkflow}
          onClose={() => setSelectedWorkflow(null)}
        />
      )}
    </>
  );
}
\`\`\`

**Requirements:**
- Filter workflows where \`showOnDashboard === true\`
- Grid layout: 3 columns on desktop, 2 on tablet, 1 on mobile
- Each card: Icon + displayName + description
- Click opens WorkflowDialog
- Hover effect: border color change + shadow
- Empty state if no workflows configured

## Step 8: Dashboard Page (CRITICAL - Polished & Deployment-Ready)

Create **src/pages/Dashboard.tsx** - Professional, polished dashboard:
\`\`\`typescript
export function Dashboard() {
  const entities = Object.keys(mockData);

  return (
    <div className="space-y-8 p-6">
      {/* Welcome Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600 mt-1">Welcome back! Here's an overview of your system.</p>
      </div>

      {/* Stat Cards - Show ALL entity counts with icons */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {entities.map(entityKey => {
          const count = Array.isArray(mockData[entityKey]) ? mockData[entityKey].length : 0;
          const entityName = entityKey.split('/')[1];
          return (
            <div key={entityKey} className="bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow p-6 border border-gray-200">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-gray-600">{entityName}</p>
                  <p className="text-3xl font-bold text-gray-900 mt-2">{count}</p>
                  <p className="text-xs text-gray-500 mt-1">Total records</p>
                </div>
                <div className="bg-blue-50 p-3 rounded-lg">
                  <Icon icon="mdi:database" className="text-3xl text-blue-600" />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Workflow Quick Actions Section */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-gray-900">Quick Actions</h2>
          <p className="text-sm text-gray-600 mt-1">Execute workflows directly from the dashboard</p>
        </div>
        <QuickActions />
      </div>

      {/* Recent Activity Section (Optional) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Recent Activity</h3>
          <div className="space-y-3">
            <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
              <Icon icon="mdi:check-circle" className="text-green-600 text-xl" />
              <div>
                <p className="text-sm font-medium text-gray-900">System ready</p>
                <p className="text-xs text-gray-600">All services operational</p>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">System Status</h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">Database</span>
              <span className="text-sm font-medium text-green-600">Connected</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-gray-600">Mock Mode</span>
              <span className="text-sm font-medium text-blue-600">Active</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
\`\`\`

**Dashboard Requirements:**
- **Professional Header**: Welcome message with page title
- **Stat Cards**: Show ALL entities with:
  * Entity count in large, bold text
  * Icon in colored background circle
  * "Total records" label
  * Hover effect with shadow transition
- **Quick Actions Section**:
  * White card with border
  * Section header with description
  * Grid of workflow cards (3-4 per row)
- **Recent Activity/Status**: Optional cards showing system info
- **Spacing**: Generous spacing (32px between sections)
- **Colors**: Professional palette (gray-900 text, blue-600 accents, subtle borders)
- **Polish**: Shadows, borders, hover effects, icons in colored backgrounds

## Step 9: Layout & Navigation

Create **src/components/layout/Sidebar.tsx** - Toggleable sidebar with clear structure:

**Structure (top to bottom):**
1. **App Title/Logo** at top
2. **User Menu** (at top):
   - User avatar/icon (mdi:account-circle)
   - User name from auth context
   - Dropdown menu on click:
     * "Profile" → Opens profile settings dialog
     * "Logout" → Clears auth token, redirects to login
3. **Home Button** - Links to dashboard (\`/\`) with \`mdi:home\` icon
4. **Entities Section**:
   - Section header: "Entities"
   - List ALL entities from spec
   - Each entity: icon + name, links to \`/entity-list/:model/:entity\`
   - When clicked, shows entity list view
   - Clicking an entity instance → shows detail page with relationships
5. **Workflows Section** (separate from entities):
   - Section header: "Workflows"
   - List ALL workflows from spec.workflows
   - **CRITICAL**: Each workflow is a CLICKABLE button that opens WorkflowDialog
   - Each workflow: icon + displayName
   - onClick handler: Opens WorkflowDialog component with workflow data
   - Same workflows as dashboard Quick Actions

**Behavior:**
- **Hamburger toggle** (mdi:menu icon) at top - collapses/expands sidebar
- **State persisted**: Save collapsed state to localStorage
- **Mobile**: Hidden by default on mobile (< 768px), overlay when opened
- **Desktop**: Side-by-side with content, collapsible
- **Animation**: Smooth 200-300ms transition

**Example Structure:**
\`\`\`
┌─────────────────┐
│ App Name        │
│ 👤 John Doe ▾   │ ← User menu (Profile/Logout)
├─────────────────┤
│ 🏠 Home         │ ← Links to dashboard
├─────────────────┤
│ ENTITIES        │
│ 📦 Customers    │
│ 📦 Orders       │
│ 📦 Products     │
├─────────────────┤
│ WORKFLOWS       │
│ ⚡ Create Order │ ← CLICKABLE button, opens WorkflowDialog
│ ⚡ Process Sale │ ← CLICKABLE button, opens WorkflowDialog
└─────────────────┘
\`\`\`

**User Profile Dialog:**
- Modal/dialog that opens when "Profile" clicked
- Shows user info: name, email, role
- Allows editing name
- "Save" and "Cancel" buttons

**Logout:**
- Clear localStorage token
- Clear any auth context state
- Redirect to \`/login\` page

Create **src/components/layout/ChatbotBubble.tsx** - Floating chat with agent selection:

**CRITICAL - Agent Selection Inside Bubble:**
- **Fixed position**: bottom-right corner (20px from right, 20px from bottom)
- **z-index**: 9999 (above all content)
- **Closed state**: Small circular button with chat icon (mdi:message)
- **Opened state**: Expands to chat panel (400px width, 600px height)
- **Agent Dropdown**: INSIDE the chat panel header
  * Dropdown to select agent from spec.agents array
  * Label: "Talk to:" or "Select Agent:"
  * Default to first agent
- **Chat Interface**:
  * Messages area (scrollable)
  * Input field at bottom
  * Send button
  * Backend-powered: POST to \`/agents/:agentName/chat\` with message
- **Close button**: X button in chat panel header

**DO NOT** put agent selection in sidebar - it belongs in the chatbot bubble!

Create **src/components/ErrorBoundary.tsx** - Error boundary component

Create **src/components/auth/Login.tsx** - Modern login page with social auth:

**Layout Structure:**
1. **NO SIDEBAR** on auth pages
2. **Centered card** design (max-width: 400px) with logo/app name at top
3. **Social Sign-In Buttons** (top section):
   - Google button: White background, Google logo, "Continue with Google"
   - GitHub button: Dark background, GitHub logo, "Continue with GitHub"
   - Microsoft button: White background, Microsoft logo, "Continue with Microsoft"
   - Each button full-width, proper brand colors
   - Click shows toast: "Social sign-in coming soon!" (not implemented yet)
4. **Divider**: Horizontal line with "or" text in center
5. **Email/Password Form**:
   - Email input with icon
   - Password input with show/hide toggle
   - "Remember me" checkbox
   - "Forgot password?" link
6. **Sign In Button**: Primary button, full-width
7. **Mock credentials**: Small text below: "Demo: admin@example.com / admin123"
8. **Sign Up Link**: "Don't have an account? Sign up" at bottom

**Code Example:**
\`\`\`tsx
<div className="space-y-4">
  {/* Social Auth Buttons */}
  <button
    onClick={() => toast.info('Google sign-in coming soon!')}
    className="w-full flex items-center justify-center gap-3 px-4 py-3 border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
  >
    <Icon icon="mdi:google" className="text-xl" />
    <span className="font-medium">Continue with Google</span>
  </button>

  <button
    onClick={() => toast.info('GitHub sign-in coming soon!')}
    className="w-full flex items-center justify-center gap-3 px-4 py-3 bg-gray-900 text-white rounded-lg hover:bg-gray-800 transition-colors"
  >
    <Icon icon="mdi:github" className="text-xl" />
    <span className="font-medium">Continue with GitHub</span>
  </button>

  {/* Divider */}
  <div className="relative my-6">
    <div className="absolute inset-0 flex items-center">
      <div className="w-full border-t border-gray-300"></div>
    </div>
    <div className="relative flex justify-center text-sm">
      <span className="px-2 bg-white text-gray-500">or continue with email</span>
    </div>
  </div>

  {/* Email/Password Form */}
  <form onSubmit={handleEmailLogin}>
    {/* Email and password inputs */}
  </form>
</div>
\`\`\`

**CRITICAL Requirements:**
- **Social buttons**: Google (white), GitHub (dark), Microsoft (white) - use \`mdi:google\`, \`mdi:github\`, \`mdi:microsoft\`
- **Click behavior**: Show toast "Coming soon!" - NOT implemented yet
- **Divider**: "or continue with email" between social and email form
- **Email login**: Must call \`mockApi.login(email, password)\` on submit
- **Handle response**: Check \`result.status === 'success'\`, store token, navigate to dashboard
- **Show errors**: Display \`result.error\` if login fails
- **Mock credentials**: Display "Demo: admin@example.com / admin123" below form

Create **src/components/auth/SignUp.tsx** - Modern signup page with social auth:

**Layout Structure:**
1. **Similar design** to Login page
2. **Social Sign-Up Buttons** (same as login):
   - Google, GitHub, Microsoft buttons
   - Click shows toast: "Social sign-up coming soon!"
3. **Divider**: "or sign up with email"
4. **Form fields**: Name, Email, Password, Confirm Password
5. **Terms checkbox**: "I agree to Terms of Service and Privacy Policy"
6. **Sign Up Button**: Primary button, full-width
7. **Login Link**: "Already have an account? Sign in" at bottom

**CRITICAL Requirements:**
- **Social buttons**: Same styling as login page
- **Form validation**: Check password match, email format, terms accepted
- **Email signup**: Must call \`mockApi.signUp(email, password, name)\` on submit
- **Handle response**: Check \`result.status === 'success'\`, store token, navigate to dashboard
- **Show errors**: Display \`result.error\` if signup fails (e.g., "User already exists")

## Step 10: Main App

Create **src/App.tsx**:
- Setup React Router with entity routes
- Include Sidebar, ChatbotBubble in layout
- Wrap with ErrorBoundary in main.tsx

Create **src/main.tsx**:
\`\`\`typescript
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
\`\`\`

Create **src/index.css** - Tailwind imports

# UI POLISH & MINIMALISM GUIDELINES

⚠️ **CRITICAL**: The generated UI must be polished, professional, and deployment-ready.

## Visual Polish

**Clean Modern Aesthetic:**
- **Whitespace**: Generous spacing between sections (24-32px)
- **Borders**: Subtle borders (\`border-gray-200\`) or shadows instead of heavy lines
- **Corners**: Consistent border-radius (\`rounded-lg\` for cards, \`rounded-md\` for buttons/inputs)
- **Shadows**: Subtle shadows for depth
  * Cards: \`shadow\` or \`shadow-sm\`
  * Hover: \`hover:shadow-md\`
  * Modals: \`shadow-xl\`
- **Colors**: Limited, consistent palette
  * Primary: \`bg-blue-500\`, \`text-blue-600\`
  * Success: \`bg-green-500\`, \`text-green-600\`
  * Danger: \`bg-red-500\`, \`text-red-600\`
  * Neutral: \`text-gray-600\`, \`bg-gray-50\`

**Typography:**
- **Font sizes**:
  * h1: \`text-3xl\` (page titles)
  * h2: \`text-xl\` (section titles)
  * h3: \`text-lg\` (card titles)
  * body: \`text-base\` (content)
  * small: \`text-sm\` (meta info)
- **Line height**: Use Tailwind defaults (\`leading-normal\`, \`leading-relaxed\`)
- **Contrast**: Ensure readable text (dark text on light backgrounds)

**Smooth Interactions:**
- **Transitions**: \`transition-all duration-200\` on interactive elements
- **Hover effects**: Background darken, shadow changes
  * Buttons: \`hover:bg-blue-600\`, \`hover:shadow-md\`
  * Table rows: \`hover:bg-gray-50\`
- **Loading states**:
  * Disable buttons + show spinner during submit
  * Skeleton screens for content loading
- **Animations**: Subtle, purposeful (not distracting)

## Minimalism & Clutter Reduction

**NO Unnecessary Elements:**
- **One primary action** per section
- **Don't add features** not in spec (no "Export", "Print", "Share" unless specified)
- **Hide advanced features** in dropdowns/"More" menus
- **Progressive disclosure**: Show simple interface first

**Clean Tables:**
- **Essential columns only**: 4-6 most important columns
- **Icon actions**: Use icon buttons for row actions (edit, delete, view)
- **Bulk actions**: Only show when rows selected
- **Compact filters**: Collapse into "Filters" button if many

**Simple Forms:**
- **Group related fields** visually
- **Single column** layout (easier to scan)
- **Inline validation**: Show errors after field blur
- **Help text**: Use placeholder text or tooltips

## Consistency

**Component Patterns:**
- **Same spacing** everywhere (use \`space-y-4\`, \`gap-4\`, \`p-6\` consistently)
- **Same colors**: Stick to the palette above
- **Same patterns**: If one table has search at top-right, ALL tables should

**Icon Usage:**
- **Consistent icon set**: ONLY Material Design Icons via \`@iconify/react\`
- **Consistent sizes**: \`text-xl\` for buttons, \`text-2xl\` for features, \`text-base\` inline
- **Standard icons**:
  * Create: \`mdi:plus\`
  * Edit: \`mdi:pencil\`
  * Delete: \`mdi:delete\`
  * Search: \`mdi:magnify\`
  * Filter: \`mdi:filter-variant\`
  * Menu: \`mdi:menu\`
  * Close: \`mdi:close\`
  * Check: \`mdi:check\`
  * Alert: \`mdi:alert-circle\`

## Mobile Responsiveness

**Responsive Patterns:**
- **Tables**: Use responsive grid classes (\`grid-cols-1 md:grid-cols-2 lg:grid-cols-4\`)
- **Sidebars**: Overlay on mobile (\`< 768px\`), side-by-side on desktop
- **Forms**: Full-width inputs on mobile
- **Touch targets**: Min 44px height for buttons (\`py-2\` or \`py-3\`)

## Component-Specific Polish

**Buttons:**
- ✅ Hover states: \`hover:bg-blue-600\`, \`hover:shadow-md\`
- ✅ Disabled state: \`disabled:opacity-50\`, \`disabled:cursor-not-allowed\`
- ✅ Loading state: Show spinner + disable

**Inputs:**
- ✅ Focus state: \`focus:ring-2\`, \`focus:ring-blue-500\`, \`focus:border-blue-500\`
- ✅ Error state: \`border-red-500\`, error message below
- ✅ Disabled state: \`bg-gray-100\`, \`cursor-not-allowed\`

**Tables:**
- ✅ Hover rows: \`hover:bg-gray-50\`
- ✅ Clickable rows: \`cursor-pointer\`
- ✅ Empty state: "No data available" message
- ✅ Loading: Skeleton or spinner

**Modals:**
- ✅ Smooth fade-in: \`transition-opacity\`
- ✅ Backdrop: \`bg-black bg-opacity-50\`
- ✅ Click outside to close
- ✅ Escape key to close

**Remember:**
- **Quality over quantity**: Better to have fewer, well-polished features
- **Minimalism**: When in doubt, leave it out
- **Consistency**: Every page should feel like part of the same app
- **Professional**: Should look like a commercial SaaS product

# PHASE 2: VERIFY & FIX

After generating ALL files above:

1. Run \`npm install\`

2. Run \`tsc --noEmit\`
   - Fix any TypeScript errors
   - Common fixes: add missing imports, fix type annotations

3. Run \`npm run build\`
   - Fix any build errors
   - Common fixes: resolve import paths, add missing dependencies

4. Check for common issues:
   - **"not iterable" errors?** → Add \`Array.isArray()\` checks in DynamicTable
   - **Relationship tables showing JSON?** → Ensure EntityDetail uses DynamicTable component
   - **Missing search in tables?** → Verify DynamicTable has search input + create button together
   - **Missing mock data?** → Add all entities to mockData.ts
   - **TypeScript errors?** → Fix type annotations and imports

5. Fix all issues found, then run \`npm run build\` again

6. **DO NOT run \`npm run dev\`** - Only verify build succeeds

# CRITICAL RULES - READ BEFORE STARTING

## Navigation & Layout
1. **Sidebar Structure**:
   - User menu at top (avatar + name + dropdown with Profile/Logout)
   - Home button (links to dashboard)
   - Entities section (only entities, NOT workflows)
   - **Workflows section (CLICKABLE buttons that open WorkflowDialog)**
   - Toggleable with localStorage persistence
2. **Dashboard**: Stat cards + Quick Actions (workflows) + status cards
3. **Entity Detail**: Show details card + embedded relationship tables (NOT JSON)
4. **Chatbot**: Agent selection dropdown INSIDE chatbot panel, not in sidebar

## Tables & Data
5. **All tables MUST have**:
   - Search input + Create button (TOGETHER on right)
   - **Actions column with Edit and Delete icon buttons for EACH row**
   - Pagination
6. **Table Actions**:
   - Edit button: Blue pencil icon, opens edit form
   - Delete button: Red trash icon, shows confirmation then deletes
   - Use \`e.stopPropagation()\` on action buttons to prevent row click
7. **Relationship tables**: MUST have Create button beside search in each table
8. **Never use JSON.stringify**: Always render relationships as DynamicTable
9. **Always validate arrays**: \`Array.isArray(data) ? data : []\` before operations
10. **Mock data**: Create 3-5 realistic records for ALL entities

## Workflows
11. **Sidebar workflows**: MUST be CLICKABLE buttons that open WorkflowDialog
12. **WorkflowDialog MUST read**: \`workflow.inputs\` from spec["\${workflowName}.inputs"]
13. **Dynamic form fields**: Render inputs based on \`inputType\` (text, select, textarea, number)
14. **Submit workflow**: POST to \`/:model/:workflowName\` with form data

## User Management
15. **User menu**: Show in sidebar at top with avatar, name, dropdown
16. **Logout**: Clear localStorage token, redirect to /login
17. **Profile**: Opens dialog to edit user name, email (read-only), role (read-only)

## Authentication
18. **Social auth buttons**: Show Google, GitHub, Microsoft buttons (UI only, not functional yet)
19. **Social button click**: Show toast "Coming soon!" - functionality to be added later
20. **Email login/signup MUST call**: \`mockApi.login()\` and \`mockApi.signUp()\`
21. **Show mock credentials**: Display "Demo: admin@example.com / admin123" on login page
22. **Handle responses**: Check \`result.status === 'success'\`, show errors
23. **Divider**: "or continue with email" between social buttons and email form

## Styling & Polish
24. **Tailwind only**: No inline styles, no CSS-in-JS
25. **Professional polish**: Borders, shadows, hover effects, spacing (24-32px)
26. **Consistent colors**: Blue-600 primary, gray-900 text, gray-50 backgrounds
27. **Icons**: Only Material Design Icons (mdi:*) via @iconify/react

## Build Requirements
28. **Build must succeed**: Fix all errors until \`npm run build\` passes
29. **NO dev server**: Only verify with \`tsc --noEmit\` and \`npm run build\`
30. **Workflows from spec**: Read from spec.workflows array, access metadata with spec[workflowName]

START NOW! Generate all files, then verify and fix any issues.`;
}
