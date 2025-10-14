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
Generate a complete, working React admin UI with:
- Entity CRUD pages
- Relationship tables (child entities shown in tables, NOT JSON)
- Workflow execution dialogs
- Dashboard with quick actions
- Mock data for all entities

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

Create **src/components/dynamic/DynamicTable.tsx**:
\`\`\`typescript
export function DynamicTable({ data, spec, onRowClick, onCreateClick }: Props) {
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
    return <div>No data available</div>;
  }

  return (
    <div className="bg-white rounded-lg shadow">
      {/* Header with search + create together */}
      <div className="flex justify-between items-center p-4 border-b">
        <h2 className="text-xl font-semibold">{spec.title}</h2>
        <div className="flex gap-3">
          <input
            type="text"
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="px-3 py-2 border rounded-lg w-64"
          />
          <button
            onClick={onCreateClick}
            className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
          >
            Create
          </button>
        </div>
      </div>

      {/* Table */}
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            {spec.columns.map(col => (
              <th key={col.key} className="px-4 py-3 text-left text-sm font-semibold">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {paginatedData.map((row, idx) => (
            <tr key={row.id || idx} onClick={() => onRowClick(row)} className="hover:bg-gray-50 cursor-pointer">
              {spec.columns.map(col => (
                <td key={col.key} className="px-4 py-3">
                  {row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Pagination */}
      <div className="flex justify-between items-center p-4 border-t">
        <div>Showing {Math.min((currentPage - 1) * pageSize + 1, sortedData.length)}-{Math.min(currentPage * pageSize, sortedData.length)} of {sortedData.length}</div>
        <div className="flex gap-2">
          <button onClick={() => setCurrentPage(p => Math.max(1, p - 1))} disabled={currentPage === 1}>Prev</button>
          <button onClick={() => setCurrentPage(p => p + 1)} disabled={currentPage * pageSize >= sortedData.length}>Next</button>
        </div>
      </div>
    </div>
  );
}
\`\`\`

Create **src/components/dynamic/DynamicForm.tsx** - Standard form with Formik
Create **src/components/dynamic/DynamicCard.tsx** - Card layout for entity details
Create **src/components/dynamic/ComponentResolver.tsx** - Resolves spec references to components

## Step 6: Entity Components

Create **src/components/entity/EntityList.tsx** - Uses DynamicTable to show entities

Create **src/components/entity/EntityDetail.tsx**:
\`\`\`typescript
export function EntityDetail() {
  const { model, entity, id } = useParams();
  const { data: item, loading } = useEntityDetail(model, entity, id);

  // Get child relationships
  const relationships = getChildRelationships(\`\${model}/\${entity}\`);

  return (
    <div>
      {/* Entity instance details */}
      <DynamicCard data={item} spec={getInstanceSpec(\`\${model}/\${entity}\`)} />

      {/* Child relationships - RENDER AS TABLES */}
      {relationships.map(rel => {
        const childData = useRelationshipData(rel, item.id);
        return (
          <div key={rel.name} className="mt-6">
            <h3 className="text-lg font-semibold mb-3">{rel.displayName}</h3>
            <DynamicTable
              data={childData}  {/* NOT JSON.stringify! */}
              spec={getDashboardSpec(rel.child)}
              onRowClick={(child) => navigate(\`/\${rel.child}/\${child.id}\`)}
              onCreateClick={() => openCreateDialog(rel.child)}
            />
          </div>
        );
      })}
    </div>
  );
}
\`\`\`

## Step 7: Workflows

Create **src/components/workflows/WorkflowDialog.tsx**:
- Read inputs from spec[\`\${workflowName}.inputs\`]
- Build dynamic form
- Submit to POST /:model/:workflow endpoint

Create **src/components/dashboard/QuickActions.tsx**:
\`\`\`typescript
export function QuickActions() {
  const workflows = getWorkflows(uiSpec).filter(w => w.ui.showOnDashboard);

  return (
    <div className="grid grid-cols-3 gap-4">
      {workflows.map(workflow => (
        <button
          key={workflow.name}
          onClick={() => openWorkflowDialog(workflow)}
          className="p-4 border rounded-lg hover:border-blue-500"
        >
          <Icon icon={workflow.icon} className="text-2xl mb-2" />
          <h3 className="font-semibold">{workflow.displayName}</h3>
          <p className="text-sm text-gray-600">{workflow.description}</p>
        </button>
      ))}
    </div>
  );
}
\`\`\`

## Step 8: Dashboard Page (CRITICAL - Polished & Feature-Rich)

Create **src/pages/Dashboard.tsx** - Modern, polished dashboard:
\`\`\`typescript
export function Dashboard() {
  const entities = Object.keys(mockData);

  return (
    <div className="space-y-6">
      {/* Stat Cards - Show key entity counts */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {entities.slice(0, 4).map(entityKey => {
          const count = Array.isArray(mockData[entityKey]) ? mockData[entityKey].length : 0;
          const entityName = entityKey.split('/')[1];
          return (
            <div key={entityKey} className="bg-white rounded-lg shadow p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-gray-600">{entityName}</p>
                  <p className="text-3xl font-semibold mt-1">{count}</p>
                </div>
                <Icon icon="mdi:database" className="text-3xl text-blue-500" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Workflow Quick Actions */}
      <QuickActions />

      {/* Recent Activity or Charts (Optional) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold mb-4">Activity Overview</h3>
          {/* Add Recharts bar/line chart here if time permits */}
          <p className="text-gray-600">Recent activity will appear here</p>
        </div>
      </div>
    </div>
  );
}
\`\`\`

**Dashboard Requirements:**
- **Stat Cards**: Show total counts for top 4-6 entities with icons
- **Workflow Quick Actions**: Grid of workflow cards (from QuickActions component)
- **Charts** (if spec has data): Use Recharts for bar/line charts showing trends
- **Clean Layout**: Card-based design with generous spacing (24-32px between sections)
- **Icons**: Use @iconify/react with Material Design Icons (mdi:*)

## Step 9: Layout & Auth

Create **src/components/layout/Sidebar.tsx** - Toggleable sidebar:
- **Hamburger toggle button** (mdi:menu icon) in top-left
- **Collapsible**: Click to collapse/expand, save state to localStorage
- **Mobile responsive**: Overlay on mobile (< 768px), push content on desktop
- **Smooth animation**: 200-300ms transition
- **Navigation links**: Home/Dashboard + all entities + workflows section

Create **src/components/layout/ChatbotBubble.tsx** - Floating chat bubble:
- **Fixed position**: bottom-right corner (20px from edges)
- **z-index**: Above all content
- **Click to open**: Expand to chat interface
- **Backend-powered**: Use \`/agents/:agentName/chat\` endpoint (backend handles LLM)

Create **src/components/ErrorBoundary.tsx** - Error boundary component

Create **src/components/auth/Login.tsx** - Modern login page:
- **NO SIDEBAR** on auth pages
- **Centered card** design with logo at top
- **Clean form**: Email + password inputs with proper validation
- **Link to Sign Up** page at bottom
- **Forgot password** link
- **Mock credentials shown**: Display "Use admin@example.com / admin123" in subtle text below form
- **Loading state**: Show spinner on submit button during login
- **CRITICAL**: Must call \`mockApi.login(email, password)\` on submit
- **Handle response**: Check \`result.status === 'success'\`, store token, navigate to dashboard
- **Show errors**: Display \`result.error\` if login fails

Create **src/components/auth/SignUp.tsx** - Modern signup page:
- **Similar design** to Login page
- **Form fields**: Name, Email, Password, Confirm Password
- **Link to Login** at bottom
- **Validation**: Check password match, email format
- **CRITICAL**: Must call \`mockApi.signUp(email, password, name)\` on submit
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

# CRITICAL RULES

1. **Use Tailwind exclusively** - No inline styles, no CSS-in-JS
2. **All tables must have**: search input + create button (together on right), pagination
3. **Relationships must be tables**, never JSON dumps or stringified objects
4. **Always validate arrays**: \`Array.isArray(data) ? data : []\` before spreading/mapping
5. **Mock data required**: Create realistic sample data for ALL entities
6. **Workflows from spec**: Read from spec.workflows array, access with spec[workflowName]
7. **Build must succeed**: Fix all errors until \`npm run build\` passes

START NOW! Generate all files, then verify and fix any issues.`;
}
