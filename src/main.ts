import chalk from 'chalk';
import { Command } from 'commander';
import { AgentlangLanguageMetaData } from 'agentlang/out/language/generated/module.js';
import { createAgentlangServices } from 'agentlang/out/language/agentlang-module.js';
import {
  ApplicationSpec,
  internModule,
  load,
  loadAppConfig,
  loadCoreModules,
  runStandaloneStatements,
} from 'agentlang/out/runtime/loader.js';
import { NodeFileSystem } from 'langium/node';
import { extractDocument } from 'agentlang/out/runtime/loader.js';
import * as path from 'node:path';
import { logger } from 'agentlang/out/runtime/logger.js';
import { Module } from 'agentlang/out/runtime/module.js';
import { ModuleDefinition } from 'agentlang/out/language/generated/ast.js';
import { generateSwaggerDoc } from './docs.js';
import { startRepl } from './repl.js';
import { generateUI } from './ui-generator/uiGenerator.js';
import { loadUISpec } from './ui-generator/specLoader.js';
import { findSpecFile } from './ui-generator/specFinder.js';
import { Config } from 'agentlang/out/runtime/state.js';
import { prepareIntegrations } from 'agentlang/out/runtime/integrations.js';
import { isNodeEnv } from 'agentlang/out/utils/runtime.js';
import { OpenAPIClientAxios } from 'openapi-client-axios';
import { registerOpenApiModule } from 'agentlang/out/runtime/openapi.js';
import { initDatabase } from 'agentlang/out/runtime/resolvers/sqldb/database.js';
import { runInitFunctions } from 'agentlang/out/runtime/util.js';
import { startServer } from 'agentlang/out/api/http.js';

export interface GenerateOptions {
  destination?: string;
}

export default function (): void {
  const program = new Command();

  const fileExtensions = AgentlangLanguageMetaData.fileExtensions.join(', ');

  program
    .command('run')
    .argument('[file]', `source file (possible file extensions: ${fileExtensions})`, '.')
    .option('-c, --config <config>', 'configuration file')
    .description('Loads and runs an agentlang module')
    .action(runModule);

  program
    .command('parseAndValidate')
    .argument('<file>', `source file (possible file extensions: ${fileExtensions})`)
    .option('-d, --destination <dir>', 'destination directory of generating')
    .description('Parses and validates an Agentlang module')
    .action(parseAndValidate);

  program
    .command('doc')
    .argument('[file]', `source file (possible file extensions: ${fileExtensions})`, '.')
    .option('-h, --outputHtml <outputHtml>', 'Generate HTML documentation')
    .option('-p, --outputPostman <outputPostman>', 'Generate Postman collection')
    .description('Generate swagger documentation')
    .action(generateDoc);

  program
    .command('repl')
    .argument('[directory]', 'AgentLang application directory (defaults to current directory)')
    .option('-w, --watch', 'Watch for file changes and reload automatically')
    .option('-q, --quiet', 'Suppress startup messages')
    .description('Start an interactive AgentLang REPL (Read-Eval-Print Loop)')
    .addHelpText(
      'after',
      `
Examples:
  $ agent repl                           Start REPL in current directory
  $ agent repl ./my-app                  Start REPL and load app from ./my-app directory
  $ agent repl ~/Developer/fractl/erp    Start REPL and load app from directory
  $ agent repl . --watch                 Start REPL with file watching
  $ agent repl --quiet                   Start REPL in quiet mode`,
    )
    .action(replCommand);

  program
    .command('ui-gen')
    .description('Generate or update a UI application from a ui-spec.json file (requires Anthropic API key)')
    .argument('[spec-file]', 'Path to the ui-spec.json file (auto-detects if not provided)')
    .option('-d, --directory <dir>', 'Target directory (default: current directory)', '.')
    .option('-k, --api-key <key>', 'Anthropic API key (or set ANTHROPIC_API_KEY env var)')
    .option('-p, --push', 'Commit and push changes to git repository', false)
    .option('-m, --message <message>', 'User message for incremental updates (e.g., "Add dark mode toggle")')
    .addHelpText(
      'after',
      `
API Key Requirement:
  This command requires an Anthropic API key to function. You can provide it in two ways:
  1. Set the ANTHROPIC_API_KEY environment variable:
     $ export ANTHROPIC_API_KEY=sk-ant-...
  2. Use the --api-key flag:
     $ agent ui-gen --api-key sk-ant-...

Spec File Auto-Detection:
  If no spec file path is provided, the command will search for spec files in this order:
  - ui-spec.json
  - spec.json
  - *.ui-spec.json (any file ending with .ui-spec.json)

Incremental Updates:
  If the ui/ directory already exists, the generator will intelligently update it:
  - Adds missing files based on the spec
  - Updates existing files if needed
  - Preserves custom changes when possible

  Use --message to provide specific update instructions:
  - If ui/ exists: Updates based on your message
  - If ui/ doesn't exist: Generates fresh, then applies your message

Examples:
  $ agent ui-gen                                           Auto-detect spec and generate UI
  $ agent ui-gen -p                                        Generate UI and push to git
  $ agent ui-gen -m "Add dark mode support"                Update existing UI with dark mode
  $ agent ui-gen -m "Fix the login form validation"        Update specific feature
  $ agent ui-gen ui-spec.json                              Generate from specific spec
  $ agent ui-gen -d ./my-app                               Generate in ./my-app/ui directory
  $ agent ui-gen ui-spec.json -k sk-ant-...                Generate with specified API key`,
    )
    .action(generateUICommand);

  program.parse(process.argv);
}

