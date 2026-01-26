import path from 'path';
import { existsSync } from 'fs';

let agPath = 'agentlang';
const nodeModulesPath = path.resolve(process.cwd(), 'node_modules/agentlang');

if (existsSync(nodeModulesPath)) {
  agPath = nodeModulesPath;
}

// We use dynamic imports to load these modules based on the resolved path
const modLoader: typeof import('agentlang/out/runtime/loader.js') = await import(`${agPath}/out/runtime/loader.js`);
export const { flushAllAndLoad } = modLoader;

const modCli: typeof import('agentlang/out/cli/main.js') = await import(`${agPath}/out/cli/main.js`);
export const { runPreInitTasks } = modCli;
