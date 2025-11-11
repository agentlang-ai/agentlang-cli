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
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

// Check if an Agentlang app is already initialized
function isAppInitialized(targetDir: string): boolean {
  const packageJsonPath = join(targetDir, 'package.json');
  const hasPackageJson = existsSync(packageJsonPath);
  const hasAgentlangFiles = findAgentlangFiles(targetDir).length > 0;
  return hasPackageJson || hasAgentlangFiles;
}

// Initialize a new Agentlang application
export const initCommand = (appName: string): void => {
  const currentDir = process.cwd();
  const targetDir = join(currentDir, appName);

  // Check if already initialized
  if (isAppInitialized(targetDir)) {
    // eslint-disable-next-line no-console
    console.log(chalk.yellow('⚠️  This directory already contains an Agentlang application.'));
    // eslint-disable-next-line no-console
    console.log(chalk.dim('   Found existing package.json or .al files.'));
    // eslint-disable-next-line no-console
    console.log(chalk.dim('   No initialization needed.'));
    return;
  }

  try {
    // eslint-disable-next-line no-console
    console.log(chalk.cyan(`🚀 Initializing Agentlang application: ${chalk.bold(appName)}\n`));

    mkdirSync(targetDir);

    // Create package.json
    const packageJson = {
      name: appName,
      version: '0.0.1',
    };
    writeFileSync(join(targetDir, 'package.json'), JSON.stringify(packageJson, null, 2), 'utf-8');
    // eslint-disable-next-line no-console
    console.log(`${chalk.green('✓')} Created ${chalk.cyan('package.json')}`);

    const config = { service: { port: 8080 } };

    // Create config.al
    writeFileSync(join(targetDir, 'config.al'), JSON.stringify(config, null, 2), 'utf-8');
    // eslint-disable-next-line no-console
    console.log(`${chalk.green('✓')} Created ${chalk.cyan('config.al')}`);

    // Create src directory
    const srcDir = join(targetDir, 'src');
    mkdirSync(srcDir, { recursive: true });

    // Create src/core.al
    const coreContent = `module ${appName}.core`;
    writeFileSync(join(srcDir, 'core.al'), coreContent, 'utf-8');
    // eslint-disable-next-line no-console
    console.log(`${chalk.green('✓')} Created ${chalk.cyan('src/core.al')}`);

    // eslint-disable-next-line no-console
    console.log(chalk.green('\n✨ Successfully initialized Agentlang application!'));
    // eslint-disable-next-line no-console
    console.log(chalk.dim('\nNext steps:'));
    // eslint-disable-next-line no-console
    console.log(chalk.dim('  1. Add your application logic to src/core.al'));
    // eslint-disable-next-line no-console
    console.log(chalk.dim('  2. Run your app with: ') + chalk.cyan('agent run'));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(chalk.red('❌ Error initializing application:'), error instanceof Error ? error.message : error);
    process.exit(1);
  }
};

