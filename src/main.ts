import chalk from 'chalk';
import { Command } from 'commander';
import { AgentlangLanguageMetaData } from 'agentlang/out/language/generated/module.js';
import { createAgentlangServices } from 'agentlang/out/language/agentlang-module.js';
import {
  ApplicationSpec,
  internModule,
  load,
  loadAppConfig,
  runPostInitTasks,
  runPreInitTasks,
} from 'agentlang/out/runtime/loader.js';
import { NodeFileSystem } from 'langium/node';
import { extractDocument } from 'agentlang/out/runtime/loader.js';
import * as path from 'node:path';
import { logger } from 'agentlang/out/runtime/logger.js';
import { Module } from 'agentlang/out/runtime/module.js';
import { ModuleDefinition } from 'agentlang/out/language/generated/ast.js';
import { generateSwaggerDoc } from './docs.js';
import { startRepl } from './repl.js';
import { Config } from 'agentlang/out/runtime/state.js';
import { prepareIntegrations } from 'agentlang/out/runtime/integrations.js';
import { isNodeEnv } from 'agentlang/out/utils/runtime.js';
import { OpenAPIClientAxios } from 'openapi-client-axios';
import { registerOpenApiModule } from 'agentlang/out/runtime/openapi.js';

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
    // eslint-disable-next-line no-console
    console.log(chalk.green(`Parsed and validated ${fileName} successfully!`));
  } else {
    // eslint-disable-next-line no-console
    console.log(chalk.red(`Failed to parse and validate ${fileName}!`));
  }
};

export const runModule = async (fileName: string): Promise<void> => {
  const configDir =
    path.dirname(fileName) === '.' ? process.cwd() : path.resolve(process.cwd(), fileName);
  const config: Config = await loadAppConfig(configDir);
  if (config.integrations) {
    await prepareIntegrations(
      config.integrations.host,
      config.integrations.username,
      config.integrations.password,
      config.integrations.connections
    );
  }
  if (config.openapi) {
    await loadOpenApiSpec(config.openapi);
  }
  try {
    await load(fileName, undefined, async (appSpec?: ApplicationSpec) => {
      await runPostInitTasks(appSpec, config);
    });
  } catch (err: any) {
    if (isNodeEnv && chalk) {
      console.error(chalk.red(err));
    } else {
      console.error(err);
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


async function loadOpenApiSpec(openApiConfig: any[]) {
  for (let i = 0; i < openApiConfig.length; ++i) {
    const cfg: any = openApiConfig[i];
    const api = new OpenAPIClientAxios({ definition: cfg.specUrl });
    await api.init();
    const client = await api.getClient();
    client.defaults.baseURL = cfg.baseUrl
      ? cfg.baseUrl
      : cfg.specUrl.substring(0, cfg.specUrl.lastIndexOf('/'));
    const n = await registerOpenApiModule(cfg.name, { api: api, client: client });
    logger.info(`OpenAPI module '${n}' registered`);
  }
}
