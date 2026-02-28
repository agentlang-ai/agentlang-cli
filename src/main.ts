import { Command } from 'commander';
import { NodeFileSystem } from 'langium/node';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import os from 'node:os';
import { simpleGit, type SimpleGit } from 'simple-git';
import { initializeProject } from './utils/projectInitializer.js';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderToString } from 'ink';
import React from 'react';
import Help from './ui/components/Help.js';
import { ui, ansi } from './ui/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let agPath = 'agentlang';
// Check if ./node_modules/agentlang exists in the current directory, add to agPath
const nodeModulesPath = path.resolve(process.cwd(), 'node_modules/agentlang');

if (existsSync(nodeModulesPath)) {
  agPath = nodeModulesPath;
}

const modAgentlangLanguageMetaData: typeof import('agentlang/out/language/generated/module.js') = await import(
  `${agPath}/out/language/generated/module.js`
);
const { AgentlangLanguageMetaData } = modAgentlangLanguageMetaData;
const modCreateAgentlangServices: typeof import('agentlang/out/language/agentlang-module.js') = await import(
  `${agPath}/out/language/agentlang-module.js`
);
const { createAgentlangServices } = modCreateAgentlangServices;
const modLoader: typeof import('agentlang/out/runtime/loader.js') = await import(`${agPath}/out/runtime/loader.js`);
const { internModule, load, loadAppConfig, extractDocument } = modLoader;
import type { ApplicationSpec } from 'agentlang/out/runtime/loader.js';
const modLogger: typeof import('agentlang/out/runtime/logger.js') = await import(`${agPath}/out/runtime/logger.js`);
const { logger } = modLogger;
import type { Config } from 'agentlang/out/runtime/state.js';
const modIntegrations: typeof import('agentlang/out/runtime/integrations.js') = await import(
  `${agPath}/out/runtime/integrations.js`
);
const { prepareIntegrations } = modIntegrations;
const modRuntime: typeof import('agentlang/out/utils/runtime.js') = await import(`${agPath}/out/utils/runtime.js`);
const { isNodeEnv } = modRuntime;
const modOpenApi: typeof import('agentlang/out/runtime/openapi.js') = await import(`${agPath}/out/runtime/openapi.js`);
const { registerOpenApiModule } = modOpenApi;
const modCli: typeof import('agentlang/out/cli/main.js') = await import(`${agPath}/out/cli/main.js`);
const { runPreInitTasks, runPostInitTasks } = modCli;

import type { Module } from 'agentlang/out/runtime/module.js';
import type { ModuleDefinition } from 'agentlang/out/language/generated/ast.js';

import { generateSwaggerDoc } from './docs.js';
import { startRepl } from './repl.js';
import { generateUI } from './ui-generator/uiGenerator.js';
import { loadUISpec } from './ui-generator/specLoader.js';
import { findSpecFile } from './ui-generator/specFinder.js';
import { startStudio } from './studio.js';
import { OpenAPIClientAxios } from 'openapi-client-axios';
import { forkApp, type ForkOptions } from './utils/forkApp.js';

// Read package.json for version
let packageVersion = '0.0.0';
try {
  const packagePath = join(__dirname, '..', 'package.json');
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8')) as { version?: string };
  packageVersion = packageJson.version || '0.0.0';
} catch {
  // Fallback to a default version
}

export interface GenerateOptions {
  destination?: string;
}

function getDefaultRepoUrl(appName: string): string {
  const username = os.userInfo().username || 'username';
  const repoName = appName.replace(/\s+/g, '');
  return `https://github.com/${username}/${repoName}.git`;
}