// Custom help formatter
function customHelp(): string {
  const gradient = [chalk.hex('#00D9FF'), chalk.hex('#00C4E6'), chalk.hex('#00AFCC'), chalk.hex('#009AB3')];

  const header = `
  ${gradient[0]('█████╗')} ${gradient[1]('  ██████╗')} ${gradient[2]('███████╗')}${gradient[3]('███╗   ██╗')}${gradient[0]('████████╗')}
  ${gradient[0]('██╔══██╗')}${gradient[1]('██╔════╝')} ${gradient[2]('██╔════╝')}${gradient[3]('████╗  ██║')}${gradient[0]('╚══██╔══╝')}
  ${gradient[0]('███████║')}${gradient[1]('██║  ███╗')}${gradient[2]('█████╗')}  ${gradient[3]('██╔██╗ ██║')}${gradient[0]('   ██║')}
  ${gradient[0]('██╔══██║')}${gradient[1]('██║   ██║')}${gradient[2]('██╔══╝')}  ${gradient[3]('██║╚██╗██║')}${gradient[0]('   ██║')}
  ${gradient[0]('██║  ██║')}${gradient[1]('╚██████╔╝')}${gradient[2]('███████╗')}${gradient[3]('██║ ╚████║')}${gradient[0]('   ██║')}
  ${gradient[0]('╚═╝  ╚═╝')} ${gradient[1]('╚═════╝')} ${gradient[2]('╚══════╝')}${gradient[3]('╚═╝  ╚═══╝')}${gradient[0]('   ╚═╝')}

  ${chalk.bold.white('Agentlang CLI')} ${chalk.dim(`v${packageVersion}`)}
  ${chalk.dim('CLI for all things Agentlang')}
`;

  const usage = `
  ${chalk.bold.white('USAGE')}
    ${chalk.dim('$')} ${chalk.cyan('agent')} ${chalk.yellow('<command>')} ${chalk.dim('[options]')}

  ${chalk.bold.white('COMMANDS')}

    ${chalk.cyan.bold('init')} ${chalk.dim('<appname>')}
      ${chalk.white('▸')} Initialize a new Agentlang application
      ${chalk.dim('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}

    ${chalk.cyan.bold('run')} ${chalk.dim('[file]')}
      ${chalk.white('▸')} Load and execute an Agentlang module
      ${chalk.dim('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}
      ${chalk.yellow('OPTIONS')}
        ${chalk.cyan('-c, --config')} ${chalk.dim('<file>')}    Configuration file path

    ${chalk.cyan.bold('repl')} ${chalk.dim('[directory]')}
      ${chalk.white('▸')} Start interactive REPL environment
      ${chalk.dim('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}
      ${chalk.yellow('OPTIONS')}
        ${chalk.cyan('-w, --watch')}           Watch files and reload automatically
        ${chalk.cyan('-q, --quiet')}           Suppress startup messages

    ${chalk.cyan.bold('doc')} ${chalk.dim('[file]')}
      ${chalk.white('▸')} Generate API documentation (Swagger/OpenAPI)
      ${chalk.dim('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}
      ${chalk.yellow('OPTIONS')}
        ${chalk.cyan('-h, --outputHtml')} ${chalk.dim('<file>')}     Generate HTML documentation
        ${chalk.cyan('-p, --outputPostman')} ${chalk.dim('<file>')}  Generate Postman collection

    ${chalk.cyan.bold('parseAndValidate')} ${chalk.dim('<file>')}
      ${chalk.white('▸')} Parse and validate Agentlang source code
      ${chalk.dim('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}
      ${chalk.yellow('OPTIONS')}
        ${chalk.cyan('-d, --destination')} ${chalk.dim('<dir>')}  Output directory

    ${chalk.cyan.bold('ui-gen')} ${chalk.dim('[spec-file]')}
      ${chalk.white('▸')} Generate UI from specification ${chalk.dim('(requires Anthropic API key)')}
      ${chalk.dim('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')}
      ${chalk.yellow('OPTIONS')}
        ${chalk.cyan('-d, --directory')} ${chalk.dim('<dir>')}   Target directory
        ${chalk.cyan('-k, --api-key')} ${chalk.dim('<key>')}      Anthropic API key
        ${chalk.cyan('-p, --push')}               Commit and push to git
        ${chalk.cyan('-m, --message')} ${chalk.dim('<text>')}     Update instructions

  ${chalk.bold.white('GLOBAL OPTIONS')}
    ${chalk.cyan('-h, --help')}       Display help information
    ${chalk.cyan('-V, --version')}    Display version number

  ${chalk.bold.white('LEARN MORE')}
    ${chalk.white('Docs')}      ${chalk.cyan('https://github.com/agentlang/agentlang-cli')}
    ${chalk.white('Issues')}    ${chalk.cyan('https://github.com/agentlang/agentlang-cli/issues')}

  ${chalk.dim('Run')} ${chalk.cyan('agent <command> --help')} ${chalk.dim('for detailed command information')}
`;

  return header + usage;
}

