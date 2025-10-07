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
          await scanDirectory(fullPath, prefix + '  ');
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
    console.log(chalk.yellow(`  ⚠️  Error analyzing directory: ${error instanceof Error ? error.message : String(error)}`));
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

    // Display mode info
    if (mode === 'fresh') {
      spinner.text = `Creating new project: ${projectDir}`;
      console.log(chalk.cyan('  📦 Mode: Fresh generation'));
    } else if (mode === 'incremental') {
      spinner.succeed(chalk.cyan('  🔄 Mode: Incremental update'));
      console.log(chalk.gray(`  📂 Found existing project with ${projectAnalysis.fileCount} files`));
      console.log(chalk.gray(`  📝 Will add missing files based on spec`));
      spinner.start('Preparing incremental update...');
    } else if (mode === 'update') {
      spinner.succeed(chalk.cyan('  ✏️  Mode: User-directed update'));
      console.log(chalk.gray(`  📂 Found existing project with ${projectAnalysis.fileCount} files`));
      console.log(chalk.gray(`  💬 User message: "${userMessage}"`));
      spinner.start('Preparing update...');
    }

    await fs.ensureDir(projectDir);

    // Track generated files for MCP tool (though agent will likely use Write tool)
    const generatedFiles: string[] = [];

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

        generatedFiles.push(args.file_path);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(chalk.green(`  ✓ [${elapsed}s] Created: ${args.file_path}`));

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
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(chalk.blue(`  📁 [${elapsed}s] Created directory: ${args.dir_path}`));
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

    console.log(chalk.gray('\n  📋 Agent Configuration:'));
    console.log(chalk.gray('    • Working directory: ') + chalk.white(projectDir));
    console.log(chalk.gray('    • Tool permissions: ') + chalk.green('Full access'));
    console.log(chalk.gray('    • Available tools: Write, Read, Edit, Bash, MCP tools'));

    // Create the generation prompt
    const prompt = createGenerationPrompt(uiSpec, projectDir, mode, projectAnalysis, userMessage);

    // Configure SDK with API key
    process.env.ANTHROPIC_API_KEY = apiKey;

    // Change working directory to projectDir so Write tool creates files in the right place
    const originalCwd = process.cwd();
    process.chdir(projectDir);
    console.log(chalk.gray(`    • Changed working directory to: ${projectDir}\n`));

    spinner.text = 'Starting Claude Agent...';
    console.log(chalk.cyan('🤖 Starting generation...\n'));

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

    // Process messages from the agent
    let lastTextMessage = '';
    let toolCallCount = 0;
    let messageCount = 0;

    for await (const message of session) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (message.type === 'assistant') {
        messageCount++;
        // Extract text content from assistant message
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              lastTextMessage = block.text;
              // Show thinking/progress messages
              if (lastTextMessage.trim()) {
                const preview = lastTextMessage.slice(0, 80).replace(/\n/g, ' ');
                console.log(chalk.gray(`  💭 [${elapsed}s] ${preview}${lastTextMessage.length > 80 ? '...' : ''}`));
              }
            } else if (block.type === 'tool_use') {
              toolCallCount++;
              const toolName = block.name;
              console.log(chalk.blue(`  🔧 [${elapsed}s] Using tool: ${toolName}`));
              spinner.text = `[${elapsed}s] Agent working... (${toolCallCount} tool calls)`;
            }
          }
        }
      } else if (message.type === 'result') {
        // Final result
        spinner.stop();
        const finalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (message.subtype === 'success') {
          console.log(chalk.green(`\n✅ Agent completed successfully`));
          console.log(chalk.gray(`  ⏱  Time: ${finalElapsed}s`));
          console.log(chalk.gray(`  🔄 Turns: ${message.num_turns}`));
          console.log(chalk.gray(`  🔧 Tool calls: ${toolCallCount}`));
          console.log(chalk.gray(`  💰 Cost: $${message.total_cost_usd.toFixed(4)}`));
        } else {
          console.log(chalk.yellow(`\n⚠️  Agent finished with status: ${message.subtype}`));
          console.log(chalk.gray(`  ⏱  Time: ${finalElapsed}s`));
        }
      }
    }

    // Restore original working directory
    process.chdir(originalCwd);

    // Count actual files generated in the ui/ directory
    const actualFileCount = await countGeneratedFiles(projectDir);

    spinner.succeed(chalk.green(`✅ UI generation completed!`));
    console.log(chalk.green(`\n📊 Generation Summary:`));
    console.log(chalk.gray(`  • Files created: `) + chalk.white(actualFileCount));
    console.log(chalk.gray(`  • Time elapsed: `) + chalk.white(`${((Date.now() - startTime) / 1000).toFixed(1)}s`));
    console.log(chalk.gray(`  • Output location: `) + chalk.white(projectDir));

    // Output final message from agent
    if (lastTextMessage) {
      console.log(chalk.cyan('\n💬 Agent message:'));
      const messageLines = lastTextMessage.split('\n').slice(0, 5); // Show first 5 lines
      messageLines.forEach(line => console.log(chalk.gray(`   ${line}`)));
      if (lastTextMessage.split('\n').length > 5) {
        console.log(chalk.gray('   ...'));
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

/* eslint-disable no-console */
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
/* eslint-enable no-console */

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
    const commitMessage = `Add generated UI for ${appTitle}\n\n🤖 Generated with AgentLang CLI`;
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
- Generate ALL required files for a complete working application
- Follow the template structure exactly as specified below
${userMessage ? `\n# ADDITIONAL REQUIREMENT\n\nAfter generating the complete base application, also implement this:\n${userMessage}` : ''}`;
  } else if (mode === 'incremental') {
    modeInstructions = `
# MODE: Incremental Update

An existing UI project was found at: ${projectDir}
Existing project has ${projectAnalysis.fileCount} files.

Your task:
1. Use Read tool to examine the existing project structure
2. Compare it with the UI spec below
3. Identify MISSING files or features based on the spec
4. Add ONLY the missing files/features
5. If files already exist and are complete, DO NOT regenerate them
6. Update existing files ONLY if they're missing required features from the spec

Existing files (showing first 20):
\`\`\`
${projectAnalysis.structure}
\`\`\`

Be conservative - preserve existing code when possible, only add what's missing.`;
  } else if (mode === 'update') {
    modeInstructions = `
# MODE: User-Directed Update

An existing UI project was found at: ${projectDir}
Existing project has ${projectAnalysis.fileCount} files.

# USER REQUEST:
${userMessage}

Your task:
1. Use Read tool to examine relevant existing files
2. Understand the user's request: "${userMessage}"
3. Make TARGETED changes to implement the request
4. Modify existing files as needed using Edit tool
5. Add new files only if necessary
6. Test that your changes work with the existing codebase

Existing files (showing first 20):
\`\`\`
${projectAnalysis.structure}
\`\`\`

Focus on the user's specific request. Be surgical - only change what's necessary.`;
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
VITE_USE_MOCK_DATA=false
\`\`\`

Also create **.env.example** as a template.

## 2. API Client Structure

### src/api/client.ts
- Read \`VITE_BACKEND_URL\` from environment variables
- Create an Axios instance with base URL
- If \`VITE_USE_MOCK_DATA=true\` or no backend URL, use mock data

### src/api/endpoints.ts
**Agentlang API Convention:**

For entities (CRUD operations):
- **GET all**: \`GET /<ModelName>/<Entity>\`
- **GET one**: \`GET /<ModelName>/<Entity>/:id\`
- **POST (create)**: \`POST /<ModelName>/<Entity>\` with JSON body
- **PUT (update)**: \`PUT /<ModelName>/<Entity>/:id\` with JSON body
- **DELETE**: \`DELETE /<ModelName>/<Entity>/:id\`

For workflows/events:
- **POST**: \`POST /<ModelName>/<WorkflowName>\` with input parameters

**Example:**
- Entity: \`CarDealership/Customer\`
  - Create: \`POST /CarDealership/Customer\` with body \`{ name: "...", contactDetails: "..." }\`
  - Get all: \`GET /CarDealership/Customer\`
  - Get one: \`GET /CarDealership/Customer/123\`

- Workflow: \`ProcessSale\`
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

# Relationships & Embedded Tables

The UI spec contains a **\`relationships\`** array with relationship information. Use this to show related data:

## Implementation:
1. In **EntityDetail** component, when viewing a parent entity (e.g., \`Dealer\`):
   - Check \`relationships\` array for entries where \`parent\` matches current entity
   - For each relationship with \`ui.showInParentDetail: true\`:
     - Show an embedded table/cards section with the child entities
     - Title the section with \`displayName\`
     - Use the \`ui.listComponent\` type (table, cards, reference)
     - Enable actions based on \`ui.allowInlineEdit\`, \`ui.allowCreate\`

2. **Example:** When viewing a Dealer:
   - Show "Dealer Car Models" table (from DealerCarModels relationship)
   - Show "Dealer Sales" table (from DealerSales relationship)
   - Show "Dealer Inventory" table (from DealerInventory relationship)

3. **Fetching related data:**
   - Use relationship info to make additional API calls
   - Example: \`GET /CarDealership/CarModel?dealerId=<dealer-id>\` (add query params)

4. **Relationship types:**
   - \`contains\`: Parent owns children (1:many)
   - \`between\`: Association/reference (many:many or reference)

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
   - **.env** - Backend URL configuration
   - **.env.example** - Environment template
   - **.gitignore**
   - **README.md** - Setup instructions with backend config

## 2. API Layer
   - **src/api/client.ts** - Axios client with .env integration
   - **src/api/endpoints.ts** - Agentlang endpoint functions following /<ModelName>/<Entity> pattern

## 3. Core Application
   - **src/main.tsx** - Entry point
   - **src/App.tsx** - Routing with /:modelName/:entityName pattern
   - **src/index.css** - Global styles

## 4. Types
   - **src/types/index.ts** - TypeScript interfaces for all entities and workflows

## 5. Data
   - **src/data/uiSpec.ts** - Export UI spec
   - **src/data/mockData.ts** - Mock data for when backend is unavailable

## 6. Authentication
   - **src/components/auth/SignIn.tsx**
   - **src/components/auth/SignUp.tsx**

## 7. Navigation
   - **src/components/navigation/Sidebar.tsx** - With grouping from UI spec
   - **src/components/navigation/Navbar.tsx**

## 8. Entity Management (Generic & Reusable)
   - **src/components/entity/EntityList.tsx** - Lists with Agentlang API integration
   - **src/components/entity/EntityDetail.tsx** - Details with relationship sections
   - **src/components/entity/EntityForm.tsx** - Forms using Formik
   - **src/components/entity/RelationshipSection.tsx** - Embedded tables for relationships

## 9. Workflows
   - **src/components/workflows/WorkflowButton.tsx** - Workflow action button
   - **src/components/workflows/WorkflowDialog.tsx** - Workflow input form/dialog

## 10. Dashboard
   - **src/components/dashboard/Dashboard.tsx**
   - **src/components/dashboard/StatCard.tsx**
   - **src/components/dashboard/ChartWidget.tsx**

## 11. Context
   - **src/context/AuthContext.tsx**

## 12. Hooks
   - **src/hooks/useEntityData.ts** - Entity CRUD operations
   - **src/hooks/useBackend.ts** - Backend connection checking
   - **src/hooks/useRelationships.ts** - Fetch related entity data

## 13. Utils
   - **src/utils/validation.ts**
   - **src/utils/routeParser.ts** - Parse Agentlang routes

# Implementation Requirements

✅ **Agentlang Routing**: Use /:modelName/:entityName format everywhere
✅ **Backend Integration**: Read .env for backend URL, fallback to mock data
✅ **API Pattern**: All requests follow /<ModelName>/<Entity> convention
✅ **Relationships**: Show embedded tables based on relationships array
✅ **Workflows**: Display and execute workflows as custom actions on entity pages
✅ **TypeScript**: Proper typing for all components
✅ **Error Handling**: Handle backend unavailable gracefully
✅ **Loading States**: Show spinners during API calls
✅ **Responsive**: Mobile-friendly design

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

# Process

1. Create the project directory structure
2. Generate configuration files (.env, .env.example, package.json, tsconfig, vite.config, etc.)
   - IMPORTANT: In package.json, use "agentlang-ui" as the package name
   - In index.html, use "${uiSpec.appInfo.title}" as the title
3. Generate API layer (client.ts, endpoints.ts) with Agentlang integration
4. Generate types and data files
5. Generate hooks (useBackend, useEntityData, useRelationships)
6. Generate components (auth, navigation, entity, workflows, dashboard)
7. Generate App.tsx with Agentlang routing (/:modelName/:entityName)
8. Generate main.tsx and index.css
9. Generate README with setup instructions

START NOW! Use whatever tools you need to generate the complete application.`;
}