async function promptAndPushRepository(git: SimpleGit, appName: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    ui.dim('Skipping git push prompt (non-interactive terminal).');
    return;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const pushAnswer = (await rl.question(ansi.cyan('Would you like to push this repo now? (y/N) ')))
      .trim()
      .toLowerCase();

    if (pushAnswer !== 'y' && pushAnswer !== 'yes') {
      return;
    }

    const defaultRepoUrl = getDefaultRepoUrl(appName);
    const repoUrlInputPromise = rl.question(ansi.cyan('Repository URL: '));
    rl.write(defaultRepoUrl);

    const repoUrlInput = await repoUrlInputPromise;
    const repoUrl = repoUrlInput.trim() || defaultRepoUrl;

    const remotes = await git.getRemotes(true);
    const hasOrigin = remotes.some(remote => remote.name === 'origin');
    if (hasOrigin) {
      await git.remote(['set-url', 'origin', repoUrl]);
    } else {
      await git.addRemote('origin', repoUrl);
    }

    const currentBranch = (await git.branch()).current || 'main';
    await git.push(['-u', 'origin', currentBranch]);
    ui.step('✓', 'Pushed to', repoUrl);
  } catch (error) {
    ui.warn(`Skipped pushing repository: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    rl.close();
  }
}

// Initialize a new Agentlang application
export const initCommand = async (appName: string, options?: { prompt?: string }): Promise<void> => {
  const currentDir = process.cwd();
  const targetDir = join(currentDir, appName);

  ui.blank();
  ui.banner('Initialize App');
  ui.blank();
  ui.label('App', appName, 'cyan');
  ui.label('Location', targetDir);
  ui.blank();

  try {
    await initializeProject(targetDir, appName, {
      prompt: options?.prompt,
      silent: false,
    });

    try {
      process.chdir(targetDir);
    } catch {
      // Ignore if can't change directory
    }

    ui.blank();
    ui.divider(50);
    ui.success(`${appName} initialized successfully!`);
    ui.blank();
    ui.dim('Next steps:');
    ui.dim('  1. Add your application logic to src/core.al');
    ui.row([
      { text: '  2. Run your app with: ', dimColor: true },
      { text: 'agent run', color: 'cyan' },
    ]);
    ui.row([
      { text: '  3. Or start Studio UI with: ', dimColor: true },
      { text: 'agent studio', color: 'cyan' },
    ]);
    ui.divider(50);
    ui.blank();

    // Handle interactive git push
    const git = simpleGit(targetDir);
    if (await git.checkIsRepo()) {
      await promptAndPushRepository(git, appName);
    }

    if (options?.prompt) {
      process.exit(0);
    }
  } catch (error) {
    ui.error(`Error initializing application: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
};

export default function (): void {
  const program = new Command();

  // Configure program
  program
    .name('agent')
    .description('CLI for all things Agentlang')
    .version(packageVersion, '-V, --version', 'Display version number')
    .helpOption(false)
    .helpCommand(false)
    .configureHelp({
      sortSubcommands: true,
      sortOptions: true,
    });

  // Use ink-rendered help via renderToString
  program.helpInformation = () => {
    return renderToString(React.createElement(Help, { version: packageVersion }), {
      columns: process.stdout.columns || 80,
    });
  };

  // Add explicit help flag since we disabled the built-in one
  program.option('-h, --help', 'Show help information');
  program.on('option:help', () => {
    // eslint-disable-next-line no-console
    console.log(program.helpInformation());
    process.exit(0);
  });

  const fileExtensions = AgentlangLanguageMetaData.fileExtensions.join(', ');

  program
    .command('init')
    .argument('<appname>', 'Name of the application to initialize')
    .option('-p, --prompt <description>', 'Description or prompt for the application')
    .description('Initialize a new Agentlang application')
    .addHelpText(
      'after',
      `
${ui.format.boldWhite('DESCRIPTION')}
  Creates a new Agentlang application with the necessary project structure.
  This command will create:
    • package.json with your app name and version
    • config.al for application configuration
    • src/core.al with your application module

  The command checks if the directory is already initialized by looking for
  existing package.json or .al files (excluding config.al).

${ui.format.boldWhite('EXAMPLES')}
  ${ui.format.dim('Initialize a new app called CarDealership')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent init CarDealership')}

  ${ui.format.dim('Initialize a new e-commerce app')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent init MyShop')}

  ${ui.format.dim('Initialize with multiple words (use PascalCase)')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent init InventoryManagement')}

  ${ui.format.dim('Initialize with a description/prompt')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent init ShowroomApp --prompt "a showroom app"')}
`,
    )
    .action(initCommand);

  program
    .command('run')
    .argument('[file]', `Agentlang source file (${fileExtensions})`, '.')
    .option('-c, --config <config>', 'Path to configuration file')
    .description('Load and execute an Agentlang module')
    .addHelpText(
      'after',
      `
${ui.format.boldWhite('DESCRIPTION')}
  Loads and executes an Agentlang module, starting the runtime environment
  and initializing all configured services, databases, and integrations.

${ui.format.boldWhite('EXAMPLES')}
  ${ui.format.dim('Run module in current directory')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent run')}

  ${ui.format.dim('Run specific module file')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent run ./my-app/main.al')}

  ${ui.format.dim('Run with custom configuration')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent run ./my-app -c config.json')}

  ${ui.format.dim('Run module from specific directory')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent run ~/projects/erp-system')}
`,
    )
    .action(runModule);

  program
    .command('repl')
    .argument('[directory]', 'Application directory (defaults to current)', '.')
    .option('-w, --watch', 'Watch for file changes and reload automatically')
    .option('-q, --quiet', 'Suppress startup messages')
    .description('Start interactive REPL environment')
    .addHelpText(
      'after',
      `
${ui.format.boldWhite('DESCRIPTION')}
  Starts an interactive Read-Eval-Print Loop (REPL) environment for
  Agentlang, allowing you to execute code interactively, test functions,
  and explore your application in real-time.

${ui.format.boldWhite('EXAMPLES')}
  ${ui.format.dim('Start REPL in current directory')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent repl')}

  ${ui.format.dim('Start REPL in specific directory')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent repl ./my-app')}

  ${ui.format.dim('Start with file watching enabled')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent repl --watch')}

  ${ui.format.dim('Start in quiet mode (no startup messages)')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent repl --quiet')}

  ${ui.format.dim('Combine options for development workflow')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent repl . --watch')}
`,
    )
    .action(replCommand);

  program
    .command('doc')
    .argument('[file]', `Agentlang source file (${fileExtensions})`, '.')
    .option('-h, --outputHtml <outputHtml>', 'Generate HTML documentation')
    .option('-p, --outputPostman <outputPostman>', 'Generate Postman collection')
    .description('Generate API documentation (Swagger/OpenAPI)')
    .addHelpText(
      'after',
      `
${ui.format.boldWhite('DESCRIPTION')}
  Generates comprehensive API documentation from your Agentlang module
  in Swagger/OpenAPI format. Supports both HTML and Postman collection
  output formats for easy API exploration and testing.

${ui.format.boldWhite('EXAMPLES')}
  ${ui.format.dim('Generate OpenAPI spec (outputs to console)')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent doc')}

  ${ui.format.dim('Generate HTML documentation')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent doc --outputHtml api-docs.html')}

  ${ui.format.dim('Generate Postman collection')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent doc --outputPostman collection.json')}

  ${ui.format.dim('Generate both HTML and Postman')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent doc -h docs.html -p collection.json')}

  ${ui.format.dim('Generate docs for specific module')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent doc ./my-api -h api.html')}
`,
    )
    .action(generateDoc);

  program
    .command('parseAndValidate')
    .argument('<file>', `Agentlang source file (${fileExtensions})`)
    .option('-d, --destination <dir>', 'Output directory for generated files')
    .description('Parse and validate Agentlang source code')
    .addHelpText(
      'after',
      `
${ui.format.boldWhite('DESCRIPTION')}
  Parses and validates an Agentlang source file, checking for syntax
  errors, lexer issues, and semantic validation problems. Useful for
  CI/CD pipelines and pre-deployment validation.

${ui.format.boldWhite('EXAMPLES')}
  ${ui.format.dim('Validate a source file')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent parseAndValidate ./src/main.al')}

  ${ui.format.dim('Parse and validate with output directory')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent parseAndValidate main.al -d ./out')}

  ${ui.format.dim('Validate in CI/CD pipeline')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent parseAndValidate app.al && npm run deploy')}
`,
    )
    .action(parseAndValidate);

  program
    .command('ui-gen')
    .argument('[spec-file]', 'Path to ui-spec.json (auto-detects if omitted)')
    .option('-d, --directory <dir>', 'Target directory (default: current)', '.')
    .option('-k, --api-key <key>', 'Anthropic API key (or set ANTHROPIC_API_KEY)')
    .option('-p, --push', 'Commit and push changes to git', false)
    .option('-m, --message <message>', 'User message for incremental updates')
    .description('Generate UI from specification (requires Anthropic API key)')
    .addHelpText(
      'after',
      `
${ui.format.boldWhite('DESCRIPTION')}
  Generates a complete UI application from a ui-spec.json specification
  using AI. Supports incremental updates, allowing you to evolve your UI
  over time with natural language instructions.

${ui.format.row([{ text: 'API KEY REQUIRED', color: 'yellow', bold: true }])}
  Set ${ui.format.cyan('ANTHROPIC_API_KEY')} environment variable or use ${ui.format.cyan('--api-key')} flag
  ${ui.format.dim('Get your key at: https://console.anthropic.com')}

${ui.format.boldWhite('EXAMPLES')}
  ${ui.format.dim('Generate UI with auto-detected spec')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent ui-gen')}

  ${ui.format.dim('Generate from specific spec file')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent ui-gen ui-spec.json')}

  ${ui.format.dim('Generate and commit to git')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent ui-gen --push')}

  ${ui.format.dim('Generate in specific directory')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent ui-gen -d ./frontend')}

  ${ui.format.dim('Update existing UI with changes')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent ui-gen -m "Add dark mode toggle"')}

  ${ui.format.dim('Incremental update with git push')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent ui-gen -m "Fix login validation" -p')}

  ${ui.format.dim('Use custom API key')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent ui-gen --api-key sk-ant-...')}
`,
    )
    .action(generateUICommand);

  program
    .command('fork')
    .argument('<source>', 'Source path (local directory or git URL)')
    .argument('[name]', 'Name for the forked app (defaults to source name)')
    .option('-b, --branch <branch>', 'Git branch to clone (for git URLs)')
    .option('-u, --username <username>', 'GitHub username for authenticated access')
    .option('-t, --token <token>', 'GitHub token for authenticated access')
    .description('Fork an app from a local directory or git repository')
    .addHelpText(
      'after',
      `
${ui.format.boldWhite('DESCRIPTION')}
  Forks an Agentlang application from a source path (local directory or git URL)
  into the current workspace. The forked app will be initialized with dependencies
  installed and a fresh git repository.

${ui.format.boldWhite('EXAMPLES')}
  ${ui.format.dim('Fork from local directory')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent fork ./my-app MyForkedApp')}

  ${ui.format.dim('Fork from GitHub repository')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent fork https://github.com/user/repo.git MyApp')}

  ${ui.format.dim('Fork from GitHub with specific branch')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent fork https://github.com/user/repo.git MyApp --branch develop')}

  ${ui.format.dim('Fork private repository with authentication')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent fork https://github.com/user/repo.git MyApp -u username -t token')}

  ${ui.format.dim('Fork using git@ URL')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent fork git@github.com:user/repo.git MyApp')}
`,
    )
    .action(forkCommand);

  program
    .command('import')
    .argument('<source>', 'Source path (local directory or git URL)')
    .argument('[name]', 'Name for the imported app (defaults to source name)')
    .option('-b, --branch <branch>', 'Git branch to clone (for git URLs)')
    .option('-u, --username <username>', 'GitHub username for authenticated access')
    .option('-t, --token <token>', 'GitHub token for authenticated access')
    .description('Import an app from a local directory or git repository (alias for fork)')
    .addHelpText(
      'after',
      `
${ui.format.boldWhite('DESCRIPTION')}
  Imports an Agentlang application from a source path. This is an alias for the
  'fork' command and uses the same functionality.

${ui.format.boldWhite('EXAMPLES')}
  ${ui.format.dim('Import from local directory')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent import ./my-app MyImportedApp')}

  ${ui.format.dim('Import from GitHub repository')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent import https://github.com/user/repo.git MyApp')}
`,
    )
    .action(forkCommand);

  program
    .command('studio')
    .argument('[path]', 'Path to Agentlang project directory (default: current directory)', '.')
    .option('-p, --port <port>', 'Port to run Studio server on', '4000')
    .option('--server-only', 'Start only the backend server without opening the UI')
    .description('Start Agentlang Studio with local server')
    .addHelpText(
      'after',
      `
${ui.format.boldWhite('DESCRIPTION')}
  Starts the Agentlang Design Studio locally for your project. This command:
    • Starts the Agentlang server (via 'agent run')
    • Serves the Studio UI on a local web server
    • Provides file system access for editing your project files

  The Studio UI allows you to visually edit Agents, Data Models, and Workflows,
  with changes saved directly to your project files (.al files, package.json, etc.).

${ui.format.boldWhite('EXAMPLES')}
  ${ui.format.dim('Start Studio in current directory')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent studio')}

  ${ui.format.dim('Start Studio for specific project')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent studio ./my-project')}

  ${ui.format.dim('Start Studio on custom port')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent studio --port 5000')}

  ${ui.format.dim('Start Studio with path and custom port')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent studio ./monitoring -p 5000')}

  ${ui.format.dim('Start only the backend server (for development)')}
  ${ui.format.dim('$')} ${ui.format.cyan('agent studio --server-only')}
`,
    )
    .action(studioCommand);

  program.parse(process.argv);
}

/**
 * Parse and validate a program written in our language.
 * Verifies that no lexer or parser errors occur.
 * Implicitly also checks for validation errors while extracting the document
 *
 * @param fileName Program to validate
 */
export const parseAndValidate = async (fileName: string): Promise<void> => {
  // retrieve the services for our language
  const services = createAgentlangServices(NodeFileSystem).Agentlang;
  // extract a document for our program
  const document = await extractDocument(fileName, services);
  // extract the parse result details
  const parseResult = document.parseResult;
  // verify no lexer, parser, or general diagnostic errors show up
  if (parseResult.lexerErrors.length === 0 && parseResult.parserErrors.length === 0) {
    ui.success(`Parsed and validated ${fileName} successfully!`);
  } else {
    ui.error(`Failed to parse and validate ${fileName}!`);
  }
};

export const runModule = async (fileName: string): Promise<void> => {
  const r: boolean = await runPreInitTasks();
  if (!r) {
    throw new Error('Failed to initialize runtime');
  }
  const configDir = path.dirname(fileName) === '.' ? process.cwd() : path.resolve(process.cwd(), fileName);
  const config: Config = await loadAppConfig(configDir);
  if (config.integrations) {
    await prepareIntegrations(
      config.integrations.host,
      config.integrations.username,
      config.integrations.password,
      config.integrations.connections,
    );
  }
  if (config.openapi) {
    await loadOpenApiSpec(config.openapi);
  }
  try {
    await load(fileName, undefined, async (appSpec?: ApplicationSpec) => {
      await runPostInitTasks(appSpec, config);
    });
  } catch (err: unknown) {
    if (isNodeEnv) {
      ui.error(String(err));
    } else {
      // eslint-disable-next-line no-console
      console.error(String(err));
    }
  }
};

export const generateDoc = async (
  fileName: string,
  options?: { outputHtml?: boolean; outputPostman?: boolean },
): Promise<void> => {
  const r: boolean = await runPreInitTasks();
  if (!r) {
    throw new Error('Failed to initialize runtime');
  }
  await load(fileName, undefined, async (_appSpec?: ApplicationSpec) => {
    await generateSwaggerDoc(fileName, options);
  });
};

export const replCommand = async (
  directory?: string,
  options?: { watch?: boolean; quiet?: boolean },
): Promise<void> => {
  try {
    await startRepl(directory || '.', {
      watch: options?.watch,
      quiet: options?.quiet,
      verbose: !options?.quiet,
    });
  } catch (error) {
    ui.error(`Failed to start REPL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
};

export async function internAndRunModule(module: ModuleDefinition, appSpec?: ApplicationSpec): Promise<Module> {
  const r: boolean = await runPreInitTasks();
  if (!r) {
    throw new Error('Failed to initialize runtime');
  }
  const rm: Module = await internModule(module);
  await runPostInitTasks(appSpec);
  return rm;
}

/* eslint-disable no-console */
export const generateUICommand = async (
  specFile?: string,
  options?: { directory?: string; apiKey?: string; push?: boolean; message?: string },
): Promise<void> => {
  try {
    ui.blank();
    ui.banner('UI Generator');
    ui.blank();

    // Get API key from options or environment
    const apiKey = options?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      ui.error('Anthropic API key is required.');
      ui.warn('Set ANTHROPIC_API_KEY environment variable or use --api-key flag.');
      ui.blank();
      ui.gray('   Example:');
      ui.gray('   $ export ANTHROPIC_API_KEY=sk-ant-...');
      ui.gray('   $ agent ui-gen');
      ui.blank();
      ui.gray('   Or:');
      ui.gray('   $ agent ui-gen --api-key sk-ant-...');
      process.exit(1);
    }

    // Set target directory
    const targetDir = options?.directory || '.';
    const absoluteTargetDir = path.resolve(process.cwd(), targetDir);

    // Auto-detect spec file if not provided
    let specFilePath: string;
    if (!specFile) {
      ui.dim('Searching for UI spec file...');
      specFilePath = await findSpecFile(absoluteTargetDir);
    } else {
      specFilePath = path.resolve(process.cwd(), specFile);
    }

    // Load the UI spec
    const uiSpec = await loadUISpec(specFilePath);

    ui.label('Spec', specFilePath, 'cyan');
    ui.label('Target', absoluteTargetDir);
    ui.label('Output', path.join(absoluteTargetDir, 'ui'));
    ui.blank();

    // Generate or update the UI
    await generateUI(uiSpec, absoluteTargetDir, apiKey, options?.push || false, options?.message);

    ui.blank();
    ui.divider(50);
    ui.success('UI generation completed!');
    ui.divider(50);
    ui.blank();
  } catch (error) {
    ui.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};
/* eslint-enable no-console */

/* eslint-disable no-console */
export const studioCommand = async (
  projectPath?: string,
  options?: { port?: string; serverOnly?: boolean },
): Promise<void> => {
  try {
    const port = parseInt(options?.port || '4000', 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      ui.error('Invalid port number. Port must be between 1 and 65535.');
      process.exit(1);
    }
    await startStudio(projectPath || '.', port, options?.serverOnly);
  } catch (error) {
    ui.error(`Failed to start Studio: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
};
/* eslint-enable no-console */

/* eslint-disable no-console */
export const forkCommand = async (
  source: string,
  name?: string,
  options?: { branch?: string; username?: string; token?: string },
): Promise<void> => {
  try {
    // Determine destination name
    let appName = name;
    if (!appName) {
      if (source.startsWith('http') || source.startsWith('git@')) {
        const parts = source.split('/');
        const lastPart = parts[parts.length - 1].replace('.git', '');
        appName = lastPart;
      } else {
        appName = path.basename(path.resolve(source));
      }
    }

    // Determine destination path (current directory)
    const destPath = path.resolve(process.cwd(), appName);

    // Build fork options
    const forkOptions: ForkOptions = {};
    if (options?.branch) {
      forkOptions.branch = options.branch;
    }
    if (options?.username && options?.token) {
      forkOptions.credentials = {
        username: options.username,
        token: options.token,
      };
    }

    ui.blank();
    ui.banner('Fork App');
    ui.blank();
    ui.label('Source', source, 'cyan');
    ui.label('Destination', destPath);
    if (options?.branch) {
      ui.label('Branch', options.branch, 'cyan');
    }
    if (forkOptions.credentials) {
      ui.label('Auth', forkOptions.credentials.username, 'cyan');
    }
    ui.blank();

    // Perform the fork
    const result = await forkApp(source, destPath, forkOptions);

    ui.divider(50);
    ui.success(`Forked "${result.name}" successfully!`);
    ui.blank();
    ui.dim('Next steps:');
    ui.row([
      { text: '  1. Change directory: ', dimColor: true },
      { text: `cd ${result.name}`, color: 'cyan' },
    ]);
    ui.row([
      { text: '  2. Run your app: ', dimColor: true },
      { text: 'agent run', color: 'cyan' },
    ]);
    ui.row([
      { text: '  3. Or start Studio: ', dimColor: true },
      { text: 'agent studio', color: 'cyan' },
    ]);
    ui.divider(50);
    ui.blank();
  } catch (error) {
    ui.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};
/* eslint-enable no-console */

interface OpenApiConfigItem {
  name: string;
  specUrl: string;
  baseUrl?: string;
}

async function loadOpenApiSpec(openApiConfig: OpenApiConfigItem[]) {
  for (const cfg of openApiConfig) {
    const api = new OpenAPIClientAxios({ definition: cfg.specUrl });
    await api.init();
    const client = await api.getClient();
    client.defaults.baseURL = cfg.baseUrl ?? cfg.specUrl.substring(0, cfg.specUrl.lastIndexOf('/'));
    // Type assertion needed because openapi-client-axios is installed in both
    // agentlang-cli and agentlang node_modules, causing TypeScript to see them as incompatible

    const n = await registerOpenApiModule(cfg.name, { api, client });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    logger.info(`OpenAPI module '${n}' registered`);
  }
}
