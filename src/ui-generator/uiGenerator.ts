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

# ⚠️ TOP CRITICAL PRIORITIES (READ FIRST - PREVENTS BROKEN LAYOUTS)

## 1. USE TAILWIND CSS FOR ALL STYLING
- **REQUIRED**: Use Tailwind utility classes for ALL styling
- **NO**: inline styles, CSS-in-JS, separate CSS files for components
- **WHY**: Prevents layout conflicts, ensures consistency, faster generation
- Install: \`tailwindcss\`, \`postcss\`, \`autoprefixer\`
- Configure: tailwind.config.js, postcss.config.js
- Import in index.css: \`@tailwind base; @tailwind components; @tailwind utilities;\`

## 2. LAYOUT STRUCTURE (USE THESE EXACT PATTERNS)

### Main App Layout:
\`\`\`tsx
<div className="flex h-screen bg-gray-50">
  {/* Sidebar */}
  <aside className={\`transition-all duration-300 \${sidebarOpen ? 'w-64' : 'w-0'} bg-white border-r\`}>
    <Sidebar />
  </aside>

  {/* Main Content */}
  <div className="flex-1 flex flex-col overflow-hidden">
    {/* Top Navbar */}
    <header className="h-16 bg-white border-b flex items-center px-6">
      <Navbar />
    </header>

    {/* Page Content */}
    <main className="flex-1 overflow-y-auto p-6">
      <Routes />
    </main>
  </div>

  {/* Chatbot Bubble - Fixed Position */}
  <ChatbotBubble />
</div>
\`\`\`

### Table Layout (STANDARD REUSABLE PATTERN - USE EVERYWHERE):
⚠️ **CRITICAL**: This is the ONLY table pattern. Use it for:
- Entity list pages
- Relationship tables (child entities in detail views)
- Any data table in the application

\`\`\`tsx
<div className="bg-white rounded-lg shadow">
  {/* Header - Title LEFT, Search + Create RIGHT (TOGETHER) */}
  <div className="flex justify-between items-center p-4 border-b">
    <h2 className="text-xl font-semibold">Entity List</h2>

    {/* Search and Create - ALWAYS TOGETHER on right side */}
    <div className="flex items-center gap-3">
      <input
        type="text"
        placeholder="Search..."
        value={searchTerm}
        onChange={(e) => setSearchTerm(e.target.value)}
        className="w-64 px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
      />
      <button
        onClick={() => handleCreate()}
        className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 flex items-center gap-2"
      >
        <Icon icon="mdi:plus" /> Create
      </button>
    </div>
  </div>

  {/* Table - Full width, responsive */}
  <div className="overflow-x-auto">
    <table className="w-full">
      <thead className="bg-gray-50">
        <tr>
          <th className="px-4 py-3 text-left text-sm font-medium text-gray-700">
            Column Name
          </th>
        </tr>
      </thead>
      <tbody className="divide-y">
        {filteredData.map((item) => (
          <tr key={item.id} className="hover:bg-gray-50 cursor-pointer">
            <td className="px-4 py-3 text-sm">{item.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>

  {/* Pagination - ALWAYS at bottom right */}
  <div className="flex justify-between items-center p-4 border-t">
    <span className="text-sm text-gray-600">
      Showing {startIndex + 1}-{endIndex} of {total}
    </span>
    <div className="flex items-center gap-2">
      <select
        value={pageSize}
        onChange={(e) => setPageSize(Number(e.target.value))}
        className="px-2 py-1 border rounded text-sm"
      >
        <option value="10">10</option>
        <option value="25">25</option>
        <option value="50">50</option>
        <option value="100">100</option>
      </select>
      <button
        onClick={() => setPage(page - 1)}
        disabled={page === 1}
        className="px-3 py-1 border rounded disabled:opacity-50"
      >
        Previous
      </button>
      <span className="text-sm">{page} / {totalPages}</span>
      <button
        onClick={() => setPage(page + 1)}
        disabled={page === totalPages}
        className="px-3 py-1 border rounded disabled:opacity-50"
      >
        Next
      </button>
    </div>
  </div>
</div>
\`\`\`

⚠️ **CRITICAL RULES FOR TABLES**:
1. Search and Create button MUST be together on the right side
2. NO create button above the table component
3. Pagination MUST be at the bottom with page size selector
4. Use this EXACT pattern for entity lists AND relationship tables
5. Don't put search inside table, keep it in header section

⚠️ **CRITICAL: RELATIONSHIP TABLES (Child Entities in Detail Views)**:
**PROBLEM**: Relationship tables often show raw JSON instead of formatted tables
**SOLUTION**:
- In EntityDetail, when rendering child entities (relationships), use DynamicTable component
- **NEVER** use JSON.stringify() or JSON.parse() to display relationship data
- **NEVER** show raw object notation like \`{id: 1, name: "test"}\`
- **ALWAYS** render child entity data using the SAME table pattern above
- RelationshipSection component MUST call DynamicTable with child entity data
- Example:
\`\`\`tsx
// ❌ WRONG - Don't do this:
<pre>{JSON.stringify(childEntities)}</pre>
<div>{childEntities.map(e => <p>{e.toString()}</p>)}</div>

// ✅ CORRECT - Do this:
<DynamicTable
  data={childEntities}
  spec={childDashboardSpec}
  title={relationship.displayName}
/>
\`\`\`

### Card Layout:
\`\`\`tsx
<div className="bg-white rounded-lg shadow p-6">
  <h3 className="text-lg font-semibold mb-4">Entity Details</h3>

  {/* Fields Grid */}
  <div className="grid grid-cols-2 gap-4 mb-6">
    <div>
      <label className="text-sm font-medium text-gray-600">Label</label>
      <p className="text-base">Value</p>
    </div>
  </div>

  {/* Actions - RIGHT ALIGNED */}
  <div className="flex justify-end gap-3 pt-4 border-t">
    <button className="px-4 py-2 border rounded-lg hover:bg-gray-50">Cancel</button>
    <button className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600">Save</button>
  </div>
</div>
\`\`\`

### Form Layout:
\`\`\`tsx
<form className="max-w-2xl mx-auto bg-white rounded-lg shadow p-6">
  {/* Field */}
  <div className="mb-4">
    <label className="block text-sm font-medium mb-1">
      Field Name <span className="text-red-500">*</span>
    </label>
    <input
      type="text"
      className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500"
    />
  </div>

  {/* Actions - RIGHT ALIGNED */}
  <div className="flex justify-end gap-3 pt-4 border-t mt-6">
    <button type="button" className="px-4 py-2 border rounded-lg">Cancel</button>
    <button type="submit" className="px-4 py-2 bg-blue-500 text-white rounded-lg">Submit</button>
  </div>
</form>
\`\`\`

## 3. COMMON MISTAKES TO AVOID (CAUSES BROKEN LAYOUTS)

❌ **DON'T**:
- Use \`display: flex\` without \`flex-direction\` - causes unexpected layouts
- Mix Tailwind with inline styles - creates conflicts
- Forget responsive classes (\`md:\`, \`lg:\`) - breaks on mobile
- Use fixed widths without \`max-w-\` - causes overflow
- Nest too many flex containers - causes sizing issues
- Forget \`overflow-auto\` on scrollable areas - causes layout breaks
- Use absolute positioning without \`relative\` parent - breaks layout
- Create deep component nesting (>5 levels) - hard to debug

✅ **DO**:
- Use Tailwind utilities consistently
- Add responsive classes for mobile/tablet/desktop
- Use \`flex-1\` for flexible sizing
- Add \`overflow-auto\` or \`overflow-hidden\` to prevent breaks
- Test layouts work without JavaScript enabled
- Keep component hierarchy shallow (3-4 levels max)
- Use semantic HTML (\`<main>\`, \`<aside>\`, \`<nav>\`)

## 4. VERIFICATION CHECKLIST (TEST AFTER GENERATION)

Before considering generation complete, verify:
- [ ] All pages render without console errors
- [ ] Sidebar toggles smoothly (no layout shifts)
- [ ] Tables have search, pagination, sorting
- [ ] Buttons are right-aligned on cards/forms
- [ ] Mobile view works (test at 375px width)
- [ ] No horizontal scrollbars (except tables with overflow-x-auto)
- [ ] All forms validate and submit
- [ ] ChatbotBubble appears on all pages
- [ ] \`npm run build\` succeeds
- [ ] \`npm run dev\` starts without errors

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
- **Tailwind CSS** for styling (REQUIRED - use utility classes, NOT inline styles or CSS-in-JS)
- **Iconify React** (@iconify/react) for icons (mdi icons from spec)
- **Formik** for form handling
- **Recharts** for data visualization
- **date-fns** for date operations
- **Axios** for HTTP requests

## CSS/STYLING REQUIREMENTS (CRITICAL - PREVENTS BROKEN LAYOUTS):

⚠️ **USE TAILWIND CSS EXCLUSIVELY** - Do NOT use:
- Plain CSS files for component styles
- CSS-in-JS (styled-components, emotion)
- Inline style objects
- CSS modules

**Why Tailwind**: Consistent, predictable, no layout conflicts, faster generation

**Setup**:
1. Install Tailwind: Add \`tailwindcss\`, \`postcss\`, \`autoprefixer\` to devDependencies
2. Create \`tailwind.config.js\` with content paths
3. Create \`postcss.config.js\`
4. In \`src/index.css\`, include Tailwind directives:
   \`\`\`css
   @tailwind base;
   @tailwind components;
   @tailwind utilities;
   \`\`\`

**Usage Pattern**:
\`\`\`tsx
// ✅ CORRECT - Use Tailwind utility classes
<div className="flex justify-between items-center p-4 bg-white rounded-lg shadow">
  <h2 className="text-xl font-semibold">Title</h2>
  <button className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600">
    Action
  </button>
</div>

// ❌ WRONG - Don't use inline styles
<div style={{display: 'flex', justifyContent: 'space-between'}}>

// ❌ WRONG - Don't use CSS-in-JS
const StyledDiv = styled.div\`
  display: flex;
\`;
\`\`\`

# UI LAYOUT BEST PRACTICES (CRITICAL - ALWAYS FOLLOW)

⚠️ **IMPORTANT SCOPE**: The following layout rules apply specifically to:
- Entity list/table pages
- Entity detail/card pages
- Entity forms
- Workflow dialogs
- Admin/management interfaces

**EXEMPT FROM THESE RULES** (use industry-standard designs instead):
- **Sign-in/Sign-up/Auth pages** - Use modern, centered auth layouts (like Auth0, Firebase, Clerk)
- **Landing pages** - Use marketing/product page layouts
- **Public pages** - Use appropriate public-facing layouts

## SPECIAL REQUIREMENTS FOR NON-ENTITY PAGES:

### Authentication Pages (Sign-in, Sign-up, Forgot Password)
- **Layout**: Centered card design, full-screen centered OR split-screen with branding
- **Style**: Modern, clean, professional (reference: Vercel, GitHub, Linear auth pages)
- **Features**:
  * Logo at top
  * Clean form with generous white space
  * Social login buttons (if applicable)
  * Link to alternate auth page (Sign in ↔ Sign up)
  * Forgot password link
  * Beautiful gradient or image background (optional)
  * Form validation with inline error messages
  * Loading states during submission
- **NO SIDEBAR** on auth pages
- **NO TABLE LAYOUT RULES** - these are standalone pages

### Dashboard/Home Page
- **Toggleable Sidebar**: Sidebar must be collapsible/expandable with toggle button
  * Use hamburger icon (mdi:menu) for toggle
  * Maintain toggle state in localStorage
  * Smooth animation (200-300ms) for slide in/out
  * On mobile (< 768px): Sidebar should be hidden by default, overlay when opened
- **Dashboard Content**: Show informative, actionable content
  * Summary statistics (stat cards with icons, numbers, trends)
  * Recent activity widgets
  * **Workflow Quick Actions Section** (CRITICAL - NEW COMPONENT):
    - Create \`src/components/dashboard/QuickActions.tsx\`
    - **IMPORTANT**: Read workflows from spec.workflows array and corresponding spec metadata
    - Shows workflows where spec["\${workflowName}.ui"].showOnDashboard === true
    - Shows in a grid (3-4 per row)
    - Each workflow card:
      * Icon (from spec["\${workflowName}.ui"].icon or spec[workflowName].icon)
      * Display name (from spec[workflowName].displayName)
      * Description (from spec[workflowName].description)
      * Click to open WorkflowDialog with form (inputs from spec["\${workflowName}.inputs"])
    - After submission: success toast + refresh data
    - Template:
    \`\`\`tsx
    import { getWorkflows } from '@/utils/workflowParser';
    import { uiSpec } from '@/data/uiSpec';

    const QuickActions = () => {
      // getWorkflows reads from spec.workflows array
      const workflows = getWorkflows(uiSpec)
        .filter(w => w.ui.showOnDashboard); // Only show if showOnDashboard is true

      return (
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-xl font-semibold mb-4">Quick Actions</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {workflows.map((workflow) => (
              <button
                key={workflow.name}
                onClick={() => openWorkflowDialog(workflow)}
                className="p-4 border rounded-lg hover:border-blue-500 hover:bg-blue-50 text-left transition"
              >
                <Icon icon={workflow.icon} className="text-2xl mb-2 text-blue-500" />
                <h3 className="font-semibold">{workflow.displayName}</h3>
                <p className="text-sm text-gray-600 mt-1">{workflow.description}</p>
              </button>
            ))}
          </div>
        </div>
      );
    };
    \`\`\`
  * Charts and visualizations (use Recharts)
  * Helpful links/shortcuts
- **Professional Polish**: Use card layouts, proper spacing, visual hierarchy

### Chatbot Bubble Component (CRITICAL - ALWAYS INCLUDE)
⚠️ **REQUIRED**: Every page must have access to the chatbot bubble component

**Implementation Requirements:**
- **Component**: Create \`src/components/agents/ChatbotBubble.tsx\` as a reusable, standalone component
- **Position**: Fixed position, bottom-right corner (20px from bottom, 20px from right)
- **Style**: Floating circular button (60px diameter) with agent icon or chat icon (mdi:message-text or mdi:robot)
  * Primary brand color background
  * White icon
  * Shadow: \`box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15)\`
  * Hover effect: Slight scale up (transform: scale(1.1))
  * Pulse animation on first load to draw attention
- **Behavior**:
  * Click to open chat interface (see below)
  * Badge showing unread message count (if applicable)
  * Smooth slide-in animation from bottom-right on page load
- **Chat Interface** (opens when bubble clicked):
  * **Position**: Bottom-right, fixed, overlaying content
  * **Size**: 400px wide × 600px tall (on desktop), full-screen on mobile
  * **Style**: Card with shadow, rounded corners
  * **Header**:
    - Agent selector dropdown (if multiple agents available)
    - Currently selected agent name and avatar
    - Close button (×) to minimize back to bubble
  * **Chat Area**:
    - Messages list (scrollable, newest at bottom)
    - User messages: right-aligned, blue background
    - Agent messages: left-aligned, gray background
    - Typing indicator when agent is responding
    - Auto-scroll to latest message
  * **Input Area**:
    - Text input with placeholder "Type your message..."
    - Send button (or Enter to send)
    - File upload button (if supported)
  * **Agent Selection**: If multiple agents exist:
    - Show dropdown or tabs at top to switch between agents
    - Each agent has own conversation history
    - Visual indication of which agent is active
- **Messenger-Style Design**: Follow modern chat UI patterns (like Facebook Messenger, WhatsApp Web, Intercom, Drift)
  * Clean, minimal design
  * Message bubbles with timestamps
  * Avatar images for agent (bot icon)
  * Smooth animations for new messages
  * Typing indicator dots
- **Template/Reusable**: Design as a completely reusable component
  * Can be included in App.tsx layout to show on ALL pages
  * Maintains chat state across page navigation
  * Uses useAgentChat hook for all agent communication

**Integration:**
\`\`\`tsx
// In src/App.tsx layout
<div className="app-layout">
  {/* Main content, sidebar, etc. */}
  <Routes>...</Routes>

  {/* Chatbot bubble - available on all pages */}
  <ChatbotBubble />
</div>
\`\`\`

## 1. BUTTON PLACEMENT & STYLING

### Card Layouts - Action Buttons
When buttons appear on card components:
- **ALWAYS align buttons to the RIGHT** at the bottom of the card
- Use flexbox with \`justify-content: flex-end\`
- Maintain consistent spacing: \`gap: 0.75rem\` (12px) between buttons
- Position buttons in a horizontal row using \`flex-direction: row\`
- Add top margin/padding: \`mt-4\` or \`padding-top: 1rem\` to separate from content

**Example CSS Pattern:**
\`\`\`css
.card-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1rem;
  padding-top: 1rem;
  border-top: 1px solid #e5e7eb; /* Optional separator */
}
\`\`\`

### Form Buttons
- Submit/Save buttons: RIGHT aligned, primary style
- Cancel/Back buttons: positioned LEFT of submit button
- Destructive actions (Delete): use danger/red styling, positioned separately or with confirmation
- Button order (left to right): Secondary/Cancel → Primary/Submit

### List/Table Header Buttons
- **ONLY ONE Create/Add button**: Show a single primary "Create" or "Add {Entity}" button - NO other buttons
- Position: RIGHT aligned in header section (beside the search filter)
- NO multiple action buttons in table header - keep it minimal and clean
- Bulk action buttons: Only show when rows are selected, position in a context toolbar

## 2. TABLE REQUIREMENTS (MANDATORY)

⚠️ **EVERY TABLE MUST HAVE**:

### Global Search/Filter (REQUIRED)
- **Position**: Top-right of table header, above the table grid
- **Placeholder**: "Search..." or "Filter {entity}..."
- **Functionality**: Filter across ALL visible columns in real-time
- **Styling**: Input with search icon, min-width: 250px
- **Debouncing**: 300ms delay for performance

**Implementation Pattern:**
\`\`\`tsx
<div className="table-header">
  <div className="table-title">
    <h2>Entity List</h2>
  </div>
  <div className="table-actions">
    {/* Search filter */}
    <input
      type="text"
      placeholder="Search..."
      className="global-filter"
      onChange={(e) => setGlobalFilter(e.target.value)}
    />
    {/* ONLY ONE create button - no other action buttons here */}
    <button className="btn-create btn-primary">
      <Icon icon="mdi:plus" /> Create
    </button>
  </div>
</div>
\`\`\`

⚠️ **CRITICAL**: Table headers should have ONLY ONE create/add button. Do not add extra action buttons, export buttons, or other controls. Keep it minimal and clean.

### Column Filters (RECOMMENDED)
- Add filter inputs in column headers for filterable columns
- Use appropriate input types: text, select, date range
- Clear filter button when filter is active

### Pagination (REQUIRED for >25 rows)
- **Position**: Bottom-right of table
- **Controls**: First, Prev, Page Numbers, Next, Last
- **Page Size Selector**: 10, 25, 50, 100 options (default: 25)
- **Info Display**: "Showing X-Y of Z entries"

### Sorting (REQUIRED)
- Clickable column headers with sort indicators (↑↓)
- Multi-column sorting support (hold Shift)
- Default sort: Usually by name or created date

### Row Selection (RECOMMENDED)
- Checkbox in first column for multi-select
- Select All checkbox in header
- Show selected count and bulk actions when rows selected

## 3. CARD LAYOUTS & STRUCTURE

### Summary Cards (Entity Details)
\`\`\`
┌─────────────────────────────────────┐
│ Card Header (Title, Icon)           │
│─────────────────────────────────────│
│ Field Grid (2-3 columns)            │
│   Label: Value  Label: Value        │
│   Label: Value  Label: Value        │
│─────────────────────────────────────│
│           [Cancel]  [Edit] [Delete] │ ← RIGHT ALIGNED
└─────────────────────────────────────┘
\`\`\`

**CSS Guidelines:**
- **Grid Layout**: \`grid-template-columns: repeat(auto-fit, minmax(200px, 1fr))\`
- **Field Spacing**: \`gap: 1rem\` for grid items
- **Label Style**: Bold, smaller font, muted color
- **Value Style**: Regular weight, primary color
- **Card Padding**: \`padding: 1.5rem\`
- **Card Border**: \`border: 1px solid #e5e7eb\`, \`border-radius: 0.5rem\`

### Dashboard Stat Cards
- **Layout**: Horizontal flex or grid (typically 4 per row)
- **Content Order**: Icon/Visual → Stat Number → Label → Trend/Change
- **Spacing**: \`gap: 1.5rem\` between cards
- **Responsive**: Stack on mobile (< 768px)

## 4. FORM LAYOUTS

### Field Structure
- **Label Position**: Above input (vertical layout)
- **Required Indicator**: Red asterisk (*) after label
- **Input Width**: Full width of container, \`max-width: 500px\` for long forms
- **Spacing**: \`margin-bottom: 1.25rem\` between fields
- **Error Messages**: Below input, red color, small font

### Form Actions (Submit Bar)
\`\`\`
┌─────────────────────────────────────┐
│ Form Fields...                      │
│                                     │
│─────────────────────────────────────│
│                    [Cancel] [Submit]│ ← RIGHT ALIGNED
└─────────────────────────────────────┘
\`\`\`

- **Position**: Bottom of form, sticky on scroll for long forms
- **Alignment**: RIGHT for submit, with cancel to its left
- **Spacing**: \`gap: 0.75rem\`, \`padding: 1rem\`
- **Separator**: \`border-top: 1px solid #e5e7eb\`

## 5. SPACING & VISUAL HIERARCHY

### Consistent Spacing Scale
Use Tailwind spacing or equivalent:
- **xs**: 0.25rem (4px) - Tight spacing, inline elements
- **sm**: 0.5rem (8px) - Small gaps
- **base**: 0.75rem (12px) - Standard button/tag spacing
- **md**: 1rem (16px) - Standard padding/margin
- **lg**: 1.5rem (24px) - Section spacing
- **xl**: 2rem (32px) - Major section breaks

### Container Widths
- **Full-width sections**: Tables, lists
- **Constrained content**: \`max-width: 1200px\` for detail views
- **Forms**: \`max-width: 600px\` for single-column forms
- **Modals/Dialogs**: \`max-width: 500px\` for small, \`800px\` for large

## 6. COLOR & TYPOGRAPHY CONVENTIONS

### Button Styles
- **Primary**: Brand color (blue), white text, used for main actions
- **Secondary**: Gray background, dark text, used for cancel/alternative
- **Danger**: Red background, white text, used for delete/destructive
- **Ghost**: Transparent background, colored text and border

### Status Colors
- **Success**: Green (#10b981)
- **Warning**: Yellow/Orange (#f59e0b)
- **Error**: Red (#ef4444)
- **Info**: Blue (#3b82f6)
- **Neutral**: Gray (#6b7280)

### Typography Scale
- **Page Title (h1)**: 2rem (32px), bold
- **Section Title (h2)**: 1.5rem (24px), semi-bold
- **Card Title (h3)**: 1.25rem (20px), semi-bold
- **Body**: 1rem (16px), regular
- **Small/Meta**: 0.875rem (14px), regular
- **Labels**: 0.875rem (14px), medium weight

## 7. RESPONSIVE DESIGN RULES

### Breakpoints
- **Mobile**: < 768px
- **Tablet**: 768px - 1024px
- **Desktop**: > 1024px

### Responsive Patterns
- **Tables**: Horizontal scroll on mobile, OR convert to card list
- **Buttons**: Full width on mobile, auto width on desktop
- **Grids**: Single column on mobile, multi-column on desktop
- **Navigation**: Hamburger menu on mobile, sidebar on desktop

## 8. COMPONENT CONSISTENCY CHECKLIST

Before generating ANY component, verify:
- [ ] Buttons are RIGHT aligned in cards and forms
- [ ] Tables have global search filter at top-right
- [ ] Tables have pagination for >25 rows
- [ ] Tables have sortable columns
- [ ] Card action buttons have proper spacing (gap: 0.75rem)
- [ ] Forms have labels above inputs
- [ ] Error states are handled and displayed
- [ ] Loading states are shown during async operations
- [ ] Spacing follows the consistent scale
- [ ] Colors match the defined palette
- [ ] Component is responsive (mobile-friendly)

⚠️ **VALIDATION**: After generating each component, review against this checklist. If any item is missing, regenerate the component with corrections.

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
# Backend API URL
VITE_BACKEND_URL=http://localhost:8080/

# Mock data mode (set to false when backend is ready)
VITE_USE_MOCK_DATA=true

# Agent chat configuration (handled by backend)
# The backend will use these internally for agent LLM integration
# OPENAI_API_KEY=sk-...  (backend only, not exposed to frontend)
# ANTHROPIC_API_KEY=sk-ant-...  (backend only, not exposed to frontend)
\`\`\`

**IMPORTANT**:
- Default to \`VITE_USE_MOCK_DATA=true\` so the app works immediately without backend
- LLM API keys should NEVER be in frontend .env - they're backend-only
- Create **.env.example** with the same structure (without actual API keys)
- Agent chat will call backend endpoint: \`POST /agents/:agentName/chat\`
- Backend handles LLM provider selection based on agent.llm.provider in spec

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

⚠️ **CRITICAL TABLE REQUIREMENTS** (Even if not in spec):
- **\`showGlobalFilter\` defaults to TRUE** - ALWAYS implement global search
- **\`pagination.enabled\` defaults to TRUE** - ALWAYS implement pagination for tables with >10 rows
- **\`sorting.enabled\` defaults to TRUE** - ALWAYS make columns sortable
- If spec omits these fields, ASSUME they are required and implement them
- Global filter must be positioned at TOP-RIGHT of table header
- Pagination controls must be at BOTTOM-RIGHT of table

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

⚠️ **CRITICAL CARD & BUTTON REQUIREMENTS** (Always enforce):
- **Action buttons (edit, delete, etc.) MUST be RIGHT-ALIGNED** at bottom of card
- Use flexbox: \`display: flex; justify-content: flex-end; gap: 0.75rem\`
- Add separator: \`border-top: 1px solid #e5e7eb; padding-top: 1rem; margin-top: 1rem\`
- Button order: Least destructive (Cancel) → Most important (Save/Submit)
- Destructive actions (Delete) should have red/danger styling and confirmation dialogs

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

## 6. Workflows/Events Array (CRITICAL FOR ACTIONS)

The \`workflows\` array (or tools extracted from agent specs) defines **custom actions** that can create/update entities:

### Workflow Specification Structure:
\`\`\`json
{
  "name": "MakeInquiry",
  "displayName": "Make Inquiry",
  "description": "Create a new customer inquiry",
  "entity": "CarDealership/Inquiry",
  "action": "create",
  "inputs": {
    "customerQuery": {
      "type": "text",
      "required": true,
      "label": "What is your question?",
      "placeholder": "Enter your inquiry..."
    },
    "carModelInterest": {
      "type": "select",
      "required": false,
      "label": "Interested Model",
      "options": "CarDealership/CarModel"
    },
    "timestamp": {
      "type": "datetime-local",
      "required": false,
      "default": "now"
    }
  },
  "ui": {
    "showOnPages": ["CarDealership/Customer", "CarDealership/CarModel"],
    "buttonText": "Make Inquiry",
    "icon": "mdi:message-question",
    "style": "primary",
    "position": "header",
    "confirmation": "Create this inquiry?"
  }
}
\`\`\`

### Key Workflow Fields:
- **name**: Workflow identifier (e.g., "MakeInquiry")
- **displayName**: Human-readable name
- **description**: What the workflow does
- **entity**: Target entity for the action (optional - for pure workflows, this may not apply)
- **action**: "create", "update", "delete", or "custom"
- **inputs**: Form fields with type, validation, and UI config
- **ui.showOnPages**: Which entity pages show this workflow button
- **ui.position**: "header", "floating", "inline", "contextMenu"

### Input Types:
- \`text\`, \`number\`, \`email\`, \`tel\`, \`url\`
- \`textarea\` - multi-line text
- \`select\` - dropdown (options can reference an entity: "CarDealership/CarModel")
- \`checkbox\`, \`radio\`
- \`date\`, \`time\`, \`datetime-local\`
- \`file\` - file upload

### Workflow Execution Flow:
1. User clicks workflow button on entity page
2. Dialog/modal opens with form based on \`inputs\`
3. User fills form and submits
4. Frontend calls: \`POST /<ModelName>/<WorkflowName>\` with form data
5. Backend executes workflow (creates/updates entities)
6. Frontend shows success message and refreshes data

### Extracting Workflows from Agent Tools:
If the spec doesn't have a \`workflows\` array, extract workflows from agent \`tools\`:
\`\`\`typescript
// Example: Agent has tools: ["CarDealership/MakeInquiry"]
// This means MakeInquiry is a workflow that should:
// 1. Be available as a button on entity pages
// 2. Be callable by the agent during chat
\`\`\`

## 7. Agent Configuration with LLM Support (CRITICAL)

Agents are **AI assistants** that can chat with users and call workflows as tools:

### Enhanced Agent Specification:
\`\`\`json
{
  "name": "customerServiceAgent",
  "displayName": "Customer Service Agent",
  "description": "Handles customer inquiries and service requests",
  "instruction": "You are a helpful customer service agent for a car dealership. Help customers with inquiries, scheduling test drives, and finding the right vehicle. Be friendly and professional. When a customer wants to make an inquiry or schedule something, use the appropriate tool.",
  "llm": {
    "provider": "claude",
    "model": "claude-3-5-sonnet-20241022",
    "temperature": 0.7,
    "maxTokens": 4096
  },
  "tools": [
    "CarDealership/MakeInquiry",
    "CarDealership/ScheduleTestDrive",
    "CarDealership/CreateCustomer"
  ],
  "contextEntities": ["Customer", "CarModel"],
  "ui": {
    "chatPosition": "sidebar",
    "icon": "mdi:robot-happy",
    "color": "#3b82f6",
    "triggerText": "Ask Customer Service",
    "showOnPages": ["CarDealership/Customer"],
    "autoSuggest": true,
    "welcomeMessage": "Hi! I'm your customer service assistant. How can I help you today?",
    "placeholderText": "Type your message..."
  }
}
\`\`\`

### LLM Provider Configuration:
- **provider**: "claude", "openai", or omit for backend default
- **model**: Specific model name
  - Claude: "claude-3-5-sonnet-20241022", "claude-3-opus-20240229"
  - OpenAI: "gpt-4-turbo", "gpt-4o", "gpt-3.5-turbo"
- **temperature**: 0.0-1.0 (creativity level)
- **maxTokens**: Response length limit

### Agent Chat Implementation Strategy:

**OPTION A: Backend-Powered Agents (RECOMMENDED)**
- Frontend sends message to: \`POST /agents/:agentName/chat\`
- Backend handles LLM integration, maintains conversation history
- Backend executes tools when agent requests them
- Frontend displays streaming response

**OPTION B: Frontend-Powered Agents (Alternative)**
- Use LangChain.js or direct SDK in browser
- Agent \`instruction\` becomes system prompt
- Tools are converted to LangChain tools
- When tool is called, frontend makes API request
- Requires LLM API keys in frontend (less secure)

**For this generator, use OPTION A** (backend-powered):
\`\`\`typescript
// Frontend agent chat hook
const sendMessage = async (agentName: string, message: string) => {
  const response = await fetch(\`/agents/\${agentName}/chat\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      conversationId: currentConversationId,
      context: { currentEntity, currentEntityId }
    })
  });

  // Handle streaming response
  const reader = response.body.getReader();
  // Stream chunks and update UI
};
\`\`\`

### Agent Tool Execution:
When an agent uses a tool:
1. Agent decides to use tool "MakeInquiry"
2. Backend calls: \`POST /CarDealership/MakeInquiry\` with parameters
3. Backend returns result to agent
4. Agent formulates response to user
5. Frontend displays agent's response

### Context-Aware Agents:
If \`contextEntities\` is specified:
- When agent is opened on a Customer page, pass customer data as context
- Agent can use this context to personalize responses
- Example: "I see you're looking at Customer #123, John Doe"

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

# Workflows & Custom Actions - IMPLEMENTATION REQUIREMENTS

Workflows are **custom actions** that appear as buttons on entity pages and can also be called by agents as tools.

## Dual Purpose of Workflows:
1. **User-Triggered Actions**: Users click workflow buttons to execute actions
2. **Agent Tools**: Agents can call workflows during conversations

## Implementation Components Required:

### 1. Workflow Parser Utility (\`src/utils/workflowParser.ts\`):
\`\`\`typescript
// Get all workflows from spec.workflows array
function getWorkflows(spec: UISpec): Workflow[] {
  return (spec.workflows || []).map(workflowName => ({
    name: workflowName,
    displayName: spec[workflowName].displayName,
    description: spec[workflowName].description,
    icon: spec[workflowName].icon,
    category: spec[workflowName].category,
    permissions: spec[workflowName].permissions,
    ui: spec[\`\${workflowName}.ui\`],
    inputs: spec[\`\${workflowName}.inputs\`] || {}
  }));
}

// Get workflows that should show on a specific page
function getWorkflowsForPage(spec: UISpec, pagePath: string): Workflow[] {
  return getWorkflows(spec).filter(w =>
    w.ui.showOnPages && w.ui.showOnPages.includes(pagePath)
  );
}
\`\`\`

### 2. Workflow Components:
- **src/components/workflows/WorkflowButton.tsx** - Renders workflow action button:
  * Displays with icon from \`ui.icon\`
  * Styled based on \`ui.style\` (primary, secondary, danger)
  * Positioned based on \`ui.position\` (header, floating, inline, contextMenu)
  * Shows only on pages listed in \`ui.showOnPages\`

- **src/components/workflows/WorkflowDialog.tsx** - Modal/dialog for workflow execution:
  * Dynamically renders form from \`inputs\` specification
  * Maps input types to form controls (text, select, textarea, date, etc.)
  * Handles entity reference selects (e.g., \`options: "CarDealership/CarModel"\`)
  * Validates required fields
  * Shows confirmation dialog if \`ui.confirmation\` is set
  * Submits to: \`POST /<ModelName>/<WorkflowName>\`

- **src/components/workflows/WorkflowContainer.tsx** - Container for workflow buttons:
  * Reads workflows for current page from spec
  * Renders all applicable WorkflowButton components
  * Manages workflow dialog state (open/close)

### 3. Workflow Execution Flow:
\`\`\`typescript
// 1. User clicks "Make Inquiry" button on Customer page
// 2. WorkflowDialog opens with form fields from workflow.inputs
// 3. User fills form:
//    - customerQuery: "What's the price of Model X?"
//    - carModelInterest: Selected from dropdown
// 4. User submits
// 5. If ui.confirmation exists, show confirmation dialog
// 6. Frontend calls: POST /CarDealership/MakeInquiry
//    Body: { customerQuery: "...", carModelInterest: "..." }
// 7. Backend executes workflow, creates Inquiry entity
// 8. Frontend shows success message
// 9. Frontend refreshes entity data
\`\`\`

### 4. Integration with Entity Pages:
- **EntityList.tsx** should include:
  \`\`\`tsx
  <WorkflowContainer
    currentPage={currentEntityPath}
    position="header"
  />
  \`\`\`

- **EntityDetail.tsx** should include:
  \`\`\`tsx
  <WorkflowContainer
    currentPage={currentEntityPath}
    currentEntityId={entityId}
    position="header"
  />
  \`\`\`

### 5. Entity Reference Selects:
When workflow input has \`options: "CarDealership/CarModel"\`:
- Fetch all CarModel entities: \`GET /CarDealership/CarModel\`
- Populate dropdown with entity names/IDs
- Submit selected entity ID with workflow

### 6. Workflow API Endpoint Pattern:
\`\`\`
POST /<ModelName>/<WorkflowName>
Body: { ...inputs from form }

Example:
POST /CarDealership/MakeInquiry
Body: {
  "customerQuery": "What's the warranty?",
  "carModelInterest": "model-123",
  "timestamp": "2025-01-15T10:30:00"
}
\`\`\`

# Your Task

Generate a COMPLETE, production-ready web application with ALL the following:

## 1. Configuration Files (START HERE)
   - **package.json** - Dependencies (use "agentlang-ui" as package name):
     * REQUIRED: \`react\`, \`react-dom\`, \`react-router-dom\`, \`typescript\`
     * REQUIRED: \`tailwindcss\`, \`postcss\`, \`autoprefixer\` (in devDependencies)
     * REQUIRED: \`@iconify/react\`, \`axios\`, \`formik\`
     * Optional: \`recharts\`, \`date-fns\`
   - **tailwind.config.js** - Tailwind configuration:
     \`\`\`js
     module.exports = {
       content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
       theme: { extend: {} },
       plugins: []
     }
     \`\`\`
   - **postcss.config.js** - PostCSS configuration:
     \`\`\`js
     module.exports = {
       plugins: {
         tailwindcss: {},
         autoprefixer: {}
       }
     }
     \`\`\`
   - **tsconfig.json** and **tsconfig.node.json**
   - **vite.config.ts** - Port 3000 configuration
   - **index.html**
   - **.env** - Backend URL with \`VITE_USE_MOCK_DATA=true\`
   - **.env.example** - Template
   - **.gitignore**
   - **README.md** - Setup instructions

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

## 7. Navigation (ENHANCED)
   - **src/components/navigation/Sidebar.tsx** - With grouping from UI spec
     * **CRITICAL**: Must be toggleable/collapsible
     * Hamburger icon toggle button
     * Save toggle state to localStorage
     * Smooth slide animation (200-300ms)
     * On mobile: Overlay mode, hidden by default
   - **src/components/navigation/Navbar.tsx** - Top navigation bar
     * Logo/app title
     * User menu with logout
     * Notifications (optional)
     * Profile dropdown

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
     * ⚠️ **CRITICAL**: Must render a PROPER TABLE, NOT JSON dump
     * Use the EXACT SAME table pattern as entity lists (see Table Layout template above)
     * Receives relationship spec and child dashboard spec
     * Displays section title from \`relationship.displayName\`
     * **MUST use DynamicTable component** to render child entity data as table
     * Table MUST have: search input, create button (both together on right), pagination
     * Shows "Create" button if \`relationship.ui.allowCreate: true\`
     * Enables inline editing if \`relationship.ui.allowInlineEdit: true\`
     * Fetches data using useRelationships hook
     * **DO NOT** use JSON.stringify or display raw data
     * **DO NOT** create separate create buttons - use the one in table header
     * Template structure:
     \`\`\`tsx
     <div className="mt-6">
       <h3 className="text-lg font-semibold mb-3">{relationship.displayName}</h3>
       {/* Use DynamicTable with child entity data */}
       <DynamicTable
         data={childData}
         spec={childDashboardSpec}
         onRowClick={(item) => navigate(\`/\${childEntity}/\${item.id}\`)}
         onCreateClick={() => openCreateDialog()}
       />
     </div>
     \`\`\`

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
   - **src/components/agents/ChatbotBubble.tsx** - Floating chatbot bubble (CRITICAL):
     * Floating button fixed bottom-right (60px circle)
     * Opens messenger-style chat interface (400×600px)
     * Agent selector if multiple agents
     * Message bubbles, typing indicator, timestamps
     * Available on ALL pages
     * Maintains state across navigation
   - **src/hooks/useAgentChat.ts** - Hook for agent chat functionality:
     * Manages chat state (messages, loading, streaming)
     * Sends messages to agent endpoint
     * Handles tool execution callbacks

## 12. Workflows (ENHANCED)
   - **src/utils/workflowParser.ts** - Workflow parsing utilities:
     * \`getWorkflows(spec)\` - Get all workflows from spec.workflows array
     * \`getWorkflowInputs(spec, workflowName)\` - Get input fields for workflow from spec["\${workflowName}.inputs"]
     * Each workflow is defined in spec following this pattern:
       - spec.workflows: string[] - Array of workflow names
       - spec[workflowName]: { displayName, description, icon, category, permissions }
       - spec["\${workflowName}.ui"]: { showOnDashboard, showInQuickActions, buttonText, icon, style, confirmationRequired }
       - spec["\${workflowName}.inputs"]: { [inputName]: { inputType, required, validation, displayOptions, dataSource } }
   - **src/components/workflows/WorkflowButton.tsx** - Workflow action button:
     * Renders button with icon, style, position from workflow.ui
     * Triggers workflow dialog on click
   - **src/components/workflows/WorkflowDialog.tsx** - Workflow execution dialog:
     * **CRITICAL**: Reads workflow.inputs directly from spec["\${workflowName}.inputs"]
     * Dynamically builds form from workflow.inputs specification
     * Each input field has: inputType (text/number/select/textarea/datetime-local), required, validation, displayOptions
     * For select inputs with dataSource: fetches options from dataSource.entity
     * If no inputs found, show simple confirmation dialog
     * Validates and submits to workflow endpoint: \`POST /<ModelName>/<WorkflowName>\`
     * Shows success/error toast message
   - **src/components/workflows/WorkflowContainer.tsx** - Workflow button container:
     * Fetches workflows for current page using workflowParser
     * Renders all applicable WorkflowButton components
     * Manages dialog open/close state

## 13. Dashboard (ENHANCED)
   - **src/components/dashboard/Dashboard.tsx** - Main dashboard with:
     * Toggleable sidebar integration
     * Stat cards (entities count, recent activity, etc.)
     * **Workflow Quick Actions section** - Grid of all workflows
     * Charts and visualizations
     * Recent activity feed
   - **src/components/dashboard/StatCard.tsx** - Stat display card with icon
   - **src/components/dashboard/ChartWidget.tsx** - Chart container component
   - **src/components/dashboard/WorkflowQuickAction.tsx** - Workflow action card:
     * Displays workflow icon, name, description
     * Clicking opens WorkflowDialog
     * Shows workflow execution result

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
   - **DynamicTable.tsx** - Full-featured table with:
     * **REQUIRED**: Global search filter (top-right, 250px min-width, search icon)
     * **REQUIRED**: Pagination (bottom-right, default 25 per page, page size selector)
     * **REQUIRED**: Sortable columns with visual indicators (↑↓)
     * **REQUIRED**: Proper table header layout - title LEFT, actions/search RIGHT
     * Optional: Column filters, row selection, bulk actions
   - **DynamicCard.tsx** - Grid layout card for instance summaries with:
     * **REQUIRED**: Action buttons RIGHT-ALIGNED at bottom with separator
     * **REQUIRED**: Button spacing (gap: 0.75rem) and proper ordering
     * Grid layout for fields (2-3 columns based on spec)
     * Label/value styling (label: bold, muted; value: regular, primary)
   - **DynamicForm.tsx** - Form builder with:
     * **REQUIRED**: Labels above inputs, required indicators (*)
     * **REQUIRED**: Form actions RIGHT-ALIGNED at bottom (Cancel left of Submit)
     * Formik integration and input type mapping
     * Error messages below inputs, proper spacing
   - **DynamicButton.tsx** - Action button renderer with icon and styling support

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
   - ⚠️ **DO NOT include Agent items in navigation** - Agents are accessed ONLY via ChatbotBubble
   - Filter out any agent entries from navigation groups
   - Only show entity/workflow navigation items in sidebar

✅ **Branding from Spec**:
   - Apply \`spec.branding.primaryColor\` and \`spec.branding.secondaryColor\` to theme
   - Use \`spec.branding.logo\` and \`spec.branding.favicon\`
   - Apply colors to navigation groups from \`navigation.grouping[].color\`

✅ **Form Validation from Spec**:
   - Read \`spec.login.form.validation\` and \`spec.signUp.form.validation\`
   - Apply validation rules to auth forms
   - Use validation patterns (email, minLength, pattern) in DynamicForm

✅ **Workflow Integration** (CRITICAL):
   - Create \`src/utils/workflowParser.ts\` to read workflows from spec
   - Read workflows from spec.workflows array
   - Get workflow metadata from spec[workflowName], spec["\${workflowName}.ui"], spec["\${workflowName}.inputs"]
   - Show workflow buttons on entity pages based on \`ui.showOnPages\`
   - Show on dashboard if \`ui.showOnDashboard\` is true
   - WorkflowDialog dynamically builds form from spec["\${workflowName}.inputs"]
   - Handle entity reference selects with dataSource (fetch options from entity endpoints)
   - Submit workflows to: \`POST /<ModelName>/<WorkflowName>\`

✅ **Agent Chat with Backend Integration** (CRITICAL):
   - Agent chat is **backend-powered** (not frontend LLM)
   - Frontend sends message to: \`POST /agents/:agentName/chat\`
   - Backend handles LLM provider selection based on \`agent.llm.provider\`
   - Backend executes agent tools (workflows) when requested
   - Frontend displays streaming response
   - Agent instructions from spec become system prompts (backend handles this)
   - No LLM API keys in frontend - all handled by backend

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
   - **vite.config.ts** - IMPORTANT: Configure dev server port to 3000 (not default 5173):
     \`\`\`typescript
     export default defineConfig({
       server: {
         port: 3000,
         host: true
       },
       // ... rest of config
     });
     \`\`\`
   - **index.html** - Use \`${uiSpec.appInfo.title}\` as title
   - **.env** - Set \`VITE_USE_MOCK_DATA=true\`, \`VITE_BACKEND_URL=http://localhost:8080/\`
   - **.env.example** - Same as .env (without API keys)
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
4. Generate **src/utils/workflowParser.ts** - Workflow parsing functions (SIMPLE & CLEAN):

   ⚠️ **WORKFLOW STRUCTURE IN SPEC** - Workflows follow the SAME pattern as entities:

   Spec has:
   - \`spec.workflows\` array: ["CarDealership/CreateCarModel", "CarDealership/MakeInquiry", ...]
   - \`spec["CarDealership/CreateCarModel"]\`: Metadata (displayName, description, icon, category)
   - \`spec["CarDealership/CreateCarModel.ui"]\`: UI config (showOnDashboard, buttonText, style, etc.)
   - \`spec["CarDealership/CreateCarModel.inputs"]\`: Input fields (like form fields)

   **Simple Parsing Logic**:
   \`\`\`typescript
   export function getWorkflows(spec: UISpec) {
     return (spec.workflows || []).map(workflowName => {
       const metadata = spec[workflowName];
       const ui = spec[\`\${workflowName}.ui\`];
       const inputs = spec[\`\${workflowName}.inputs\`] || {};

       return {
         name: workflowName,
         displayName: metadata.displayName,
         description: metadata.description,
         icon: metadata.icon,
         category: metadata.category,
         permissions: metadata.permissions,
         ui: ui,
         inputs: inputs
       };
     });
   }

   export function getQuickActionWorkflows(spec: UISpec) {
     return getWorkflows(spec).filter(w => w.ui?.showInQuickActions === true);
   }

   export function getDashboardWorkflows(spec: UISpec) {
     return getWorkflows(spec).filter(w => w.ui?.showOnDashboard === true);
   }
   \`\`\`

   Functions to export:
   - \`getWorkflows(spec)\` - Get all workflows from spec.workflows array
   - \`getQuickActionWorkflows(spec)\` - Get workflows where showInQuickActions=true
   - \`getDashboardWorkflows(spec)\` - Get workflows where showOnDashboard=true
5. Generate **src/types/index.ts** - TypeScript interfaces for all entities, workflows, and agents
6. Generate **src/data/uiSpec.ts** - Export the full UI spec object
7. Generate **src/data/mockData.ts** - Mock data for all entities + auth + mock conversation history

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
    * ⚠️ **CRITICAL**: MUST render proper table using DynamicTable component
    * **DO NOT** dump JSON data - use table format
    * Use SAME table layout pattern as EntityList (search + create together on right)
    * No duplicate create buttons

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
31. Generate **src/components/agents/ChatbotBubble.tsx** - Floating chatbot bubble (CRITICAL - messenger-style chat)

## Phase 9: Workflows & Dashboard
32. Generate **src/components/workflows/WorkflowButton.tsx** - Individual workflow action button
33. Generate **src/components/workflows/WorkflowDialog.tsx** - Workflow execution dialog with dynamic form
34. Generate **src/components/workflows/WorkflowContainer.tsx** - Container that manages workflow buttons for a page
35. Generate **src/components/dashboard/Dashboard.tsx** - MUST include:
   * Toggleable sidebar (hamburger icon, localStorage state)
   * **Workflow Quick Actions section** - Grid of workflow cards (use QuickActions component)
   * Stat cards with icons
   * Charts and visualizations
36. Generate **src/components/dashboard/StatCard.tsx**
37. Generate **src/components/dashboard/ChartWidget.tsx**
38. Generate **src/components/dashboard/QuickActions.tsx** - Workflow quick actions grid:
   * Shows ALL workflows from spec
   * Grid layout (3 columns on desktop, 1 on mobile)
   * Each card: icon, name, description
   * Click opens WorkflowDialog

## Phase 10: Core Application
39. Generate **src/App.tsx** - Routing with spec-driven navigation
   - Routes: \`/:modelName/:entityName\`, \`/:modelName/:entityName/:id\`
   - Agent routes: \`/agents\`, \`/agents/:agentName\`
   - Include WorkflowContainer on entity pages
   - **CRITICAL**: Include <ChatbotBubble /> in the main layout (available on ALL pages)
40. Generate **src/main.tsx** - Entry point
41. Generate **src/index.css** - Global styles with branding colors from spec
   * Include styles for ChatbotBubble (floating, animation)
   * Include styles for toggleable sidebar
   * Modern, polished aesthetic
42. Generate **src/utils/validation.ts** - Validation utilities
43. Generate **src/utils/routeParser.ts** - Route parsing utilities

## Phase 11: Documentation
44. Generate **README.md** - Setup instructions, backend configuration, feature list

## IMPORTANT REMINDERS:

### To SPEED UP generation and PREVENT ERRORS:
1. **Use Write tool for ALL file creation** (not MCP write_file - it's slower)
2. **Generate files in order** (dependencies first: config → types → utils → components)
3. **Use Tailwind classes ONLY** (no custom CSS files per component)
4. **Keep components simple** (100-150 lines max per component)
5. **Don't overthink** - Use the exact patterns shown above
6. **Test as you go** - After critical components, verify they work

### Critical path:
- **Start with specParser.ts and workflowParser.ts** - Everything else depends on them
- **Use Tailwind exclusively** - Prevents layout conflicts
- **Follow exact layout patterns** - Use the templates provided above
- **Dynamic components are critical** - EntityList and EntityDetail use ComponentResolver
- **Test relationship detection** - EntityDetail must detect and render child entities
- **Workflow integration** - Add WorkflowContainer to EntityList and EntityDetail
- **Agent routes** - Add agent listing and chat routes to App.tsx
- **ChatbotBubble in App.tsx** - Must be in main layout
- **Toggleable sidebar** - Save state to localStorage
- **Port 3000** - Configure Vite dev server to use port 3000

# SENSIBLE DEFAULTS - ALWAYS APPLY THESE (CRITICAL!)

⚠️ **THESE DEFAULTS MUST BE APPLIED EVEN IF NOT EXPLICITLY MENTIONED IN THE SPEC**

## Table Defaults (Apply to ALL tables)
1. **Global Search Filter**: ALWAYS add global search filter at top-right
   - Position: Top-right corner of table header
   - Width: min-width 250px
   - Icon: Search icon (mdi:magnify)
   - Placeholder: "Search..." or "Filter {EntityName}..."
   - Debounce: 300ms

2. **Pagination**: ALWAYS add pagination if table has >10 rows
   - Position: Bottom-right of table
   - Default page size: 25
   - Page size options: [10, 25, 50, 100]
   - Show: "Showing X-Y of Z entries"

3. **Sorting**: ALWAYS make columns sortable
   - Add sort indicators (↑↓) to column headers
   - Default sort: Usually by \`name\` or first text field
   - Make headers clickable

4. **Table Header Layout**:
   - Title/heading: LEFT aligned
   - Actions (Create button, Search filter): RIGHT aligned
   - Use flexbox: \`display: flex; justify-content: space-between\`

## Card Defaults (Apply to ALL cards)
1. **Button Placement**: ALWAYS align action buttons RIGHT
   - CSS: \`display: flex; justify-content: flex-end; gap: 0.75rem\`
   - Add separator: \`border-top: 1px solid #e5e7eb; padding-top: 1rem; margin-top: 1rem\`

2. **Button Order** (left to right):
   - Least destructive first (Cancel, Back)
   - Most important last (Save, Submit)
   - Destructive separately (Delete with red styling)

3. **Field Layout**:
   - Grid layout: 2-3 columns
   - CSS: \`display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem\`

4. **Label/Value Styling**:
   - Labels: Bold, 14px, muted color (#6b7280)
   - Values: Regular, 16px, primary color (#1f2937)

## Form Defaults (Apply to ALL forms)
1. **Field Layout**:
   - Labels: ALWAYS above inputs (vertical layout)
   - Required indicator: Red asterisk (*) after label
   - Spacing: 1.25rem between fields

2. **Form Actions**:
   - Position: Bottom of form, RIGHT aligned
   - Button order: Cancel (left) → Submit (right)
   - Spacing: gap 0.75rem between buttons
   - Add separator: \`border-top: 1px solid #e5e7eb\`

3. **Error Messages**:
   - Position: Below input field
   - Color: Red (#ef4444)
   - Font size: 14px
   - Margin top: 0.25rem

## Button Defaults (Apply to ALL buttons)
1. **Styling by Type**:
   - Primary: Blue background, white text
   - Secondary: Gray background, dark text
   - Danger: Red background, white text
   - Ghost: Transparent, border, colored text

2. **Spacing**:
   - Between buttons: gap 0.75rem (12px)
   - Padding: 0.5rem 1rem (8px 16px)
   - Border radius: 0.375rem (6px)

3. **Icons**:
   - Use Iconify icons
   - Position: Left of text
   - Size: 20px
   - Margin right: 0.5rem

## Layout Defaults
1. **Spacing Scale** (use consistently):
   - xs: 4px, sm: 8px, base: 12px, md: 16px, lg: 24px, xl: 32px

2. **Container Widths**:
   - Full-width: Tables, lists
   - Constrained: max-width 1200px for detail views
   - Forms: max-width 600px

3. **Responsive Breakpoints**:
   - Mobile: < 768px (single column, full-width buttons)
   - Tablet: 768-1024px
   - Desktop: > 1024px

## Visual Consistency Defaults
1. **Colors**:
   - Primary: #3b82f6 (blue)
   - Success: #10b981 (green)
   - Warning: #f59e0b (orange)
   - Error: #ef4444 (red)
   - Neutral: #6b7280 (gray)

2. **Typography**:
   - h1: 32px bold
   - h2: 24px semi-bold
   - h3: 20px semi-bold
   - body: 16px regular
   - small: 14px regular

3. **Borders**:
   - Default: 1px solid #e5e7eb
   - Radius: 0.5rem (8px) for cards, 0.375rem (6px) for buttons

4. **Shadows**:
   - Card: 0 1px 3px 0 rgb(0 0 0 / 0.1)
   - Hover: 0 4px 6px -1px rgb(0 0 0 / 0.1)

## Loading & Error States (ALWAYS implement)
1. **Loading States**:
   - Show spinner during data fetching
   - Disable buttons during submission
   - Show "Loading..." text

2. **Error States**:
   - Show error message in red
   - Keep form values on error
   - Highlight invalid fields

3. **Empty States**:
   - Show helpful message when no data
   - Suggest actions ("Create your first...")
   - Use appropriate icon

## Validation CHECKLIST (before generating EACH component):
- [ ] Tables have global search at top-right
- [ ] Tables have pagination at bottom-right
- [ ] Tables have sortable columns
- [ ] Card buttons are right-aligned with separator
- [ ] Form actions are right-aligned
- [ ] Form labels are above inputs
- [ ] Proper spacing throughout (using scale)
- [ ] Loading states implemented
- [ ] Error states implemented
- [ ] Responsive on mobile
- [ ] Colors match palette
- [ ] Typography is consistent

⚠️ **IF ANY OF THESE ARE MISSING, STOP AND FIX BEFORE PROCEEDING**

# POLISH & MINIMALISM GUIDELINES (PRODUCTION-READY UI)

⚠️ **CRITICAL**: The generated UI must be polished, professional, and deployment-ready. Follow these guidelines:

## 1. Visual Polish & Professional Appearance

### Clean, Modern Aesthetic
- **Whitespace**: Use generous whitespace between sections (24-32px)
- **Borders**: Subtle borders (1px solid #e5e7eb) or shadows instead of heavy lines
- **Corners**: Consistent border-radius (8px for cards, 6px for buttons, 4px for inputs)
- **Shadows**: Subtle shadows for depth
  * Cards: \`0 1px 3px 0 rgba(0, 0, 0, 0.1)\`
  * Hover: \`0 4px 6px -1px rgba(0, 0, 0, 0.1)\`
  * Modals: \`0 20px 25px -5px rgba(0, 0, 0, 0.1)\`
- **Colors**: Use a limited, consistent color palette
  * Primary action: #3b82f6 (blue)
  * Success: #10b981 (green)
  * Danger: #ef4444 (red)
  * Neutral: #6b7280 (gray)
  * Background: #f9fafb (light gray)

### Typography Excellence
- **Font Stack**: System fonts for speed and consistency
  * \`font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif\`
- **Hierarchy**: Clear size distinctions
  * h1: 32px/2rem (page titles)
  * h2: 24px/1.5rem (section titles)
  * h3: 20px/1.25rem (card titles)
  * body: 16px/1rem (content)
  * small: 14px/0.875rem (meta info)
- **Readability**:
  * Line height: 1.5 for body text
  * Max width: 65-75 characters per line for reading
  * Contrast: WCAG AA compliant (4.5:1 for normal text)

### Smooth Interactions
- **Transitions**: All interactive elements have smooth transitions
  * Buttons: \`transition: all 0.2s ease\`
  * Hover effects: Background color, transform (scale), shadow changes
  * Page transitions: Fade in/out
- **Loading States**:
  * Skeleton screens for content loading (not just spinners)
  * Disable + show spinner on button during submit
  * Progress indicators for multi-step processes
- **Animations**:
  * Subtle, purposeful animations (not distracting)
  * Modal fade in/slide up
  * Toast notifications slide in from top-right
  * List items fade in when loaded

## 2. Minimalism & Clutter Reduction

### NO Unnecessary Elements
- **One Primary Action**: Each section should have max ONE primary button
- **Remove Redundant Features**:
  * Don't show "Export", "Print", "Share" buttons unless explicitly in spec
  * Don't add extra toolbar buttons "just in case"
  * Don't create unnecessary tabs or navigation items
- **Hide Advanced Features**: Put advanced/rarely-used features in dropdowns or "More" menus
- **Progressive Disclosure**: Show simple interface first, reveal complexity when needed

### Clean Table/List Interfaces
- **Essential Columns Only**: Show 4-6 most important columns by default
- **Actions**: Use icon buttons (not text) for row actions (view, edit, delete)
- **Bulk Actions**: Only show when rows are selected (not always visible)
- **Filters**: Collapse advanced filters into a "Filters" button/panel

### Form Simplicity
- **Group Related Fields**: Use fieldsets or visual grouping
- **One Column**: Default to single-column forms (easier to scan)
- **Smart Defaults**: Pre-fill fields when possible
- **Inline Validation**: Show errors only after field blur, not while typing
- **Help Text**: Use placeholder text, tooltips, or help icons (not always-visible text blocks)

## 3. Consistency Everywhere

### Component Reuse
- **Build Once, Use Everywhere**: Create reusable components (Button, Input, Card, etc.)
- **Same Spacing**: Use consistent spacing scale everywhere (4, 8, 12, 16, 24, 32px)
- **Same Colors**: Don't introduce random colors - stick to the palette
- **Same Patterns**: If one table has search at top-right, ALL tables should

### Predictable Behavior
- **Navigation**: Same navigation structure on every page
- **Action Placement**: Actions in same places (tables: create button top-right, cards: actions bottom-right)
- **Feedback**: Same success/error messages and toast positions
- **Loading**: Same loading indicators and skeleton screens

### Icon Usage
- **Consistent Icon Set**: Use ONLY Iconify icons from Material Design Icons (mdi)
- **Consistent Size**: 20px for buttons, 24px for feature icons, 16px for inline icons
- **Meaningful Icons**: Use widely-understood icons
  * Create: mdi:plus
  * Edit: mdi:pencil
  * Delete: mdi:delete
  * Search: mdi:magnify
  * Filter: mdi:filter-variant
  * Menu: mdi:menu
  * Close: mdi:close
  * Check: mdi:check
  * Alert: mdi:alert-circle

## 4. Mobile Responsiveness (Critical)

### Mobile-First Approach
- **Touch Targets**: Min 44px height for buttons/links
- **Readable Text**: Min 16px font size (prevents zoom on iOS)
- **Thumb-Friendly**: Important actions within reach (bottom of screen)
- **Simplified Layout**: Reduce columns, hide less important info on mobile

### Responsive Patterns
- **Tables**: Convert to card list on mobile (< 768px)
- **Sidebars**: Overlay on mobile, don't reduce content width
- **Forms**: Full-width inputs on mobile
- **Modals**: Full-screen on mobile
- **Navigation**: Hamburger menu on mobile

## 5. Deployment-Ready Checklist

### Code Quality
- **No Console Errors**: Clean browser console
- **TypeScript**: No type errors
- **Linting**: No linting errors
- **Build**: "npm run build" succeeds without warnings

### User Experience
- **Fast Load**: Initial page load < 3 seconds
- **Smooth Scroll**: No jank or lag
- **Error Handling**: All errors caught and displayed to user
- **Empty States**: All lists/tables have empty state messages
- **Loading States**: All async operations show loading UI
- **Success Feedback**: Actions show success toasts/messages

### Accessibility
- **Keyboard Navigation**: All interactive elements keyboard-accessible
- **ARIA Labels**: Proper ARIA labels on icons and buttons
- **Focus States**: Visible focus indicators
- **Contrast**: Meet WCAG AA contrast requirements

### Content
- **No Lorem Ipsum**: Use realistic placeholder content
- **No Broken Images**: All images have alt text and fallbacks
- **No Dead Links**: All navigation works
- **Helpful Messages**: Clear, actionable error messages

## 6. Component-Specific Polish

### Buttons
- ✅ Proper hover states (background darken, slight shadow)
- ✅ Active/pressed state (slight scale down)
- ✅ Disabled state (reduced opacity, no pointer)
- ✅ Loading state (spinner + "Loading..." text, disabled)
- ✅ Icons properly aligned with text

### Inputs
- ✅ Focus state (blue border, subtle shadow)
- ✅ Error state (red border, error message below)
- ✅ Disabled state (gray background, no pointer)
- ✅ Placeholder text (helpful, not generic)
- ✅ Clear/reset button for search inputs

### Tables
- ✅ Hover state on rows (light gray background)
- ✅ Selected state (blue background)
- ✅ Sorting indicators (arrows)
- ✅ Loading skeleton while fetching
- ✅ Empty state with helpful message
- ✅ Pagination with page numbers (not just prev/next)

### Modals/Dialogs
- ✅ Smooth fade-in animation
- ✅ Backdrop blur or darken
- ✅ Click outside to close (with confirmation if form has data)
- ✅ Escape key to close
- ✅ Focus trap (tab stays within modal)
- ✅ Scroll lock on body when modal open

### Toasts/Notifications
- ✅ Slide in from top-right
- ✅ Auto-dismiss after 5 seconds (info/success), manual dismiss for errors
- ✅ Stacking (multiple toasts stack vertically)
- ✅ Icons for success/error/warning/info
- ✅ Action buttons if needed ("Undo", "View Details")

⚠️ **FINAL VALIDATION**: Before considering generation complete:
1. View each page and verify it looks polished and professional
2. Test on mobile viewport (< 768px)
3. Check all interactions (buttons, forms, modals)
4. Verify no console errors
5. Confirm "npm run build" succeeds
6. Check that the app looks ready for production deployment

**Remember**:
- **Quality over Quantity**: Better to have fewer, well-polished features than many half-finished ones
- **Minimalism**: When in doubt, leave it out. Add only what's necessary.
- **Consistency**: Every page should feel like part of the same app
- **Professional**: The UI should look like a commercial SaaS product

## FINAL REMINDERS BEFORE STARTING:

1. **Tailwind CSS is MANDATORY** - No inline styles, no CSS-in-JS
2. **Use exact layout templates** - Don't improvise, use patterns shown at the top
3. **Keep it simple** - Don't add unnecessary features
4. **One create button per table** - No clutter
5. **Auth pages are different** - Centered layout, no sidebar
6. **Test after generation** - Run \`npm run dev\` to verify
7. **Check for errors** - Browser console should be clean

**SPEED TIPS** (to reduce generation time):
- Generate config files first (takes 30 seconds)
- Then types and utils (takes 1-2 minutes)
- Then components (takes 3-5 minutes)
- Use Write tool (not MCP write_file - it's faster)
- Follow the generation phases in order
- Keep components under 150 lines

**QUALITY CHECKLIST** (verify before completing):
- [ ] Tailwind installed and configured
- [ ] All layouts use Tailwind classes (NO inline styles)
- [ ] No console errors
- [ ] Sidebar toggles smoothly
- [ ] ChatbotBubble visible on all pages
- [ ] Forms work and validate
- [ ] Tables have search/pagination
- [ ] Mobile responsive (test at 375px)
- [ ] All pages and functionality implemented
- [ ] \`npm run build\` succeeds
- [ ] \`npm run dev\` starts without errors

## 🔥 FINAL CRITICAL REMINDERS (COMMON ISSUES):

### 1. ❌ NO Agents in Navigation Sidebar
- Agents are accessed ONLY via ChatbotBubble
- Filter out agent entries from spec.navigation.grouping
- Only show entities and workflows in sidebar

### 2. ✅ Dashboard MUST Have Quick Actions
- Create QuickActions.tsx component
- **Read workflows from spec.workflows array and spec[workflowName] metadata**
- Filter workflows where spec["\${workflowName}.ui"].showOnDashboard === true
- Shows workflows in a grid (3 columns)
- Each card shows:
  * icon from spec[workflowName].icon
  * displayName from spec[workflowName].displayName
  * description from spec[workflowName].description
- Clicking opens WorkflowDialog with input form (from spec["\${workflowName}.inputs"])
- Example workflow structure in spec:
  * spec.workflows = ["CarDealership/CreateCarModel", "CarDealership/MakeInquiry", ...]
  * spec["CarDealership/CreateCarModel"] = { displayName: "Create Car Model", description: "...", icon: "mdi:plus-circle", ... }
  * spec["CarDealership/CreateCarModel.ui"] = { showOnDashboard: true, buttonText: "Create Car Model", ... }
  * spec["CarDealership/CreateCarModel.inputs"] = { dealerId: { inputType: "select", ... }, make: { inputType: "text", ... }, ... }
- Additionally, there must be clicable HOME button to return to Dashboard screen from other screens.

### 3. ❌ NO JSON Dumps in Relationship Tables
- **NEVER** use JSON.stringify() to show child entities
- **ALWAYS** use DynamicTable component for relationships
- RelationshipSection must render proper table with search + create
- Use exact same table pattern as entity lists
- Properly generate tables and verify they are properly created.

### 4. ✅ Table Search + Create Button TOGETHER
- Search input and Create button MUST be side-by-side on right
- NO separate create button above or outside table
- Pagination MUST be at bottom with page size selector
- Use this pattern for ALL tables (entity lists AND relationship tables)

**Double-check these 4 issues before completing generation!**

START NOW! Generate the complete application following this exact process. Work efficiently, use Tailwind, follow the patterns, and test as you go.`;
}
