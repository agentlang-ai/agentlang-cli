import chalk from 'chalk';
import { Command } from 'commander';
import { AgentlangLanguageMetaData } from 'agentlang/out/language/generated/module.js';
import { createAgentlangServices } from 'agentlang/out/language/agentlang-module.js';
import {
  ApplicationSpec,
  internModule,
  load,
  loadCoreModules,
  loadRawConfig,
  runStandaloneStatements,
} from 'agentlang/out/runtime/loader.js';
import { NodeFileSystem } from 'langium/node';
import { extractDocument } from 'agentlang/out/runtime/loader.js';
import * as path from 'node:path';
import { startServer } from 'agentlang/out/api/http.js';
import { initDatabase } from 'agentlang/out/runtime/resolvers/sqldb/database.js';
import { logger } from 'agentlang/out/runtime/logger.js';
import { runInitFunctions } from 'agentlang/out/runtime/util.js';
import { Module } from 'agentlang/out/runtime/module.js';
import { ModuleDefinition } from 'agentlang/out/language/generated/ast.js';
import { generateSwaggerDoc } from './docs.js';
import { startRepl } from './repl.js';
import { z } from 'zod';
import { Config, setAppConfig } from 'agentlang/out/runtime/state.js';

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

export async function runPreInitTasks(): Promise<boolean> {
  let result = true;
  await loadCoreModules().catch((reason: unknown) => {
    const msg = `Failed to load core modules - ${String(reason)}`;
    if (logger && 'error' in logger && typeof (logger as { error: unknown }).error === 'function') {
      (logger as { error: (msg: string) => void }).error(msg);
    }
    // eslint-disable-next-line no-console
    console.log(chalk.red(msg));
    result = false;
  });
  return result;
}

export async function runPostInitTasks(appSpec?: ApplicationSpec, config?: Config) {
  await initDatabase(config?.store);
  await runInitFunctions();
  await runStandaloneStatements();
  if (appSpec) {
    startServer(appSpec, config?.service?.port || 8080);
    // Give server a moment to start and print its messages
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

export const runModule = async (fileName: string): Promise<void> => {
  const configDir = fileName === '.' ? process.cwd() : path.resolve(process.cwd(), fileName);

  let config: Config | undefined;

  try {
    let cfg = (await loadRawConfig(`${configDir}/app.config.json`)) as Record<string, unknown>;

    const envAppConfig = process.env.APP_CONFIG;
    if (envAppConfig) {
      const envConfig = JSON.parse(envAppConfig) as Record<string, unknown>;
      cfg = { ...cfg, ...envConfig };
    }

    config = setAppConfig(cfg as Parameters<typeof setAppConfig>[0]);
  } catch (err) {
    if (err instanceof z.ZodError) {
      // eslint-disable-next-line no-console
      console.log(chalk.red('Config validation failed:'));
      const zodError = err;
      zodError.issues.forEach((error: z.ZodIssue, index: number) => {
        // eslint-disable-next-line no-console
        console.log(chalk.red(`  ${index + 1}. ${error.path.join('.')}: ${error.message}`));
      });
    } else {
      // eslint-disable-next-line no-console
      console.log(`Config loading failed: ${String(err)}`);
    }
  }

  const r: boolean = await runPreInitTasks();
  if (!r) {
    throw new Error('Failed to initialize runtime');
  }
  await load(fileName, undefined, async (_appSpec?: ApplicationSpec) => {
    await runPostInitTasks(_appSpec, config);
  });
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
