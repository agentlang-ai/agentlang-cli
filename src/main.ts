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
import { z } from 'zod';
import { Config, setAppConfig } from 'agentlang/out/runtime/state.js';

export type GenerateOptions = {
  destination?: string;
};

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
    console.log(chalk.green(`Parsed and validated ${fileName} successfully!`));
  } else {
    console.log(chalk.red(`Failed to parse and validate ${fileName}!`));
  }
};

export async function runPreInitTasks(): Promise<boolean> {
  let result: boolean = true;
  await loadCoreModules().catch((reason: any) => {
    const msg = `Failed to load core modules - ${reason.toString()}`;
    logger.error(msg);
    console.log(chalk.red(msg));
    result = false;
  });
  return result;
}

export async function runPostInitTasks(appSpec?: ApplicationSpec, config?: Config) {
  await initDatabase(config?.store);
  await runInitFunctions();
  await runStandaloneStatements();
  if (appSpec) startServer(appSpec, config?.service?.port || 8080);
}

export const runModule = async (fileName: string): Promise<void> => {
  const configDir =
    fileName === '.' ? process.cwd() : path.resolve(process.cwd(), fileName);

  let config: Config | undefined;

  try {
    let cfg = await loadRawConfig(`${configDir}/app.config.json`);

    const envAppConfig = process.env.APP_CONFIG;
    if (envAppConfig) {
      const envConfig = JSON.parse(envAppConfig)
      cfg = { ...cfg, ...envConfig };
    }
    
    config = setAppConfig(cfg);
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.log(chalk.red('Config validation failed:'));
      err.errors.forEach((error, index) => {
        console.log(chalk.red(`  ${index + 1}. ${error.path.join('.')}: ${error.message}`));
      });
    } else {
      console.log(`Config loading failed: ${err}`);
    }
  }

  const r: boolean = await runPreInitTasks();
  if (!r) {
    throw new Error('Failed to initialize runtime');
  }
  await load(fileName, undefined, async (appSpec?: ApplicationSpec) => {
    await runPostInitTasks(appSpec, config);
  });
};

export const generateDoc = async (fileName: string, options?: { outputHtml?: boolean; outputPostman?: boolean }): Promise<void> => {
  const r: boolean = await runPreInitTasks();
  if (!r) {
    throw new Error('Failed to initialize runtime');
  }
  await load(fileName, undefined, async (appSpec?: ApplicationSpec) => {
    await generateSwaggerDoc(fileName, options);
  });
};

export async function internAndRunModule(
  module: ModuleDefinition,
  appSpec?: ApplicationSpec
): Promise<Module> {
  const r: boolean = await runPreInitTasks();
  if (!r) {
    throw new Error('Failed to initialize runtime');
  }
  const rm: Module = await internModule(module);
  await runPostInitTasks(appSpec);
  return rm;
}