export async function runPostInitTasks(appSpec?: ApplicationSpec, config?: Config) {
  await initDatabase(config?.store);
  await runInitFunctions();
  await runStandaloneStatements();
  if (appSpec) startServer(appSpec, config?.service?.port || 8080);
}

export async function runPreInitTasks(): Promise<boolean> {
  let result = true;
  await loadCoreModules().catch((reason: unknown) => {
    const msg = `Failed to load core modules - ${String(reason)}`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    logger.error(msg);
    // eslint-disable-next-line no-console
    console.log(chalk.red(msg));
    result = false;
  });
  return result;
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
    // eslint-disable-next-line no-console
    console.log(chalk.green(`Parsed and validated ${fileName} successfully!`));
  } else {
    // eslint-disable-next-line no-console
    console.log(chalk.red(`Failed to parse and validate ${fileName}!`));
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
    if (isNodeEnv && chalk) {
      // eslint-disable-next-line no-console
      console.error(chalk.red(String(err)));
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
    // eslint-disable-next-line no-console
    console.log(chalk.red(`Failed to start REPL: ${error instanceof Error ? error.message : String(error)}`));
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
    console.log(chalk.blue('🚀 AgentLang UI Generator\n'));

    // Get API key from options or environment
    const apiKey = options?.apiKey || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error(chalk.red('❌ Error: Anthropic API key is required.'));
      console.log(chalk.yellow('   Set ANTHROPIC_API_KEY environment variable or use --api-key flag.'));
      console.log(chalk.gray('\n   Example:'));
      console.log(chalk.gray('   $ export ANTHROPIC_API_KEY=sk-ant-...'));
      console.log(chalk.gray('   $ agent ui-gen'));
      console.log(chalk.gray('\n   Or:'));
      console.log(chalk.gray('   $ agent ui-gen --api-key sk-ant-...'));
      process.exit(1);
    }

    // Set target directory
    const targetDir = options?.directory || '.';
    const absoluteTargetDir = path.resolve(process.cwd(), targetDir);

    // Auto-detect spec file if not provided
    let specFilePath: string;
    if (!specFile) {
      console.log(chalk.cyan('📄 Searching for UI spec file...'));
      specFilePath = await findSpecFile(absoluteTargetDir);
    } else {
      specFilePath = path.resolve(process.cwd(), specFile);
    }

    // Load the UI spec
    console.log(chalk.cyan(`📄 Loading UI spec from: ${specFilePath}`));
    const uiSpec = await loadUISpec(specFilePath);

    console.log(chalk.cyan(`📂 Target directory: ${absoluteTargetDir}`));
    console.log(chalk.cyan(`📦 Output will be created in: ${path.join(absoluteTargetDir, 'ui')}`));

    // Generate or update the UI
    await generateUI(uiSpec, absoluteTargetDir, apiKey, options?.push || false, options?.message);

    console.log(chalk.green('\n✅ UI generation completed successfully!'));
  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error instanceof Error ? error.message : error);
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
    const n = await registerOpenApiModule(cfg.name, { api, client });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    logger.info(`OpenAPI module '${n}' registered`);
  }
}
