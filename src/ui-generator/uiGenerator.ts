import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { UISpec } from './specLoader.js';

/* eslint-disable no-console */
export async function generateUI(
  uiSpec: UISpec,
  outputBaseDir: string,
  apiKey: string,
  shouldPush = false,
): Promise<void> {
  const spinner = ora('Initializing UI generation with Claude Agent...').start();

  try {
    // Create output directory as 'ui' in the specified base directory
    const projectDir = path.join(outputBaseDir, 'ui');

    spinner.text = `Creating project directory: ${projectDir}`;
    await fs.ensureDir(projectDir);

    // Track generated files
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
        console.log(chalk.green(`  ✓ Created: ${args.file_path}`));
        spinner.text = `Generated: ${args.file_path}`;

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
        console.log(chalk.blue(`  📁 Created directory: ${args.dir_path}`));
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

    spinner.text = 'Starting Claude Agent...';
    console.log(chalk.gray('\n  📋 Tool Access:'));
    console.log(chalk.gray('    - Full permission mode enabled'));
    console.log(chalk.gray('    - Agent can use: Write, Read, Edit, Bash, and MCP tools'));
    console.log(chalk.green('  ✅ All tools available\n'));

    // Create the generation prompt
    const prompt = createGenerationPrompt(uiSpec);

    // Configure SDK with API key
    process.env.ANTHROPIC_API_KEY = apiKey;

    spinner.text = 'Generating application with Claude Agent...';
    console.log(chalk.cyan('\n📝 Agent is working...\n'));

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
    let lastLogTime = Date.now();

    for await (const message of session) {
      if (message.type === 'assistant') {
        // Extract text content from assistant message
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') {
              lastTextMessage = block.text;
              // Show progress every 3 seconds to avoid spam
              const now = Date.now();
              if (lastTextMessage.trim() && now - lastLogTime > 3000) {
                console.log(chalk.gray(`  💭 ${lastTextMessage.slice(0, 60)}...`));
                lastLogTime = now;
              }
            }
          }
        }
      } else if (message.type === 'result') {
        // Final result
        if (message.subtype === 'success') {
          console.log(chalk.green(`\n✓ Completed in ${message.num_turns} turns`));
          console.log(chalk.gray(`  💰 Cost: $${message.total_cost_usd.toFixed(4)}`));
        } else {
          console.log(chalk.yellow(`\n⚠ ${message.subtype}`));
        }
      }
    }

    spinner.succeed(chalk.green(`✅ Generated ${generatedFiles.length} files`));

    // Output final message
    if (lastTextMessage) {
      console.log(chalk.cyan('\n🤖 Agent final message:'));
      console.log(chalk.white(lastTextMessage));
    }

    console.log(chalk.cyan('\n📦 Project created at:'), chalk.white(projectDir));

    // Git operations if requested
    if (shouldPush) {
      await performGitOperations(projectDir, outputBaseDir);
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
async function performGitOperations(projectDir: string, repoRoot: string): Promise<void> {
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);

  console.log(chalk.cyan('\n📤 Committing and pushing changes...'));

  try {
    // Change to repo root directory
    process.chdir(repoRoot);

    // Add all files in the ui directory
    await execAsync('git add ui/');
    console.log(chalk.green('  ✓ Added ui/ to git'));

    // Commit changes
    const commitMessage = 'Add generated UI application';
    await execAsync(`git commit -m "${commitMessage}"`);
    console.log(chalk.green('  ✓ Committed changes'));

    // Push to remote
    await execAsync('git push');
    console.log(chalk.green('  ✓ Pushed to remote repository'));

    console.log(chalk.green('\n✅ Successfully pushed UI changes to repository'));
  } catch (error) {
    console.log(chalk.yellow('\n⚠ Warning: Git operations failed'));
    console.log(chalk.gray(`  ${error instanceof Error ? error.message : String(error)}`));
    console.log(chalk.yellow('  You may need to commit and push manually.'));
  }
}
/* eslint-enable no-console */

function createGenerationPrompt(uiSpec: UISpec): string {
  const referenceAppPath =
    '/home/prertik/Developer/fractl/ui-generator-from-spec/generated-apps/modern-car-dealership-management';

  return `You are a UI generation agent. Your task is to generate a complete React + TypeScript + Vite web application based on a UI specification for an Agentlang backend system.

⚠️ CRITICAL INSTRUCTIONS:
- You have FULL ACCESS to all tools: Write, Read, Edit, Bash, and MCP tools
- Use whatever tools are most appropriate for the task
- Prefer using Write tool for creating files
- Use Bash for system operations (mkdir, etc.) if needed
- You have full permission - do not ask for approval
- Generate a complete, working application

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
   - **package.json** - All dependencies
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

**Standard Tools:**
- **Write** - Create new files with content
- **Read** - Read existing files
- **Edit** - Edit existing files
- **Bash** - Run shell commands (mkdir, etc.)

**MCP Tools (optional):**
- **create_directory** - Creates a directory
- **write_file** - Writes content to a file
- **list_files** - Lists all generated files

IMPORTANT:
- Use whichever tools work best for the task
- Write tool is preferred for creating files
- Use Bash for system operations if needed
- You have full permission - do not ask for approval
- Focus on generating a complete, working application

# Process

1. Create the project directory structure
2. Generate configuration files (.env, .env.example, package.json, tsconfig, vite.config, etc.)
3. Generate API layer (client.ts, endpoints.ts) with Agentlang integration
4. Generate types and data files
5. Generate hooks (useBackend, useEntityData, useRelationships)
6. Generate components (auth, navigation, entity, workflows, dashboard)
7. Generate App.tsx with Agentlang routing (/:modelName/:entityName)
8. Generate main.tsx and index.css
9. Generate README with setup instructions

START NOW! Use whatever tools you need to generate the complete application.`;
}