export default function (): void {
  const program = new Command();

  // Configure program
  program
    .name('agent')
    .description(chalk.gray('CLI for all things Agentlang'))
    .version(packageVersion, '-V, --version', 'Display version number')
    .helpOption('-h, --help', 'Show help information')
    .helpCommand(false)
    .configureHelp({
      sortSubcommands: true,
      sortOptions: true,
    });

  // Override help display
  program.helpInformation = customHelp;

  const fileExtensions = AgentlangLanguageMetaData.fileExtensions.join(', ');

  program
    .command('init')
    .argument('<appname>', 'Name of the application to initialize')
    .description('Initialize a new Agentlang application')
    .addHelpText(
      'after',
      `
${chalk.bold.white('DESCRIPTION')}
  Creates a new Agentlang application with the necessary project structure.
  This command will create:
    • package.json with your app name and version
    • config.al for application configuration
    • src/core.al with your application module

  The command checks if the directory is already initialized by looking for
  existing package.json or .al files (excluding config.al).

${chalk.bold.white('EXAMPLES')}
  ${chalk.dim('Initialize a new app called CarDealership')}
  ${chalk.dim('$')} ${chalk.cyan('agent init CarDealership')}

  ${chalk.dim('Initialize a new e-commerce app')}
  ${chalk.dim('$')} ${chalk.cyan('agent init MyShop')}

  ${chalk.dim('Initialize with multiple words (use PascalCase)')}
  ${chalk.dim('$')} ${chalk.cyan('agent init InventoryManagement')}
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
${chalk.bold.white('DESCRIPTION')}
  Loads and executes an Agentlang module, starting the runtime environment
  and initializing all configured services, databases, and integrations.

${chalk.bold.white('EXAMPLES')}
  ${chalk.dim('Run module in current directory')}
  ${chalk.dim('$')} ${chalk.cyan('agent run')}

  ${chalk.dim('Run specific module file')}
  ${chalk.dim('$')} ${chalk.cyan('agent run ./my-app/main.al')}

  ${chalk.dim('Run with custom configuration')}
  ${chalk.dim('$')} ${chalk.cyan('agent run ./my-app -c config.json')}

  ${chalk.dim('Run module from specific directory')}
  ${chalk.dim('$')} ${chalk.cyan('agent run ~/projects/erp-system')}
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
${chalk.bold.white('DESCRIPTION')}
  Starts an interactive Read-Eval-Print Loop (REPL) environment for
  Agentlang, allowing you to execute code interactively, test functions,
  and explore your application in real-time.

${chalk.bold.white('EXAMPLES')}
  ${chalk.dim('Start REPL in current directory')}
  ${chalk.dim('$')} ${chalk.cyan('agent repl')}

  ${chalk.dim('Start REPL in specific directory')}
  ${chalk.dim('$')} ${chalk.cyan('agent repl ./my-app')}

  ${chalk.dim('Start with file watching enabled')}
  ${chalk.dim('$')} ${chalk.cyan('agent repl --watch')}

  ${chalk.dim('Start in quiet mode (no startup messages)')}
  ${chalk.dim('$')} ${chalk.cyan('agent repl --quiet')}

  ${chalk.dim('Combine options for development workflow')}
  ${chalk.dim('$')} ${chalk.cyan('agent repl . --watch')}
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
${chalk.bold.white('DESCRIPTION')}
  Generates comprehensive API documentation from your Agentlang module
  in Swagger/OpenAPI format. Supports both HTML and Postman collection
  output formats for easy API exploration and testing.

${chalk.bold.white('EXAMPLES')}
  ${chalk.dim('Generate OpenAPI spec (outputs to console)')}
  ${chalk.dim('$')} ${chalk.cyan('agent doc')}

  ${chalk.dim('Generate HTML documentation')}
  ${chalk.dim('$')} ${chalk.cyan('agent doc --outputHtml api-docs.html')}

  ${chalk.dim('Generate Postman collection')}
  ${chalk.dim('$')} ${chalk.cyan('agent doc --outputPostman collection.json')}

  ${chalk.dim('Generate both HTML and Postman')}
  ${chalk.dim('$')} ${chalk.cyan('agent doc -h docs.html -p collection.json')}

  ${chalk.dim('Generate docs for specific module')}
  ${chalk.dim('$')} ${chalk.cyan('agent doc ./my-api -h api.html')}
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
${chalk.bold.white('DESCRIPTION')}
  Parses and validates an Agentlang source file, checking for syntax
  errors, lexer issues, and semantic validation problems. Useful for
  CI/CD pipelines and pre-deployment validation.

${chalk.bold.white('EXAMPLES')}
  ${chalk.dim('Validate a source file')}
  ${chalk.dim('$')} ${chalk.cyan('agent parseAndValidate ./src/main.al')}

  ${chalk.dim('Parse and validate with output directory')}
  ${chalk.dim('$')} ${chalk.cyan('agent parseAndValidate main.al -d ./out')}

  ${chalk.dim('Validate in CI/CD pipeline')}
  ${chalk.dim('$')} ${chalk.cyan('agent parseAndValidate app.al && npm run deploy')}
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
${chalk.bold.white('DESCRIPTION')}
  Generates a complete UI application from a ui-spec.json specification
  using AI. Supports incremental updates, allowing you to evolve your UI
  over time with natural language instructions.

${chalk.yellow.bold('API KEY REQUIRED')}
  Set ${chalk.cyan('ANTHROPIC_API_KEY')} environment variable or use ${chalk.cyan('--api-key')} flag
  ${chalk.dim('Get your key at: https://console.anthropic.com')}

${chalk.bold.white('EXAMPLES')}
  ${chalk.dim('Generate UI with auto-detected spec')}
  ${chalk.dim('$')} ${chalk.cyan('agent ui-gen')}

  ${chalk.dim('Generate from specific spec file')}
  ${chalk.dim('$')} ${chalk.cyan('agent ui-gen ui-spec.json')}

  ${chalk.dim('Generate and commit to git')}
  ${chalk.dim('$')} ${chalk.cyan('agent ui-gen --push')}

  ${chalk.dim('Generate in specific directory')}
  ${chalk.dim('$')} ${chalk.cyan('agent ui-gen -d ./frontend')}

  ${chalk.dim('Update existing UI with changes')}
  ${chalk.dim('$')} ${chalk.cyan('agent ui-gen -m "Add dark mode toggle"')}

  ${chalk.dim('Incremental update with git push')}
  ${chalk.dim('$')} ${chalk.cyan('agent ui-gen -m "Fix login validation" -p')}

  ${chalk.dim('Use custom API key')}
  ${chalk.dim('$')} ${chalk.cyan('agent ui-gen --api-key sk-ant-...')}
`,
    )
    .action(generateUICommand);

  program.parse(process.argv);
}

export async function runPostInitTasks(appSpec?: ApplicationSpec, config?: Config) {
  console.log("runPostInitTasks")
  await initDatabase(config?.store);
  console.log("initDatabase");
  await runInitFunctions();
  console.log("runInitFunctions");
  await runStandaloneStatements();
  console.log("runStandaloneStatements");
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
    console.log(chalk.blue('🚀 Agentlang UI Generator\n'));

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
