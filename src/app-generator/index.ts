import { initDatabase } from 'agentlang/out/runtime/resolvers/sqldb/database.js';
import { runInitFunctions } from 'agentlang/out/runtime/util.js';
import { evaluateAsEvent } from 'agentlang/out/runtime/interpreter.js';
import { setLocalEnv } from 'agentlang/out/runtime/auth/defs.js';
import { BUILDER_MODULE_DEFINITION } from '@agentlang/agentgen';
import { runStandaloneStatements, parseAndIntern } from 'agentlang/src/runtime/loader';
import { runPreInitTasks } from 'agentlang/src/cli/main';

export const generateApp = async (prompt: string): Promise<string> => {
  await runPreInitTasks();

  if (!process.env.ANTHROPIC_API_KEY) {
    // eslint-disable-next-line no-console
    console.log('Environment variable ANTHROPIC_API_KEY must be set');
  }
  setLocalEnv('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY || '');

  let generatedSchema;
  try {
    await parseAndIntern(BUILDER_MODULE_DEFINITION as string);
    await initDatabase(undefined);
    await runInitFunctions();
    await runStandaloneStatements();
    generatedSchema = await evaluateAsEvent('AgentCraft', 'generateAgentlang', { requirements: prompt });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (generatedSchema['code']) return generatedSchema['code'] as string;
    else throw new Error('Failed to generate app');
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (error: unknown) {
    // eslint-disable-next-line no-console
    console.log('Something went wrong generating the app, try again with a different prompt');
    process.exit(1);
  }
  return '';
};
