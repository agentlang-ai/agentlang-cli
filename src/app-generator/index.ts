import { initDatabase } from 'agentlang/out/runtime/resolvers/sqldb/database.js';
import { runInitFunctions } from 'agentlang/out/runtime/util.js';
import { evaluateAsEvent } from 'agentlang/out/runtime/interpreter.js';
import { setLocalEnv } from 'agentlang/out/runtime/auth/defs.js';
import { BUILDER_MODULE_DEFINITION } from '@agentlang/agentgen';
import { runStandaloneStatements, parseAndIntern, loadAppConfig } from 'agentlang/src/runtime/loader';
import { runPreInitTasks } from 'agentlang/src/cli/main';

export const generateApp = async (prompt: string, appName: string): Promise<string> => {
  await runPreInitTasks();

  if (!process.env.ANTHROPIC_API_KEY) {
    // eslint-disable-next-line no-console
    console.error('Environment variable ANTHROPIC_API_KEY must be set');
    throw new Error('ANTHROPIC_API_KEY environment variable is required for AI-based app generation');
  }

  setLocalEnv('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY || '');

  let generatedSchema;
  try {
    // Load the AgentCraft module definition
    await parseAndIntern(BUILDER_MODULE_DEFINITION as string);

    // Load LLM configurations from agentgen BEFORE initializing database
    const agentgenModule = await import('@agentlang/agentgen');
    /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const configContent = (agentgenModule as any).getAgentCraftConfigContent() as string | Record<string, unknown>;
    /* eslint-enable @typescript-eslint/no-explicit-any */
    /* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
    const configString = typeof configContent === 'string' ? configContent : JSON.stringify(configContent);
    await loadAppConfig(configString);

    // Now initialize database and run init functions
    await initDatabase(undefined);
    await runInitFunctions();
    await runStandaloneStatements();

    // Include the appName in the requirements so the AI workflow preserves it
    const requirementsWithAppName = `IMPORTANT: You MUST use the exact module name "${appName}.Core" (preserve the exact casing). ${prompt}`;
    generatedSchema = await evaluateAsEvent('AgentCraft', 'generateAgentlang', {
      requirements: requirementsWithAppName,
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (generatedSchema['code']) return generatedSchema['code'] as string;
    else throw new Error('Failed to generate app');
  } catch (error: unknown) {
    // eslint-disable-next-line no-console
    console.error('Error generating app:', error);
    // eslint-disable-next-line no-console
    console.log('Something went wrong generating the app, try again with a different prompt');
    process.exit(1);
  }
  return '';
};
