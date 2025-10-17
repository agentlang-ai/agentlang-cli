import * as readline from 'node:readline';
import * as path from 'node:path';
import * as chokidar from 'chokidar';
import chalk from 'chalk';
import { ApplicationSpec, load, loadRawConfig, parseAndIntern } from 'agentlang/out/runtime/loader.js';
import {
  addModule,
  getActiveModuleName,
  fetchModule,
  getUserModuleNames,
  getEntity,
  addEntity,
  removeEntity,
  getRecord,
  addRecord,
  removeRecord,
  getRelationship,
  addRelationship,
  removeRelationship,
  getWorkflow,
  addWorkflow,
  removeWorkflow,
  getEvent,
  addEvent,
  removeEvent,
  removeModule,
} from 'agentlang/out/runtime/module.js';
import {
  addFromDef,
  addSchemaFromDef,
  addRelationshipFromDef,
  addWorkflowFromDef,
} from 'agentlang/out/runtime/loader.js';
import { parseModule } from 'agentlang/out/language/parser.js';
import {
  isEntityDefinition,
  isEventDefinition,
  isRecordDefinition,
  isRelationshipDefinition,
  isWorkflowDefinition,
} from 'agentlang/out/language/generated/ast.js';
import { Config, setAppConfig } from 'agentlang/out/runtime/state.js';
import { runPreInitTasks, runPostInitTasks } from './main.js';
import { lookupAllInstances, parseAndEvaluateStatement } from 'agentlang/out/runtime/interpreter.js';

export interface ReplOptions {
  watch?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  debounceMs?: number;
}

interface ReplState {
  appDir: string;
  options: ReplOptions;
  rl: readline.Interface;
  watcher?: chokidar.FSWatcher;
  isRestarting: boolean;
  isInitializing: boolean;
  appSpec?: ApplicationSpec;
  config?: Config;
}

// Global REPL state
let replState: ReplState | null = null;

// Core AgentLang processing function
async function processAgentlang(code: string): Promise<string> {
  let currentModule = getActiveModuleName();
  if (!currentModule && replState?.appSpec && 'name' in replState.appSpec) {
    currentModule = (replState.appSpec as { name: string }).name;
  }
  if (!currentModule) {
    throw new Error('No active module found. Please ensure the application is loaded.');
  }

  // For individual definitions, use a different approach to avoid module replacement
  const trimmedCode = code.trim();

  // Check if it's a simple entity, record, event, or relationship definition
  if (
    trimmedCode.startsWith('entity ') ||
    trimmedCode.startsWith('record ') ||
    trimmedCode.startsWith('event ') ||
    trimmedCode.startsWith('relationship ') ||
    trimmedCode.startsWith('workflow ')
  ) {
    try {
      // Parse the definition in a temporary module context to get the AST
      const tempModuleName = `__temp_${Date.now()}`;
      const wrappedCode = `module ${tempModuleName}\n\n${code}`;
      const parsedModule = await parseModule(wrappedCode);

      // Extract the definition from the parsed module
      if (parsedModule.defs && parsedModule.defs.length > 0) {
        const def = parsedModule.defs[0];

        // Use the appropriate specific function based on the definition type
        if (isEntityDefinition(def) || isEventDefinition(def) || isRecordDefinition(def)) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
          addSchemaFromDef(def as any, currentModule);
        } else if (isRelationshipDefinition(def)) {
          addRelationshipFromDef(def, currentModule);
        } else if (isWorkflowDefinition(def)) {
          addWorkflowFromDef(def, currentModule);
        } else {
          // Fall back to the general addFromDef for other types
          await addFromDef(def, currentModule);
        }

        return '✓ AgentLang code processed successfully';
      } else {
        throw new Error('No definitions found in parsed code');
      }
    } catch (error) {
      // If the custom approach fails, fall back to the original method
      // eslint-disable-next-line no-console
      console.warn('Custom parsing failed, falling back to original method:', error);
      await parseAndIntern(code, currentModule);
      return '✓ AgentLang code processed successfully';
    }
  } else {
    // For complex code or module-level statements, use the original approach
    await parseAndIntern(code, currentModule);
    return '✓ AgentLang code processed successfully';
  }
}

// REPL Helper Functions - Multiple syntax styles like original Deno REPL
function createReplHelpers() {
  // Template literal and function syntax for AgentLang code
  const al = function (strings: TemplateStringsArray | string, ...values: unknown[]): Promise<string> {
    if (Array.isArray(strings) && 'raw' in strings) {
      // Template literal: al`entity User { name String }`
      const code = strings.reduce((acc: string, str: string, i: number) => {
        const value = values[i];
        let valueStr = '';
        if (value !== undefined) {
          if (typeof value === 'object' && value !== null) {
            valueStr = JSON.stringify(value);
          } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            valueStr = String(value);
          } else {
            valueStr = '[object]';
          }
        }
        return acc + str + valueStr;
      }, '');
      return processAgentlang(code);
    } else if (typeof strings === 'string') {
      // Function call: al("entity User { name String }")
      return processAgentlang(strings);
    }
    throw new Error("Invalid usage of al(). Use al`code` or al('code')");
  };

  // Enhanced entity function - multiple syntax styles
  const e = function (name: string, definition?: Record<string, string> | string): Promise<string> {
    if (typeof name === 'string' && typeof definition === 'object') {
      // Object style: e("User", { name: "String", age: "Int" })
      const fields = Object.entries(definition)
        .map(([key, type]) => `  ${key} ${type}`)
        .join('\n');
      const code = `entity ${name} {\n${fields}\n}`;
      return processAgentlang(code);
    } else if (typeof name === 'string' && typeof definition === 'string') {
      // String style: e("User", "{ id String @id, name String }")
      const cleanDef = definition.trim();
      const fieldsContent =
        cleanDef.startsWith('{') && cleanDef.endsWith('}') ? cleanDef.slice(1, -1).trim() : cleanDef;
      const code = `entity ${name} { ${fieldsContent} }`;
      return processAgentlang(code);
    } else if (typeof name === 'string' && !definition) {
      // Simple style: e("User")
      const code = `entity ${name} {}`;
      return processAgentlang(code);
    }
    throw new Error("Invalid usage of e(). Use e('Name', {fields}) or e('Name', 'fields') or e('Name')");
  };

  // Record function
  const r = function (name: string, definition?: Record<string, string> | string): Promise<string> {
    if (typeof name === 'string' && typeof definition === 'object') {
      const fields = Object.entries(definition)
        .map(([key, type]) => `  ${key} ${type}`)
        .join('\n');
      const code = `record ${name} {\n${fields}\n}`;
      return processAgentlang(code);
    } else if (typeof name === 'string' && typeof definition === 'string') {
      const cleanDef = definition.trim();
      const fieldsContent =
        cleanDef.startsWith('{') && cleanDef.endsWith('}') ? cleanDef.slice(1, -1).trim() : cleanDef;
      const code = `record ${name} { ${fieldsContent} }`;
      return processAgentlang(code);
    } else if (typeof name === 'string' && !definition) {
      const code = `record ${name} {}`;
      return processAgentlang(code);
    }
    throw new Error("Invalid usage of r(). Use r('Name', {fields}) or r('Name', 'fields') or r('Name')");
  };

  // Event function
  const ev = function (name: string, definition?: Record<string, string> | string): Promise<string> {
    if (typeof name === 'string' && typeof definition === 'object') {
      const fields = Object.entries(definition)
        .map(([key, type]) => `  ${key} ${type}`)
        .join('\n');
      const code = `event ${name} {\n${fields}\n}`;
      return processAgentlang(code);
    } else if (typeof name === 'string' && typeof definition === 'string') {
      const cleanDef = definition.trim();
      const fieldsContent =
        cleanDef.startsWith('{') && cleanDef.endsWith('}') ? cleanDef.slice(1, -1).trim() : cleanDef;
      const code = `event ${name} { ${fieldsContent} }`;
      return processAgentlang(code);
    } else if (typeof name === 'string' && !definition) {
      const code = `event ${name} {}`;
      return processAgentlang(code);
    }
    throw new Error("Invalid usage of ev(). Use ev('Name', {fields}) or ev('Name', 'fields') or ev('Name')");
  };

  // Relationship function
  const rel = function (name: string, type: 'contains' | 'between', nodes: string[]): Promise<string> {
    if (nodes.length !== 2) {
      throw new Error('Relationship requires exactly 2 nodes');
    }
    const code = `relationship ${name} { ${type} [${nodes.join(', ')}] }`;
    return processAgentlang(code);
  };

  // Workflow function
  const w = function (name: string, statements?: string[]): Promise<string> {
    const stmts = statements ? statements.join('\n  ') : '';
    const code = `workflow ${name} {\n  ${stmts}\n}`;
    return processAgentlang(code);
  };

  // Instance creation helper
  const inst = async function (entityName: string, attributes: Record<string, unknown>): Promise<unknown> {
    const currentModule = getActiveModuleName();
    if (!currentModule) {
      throw new Error('No active module found');
    }

    // Helper to format values for AgentLang syntax
    const formatValue = (value: unknown): string => {
      if (typeof value === 'string') {
        return `"${value}"`;
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
      } else if (Array.isArray(value)) {
        return `[${value.map(formatValue).join(', ')}]`;
      } else if (value === null || value === undefined) {
        return 'nil';
      } else if (typeof value === 'object') {
        const entries = Object.entries(value)
          .map(([k, v]) => `${k} ${formatValue(v)}`)
          .join(', ');
        return `{${entries}}`;
      }
      // For unsupported types, use JSON.stringify as fallback
      return JSON.stringify(value) ?? 'nil';
    };

    // Build the statement string
    const fields = Object.entries(attributes)
      .map(([key, value]) => `${key} ${formatValue(value)}`)
      .join(', ');
    const statement = `{${currentModule}/${entityName} {${fields}}}`;

    // Parse and evaluate the statement
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const result = await parseAndEvaluateStatement(statement);
    return result;
  };

  // Module management object
  const m = {
    list: () => getUserModuleNames(),
    get: (name: string) => fetchModule(name),
    active: () => getActiveModuleName(),
    add: (name: string) => addModule(name),
    remove: (name: string) => removeModule(name),
  };

  // Inspection utilities
  const inspect = {
    modules: () => {
      const modules = getUserModuleNames();
      // eslint-disable-next-line no-console
      console.log(chalk.blue('📦 Available Modules:'));
      // eslint-disable-next-line no-console
      modules.forEach(mod => console.log(`  • ${mod}`));
      return modules;
    },
    entities: (moduleName?: string) => {
      const mod = moduleName ? fetchModule(moduleName) : fetchModule(getActiveModuleName());
      const entities = mod.getEntityNames();
      // eslint-disable-next-line no-console
      console.log(chalk.green(`🏗️  Entities in ${mod.name}:`));
      // eslint-disable-next-line no-console
      entities.forEach(ent => console.log(`  • ${ent}`));
      return entities;
    },
    events: (moduleName?: string) => {
      const mod = moduleName ? fetchModule(moduleName) : fetchModule(getActiveModuleName());
      const events = mod.getEventNames();
      // eslint-disable-next-line no-console
      console.log(chalk.yellow(`⚡ Events in ${mod.name}:`));
      // eslint-disable-next-line no-console
      events.forEach(evt => console.log(`  • ${evt}`));
      return events;
    },
    relationships: (moduleName?: string) => {
      const mod = moduleName ? fetchModule(moduleName) : fetchModule(getActiveModuleName());
      const rels = mod.getRelationshipNames();
      // eslint-disable-next-line no-console
      console.log(chalk.magenta(`🔗 Relationships in ${mod.name}:`));
      // eslint-disable-next-line no-console
      rels.forEach(rel => console.log(`  • ${rel}`));
      return rels;
    },
    instances: async (entityName?: string) => {
      if (!entityName) {
        throw new Error('entityName is required');
      }
      const instances = await lookupAllInstances(entityName);
      // eslint-disable-next-line no-console
      console.log(chalk.cyan(`🏭 Instances for ${entityName}:`));

      return instances;
    },
  };

  // Utility functions
  const utils = {
    help: () => {
      /* eslint-disable no-console */
      console.log(chalk.blue.bold('\n🚀 AgentLang REPL - Comprehensive Guide\n'));

      console.log(chalk.green.bold('📋 Basic Commands:'));
      console.log('  help, ?          // Show this help');
      console.log('  exit, quit       // Exit REPL');
      console.log('  clear            // Clear screen');
      console.log('  restart          // Restart REPL');

      console.log(chalk.cyan.bold('\n🏗️  Entity Creation:'));
      console.log('  e("User")                           // Empty entity');
      console.log('  e("User", {name: "String"})         // Object syntax');
      console.log('  e("User", "name String, age Int")   // String syntax');
      console.log('  entity("User", {id: "String @id"})  // Alias for e()');

      console.log(chalk.magenta.bold('\n📄 Record Creation:'));
      console.log('  r("Config")                         // Empty record');
      console.log('  r("Config", {key: "String"})        // Object syntax');
      console.log('  r("Config", "key String, val Any")  // String syntax');
      console.log('  record("Config", {settings: "Map"}) // Alias for r()');

      console.log(chalk.yellow.bold('\n⚡ Event Creation:'));
      console.log('  ev("UserCreated")                   // Empty event');
      console.log('  ev("UserCreated", {id: "String"})   // Object syntax');
      console.log('  ev("UserCreated", "id String")      // String syntax');
      console.log('  event("UserCreated", {data: "Map"}) // Alias for ev()');

      console.log(chalk.red.bold('\n🔗 Relationship Creation:'));
      console.log('  rel("UserPosts", "contains", ["User", "Post"])');
      console.log('  rel("Friendship", "between", ["User", "User"])');
      console.log('  relationship("Owns", "contains", ["User", "Asset"])');

      console.log(chalk.blue.bold('\n🔄 Workflow Creation:'));
      console.log('  w("ProcessUser")                    // Empty workflow');
      console.log('  w("ProcessUser", ["step1", "step2"]) // With steps');
      console.log('  workflow("HandleOrder", ["validate", "process"])');

      console.log(chalk.green.bold('\n🏭 Instance Creation:'));
      console.log('  inst("User", {name: "John", age: 30})');
      console.log('  instance("Post", {title: "Hello", content: "World"})');

      console.log(chalk.cyan.bold('\n📝 Template Literal Usage:'));
      console.log('  al`entity User { name String }`     // AgentLang code');
      console.log('  al`record Config { key String }`    // Multi-line supported');
      console.log('  al("entity User { name String }")   // Function syntax');
      console.log('  ag`event Created { id String }`     // Alias for al');

      console.log(chalk.magenta.bold('\n📦 Module Management (m.*):'));
      console.log('  m.active()       // Get active module name');
      console.log('  m.list()         // List all user modules');
      console.log('  m.get("MyApp")   // Get specific module');
      console.log('  m.add("NewMod")  // Add new module');
      console.log('  m.remove("Mod")  // Remove module');
      console.log('  modules.active() // Alias for m.active()');

      console.log(chalk.yellow.bold('\n🔍 Inspection Commands (inspect.*):'));
      console.log('  inspect.modules()              // List all modules');
      console.log('  inspect.entities()             // List entities in active module');
      console.log('  inspect.entities("MyApp")      // List entities in specific module');
      console.log('  inspect.events()               // List events in active module');
      console.log('  inspect.events("MyApp")        // List events in specific module');
      console.log('  inspect.relationships()        // List relationships in active module');
      console.log('  inspect.relationships("MyApp") // List relationships in specific module');
      console.log('  inspect.instances("MyApp/EntityName") // List instances created for an entity');

      console.log(
        chalk.red.bold(
          '\n🛠️  Direct Runtime Functions (requires full qualified names in string: "<ModuleName>/<Name>"):',
        ),
      );
      console.log(chalk.white('  Entity Management:'));
      console.log('    addEntity(name, definition)    // Add entity to runtime');
      console.log('    removeEntity(name)             // Remove entity from runtime');
      console.log('    getEntity(name)                // Get entity definition');

      console.log(chalk.white('  Record Management:'));
      console.log('    addRecord(name, definition)    // Add record to runtime');
      console.log('    removeRecord(name)             // Remove record from runtime');
      console.log('    getRecord(name)                // Get record definition');

      console.log(chalk.white('  Event Management:'));
      console.log('    addEvent(name, definition)     // Add event to runtime');
      console.log('    removeEvent(name)              // Remove event from runtime');
      console.log('    getEvent(name)                 // Get event definition');

      console.log(chalk.white('  Relationship Management:'));
      console.log('    addRelationship(name, def)     // Add relationship to runtime');
      console.log('    removeRelationship(name)       // Remove relationship from runtime');
      console.log('    getRelationship(name)          // Get relationship definition');

      console.log(chalk.white('  Workflow Management:'));
      console.log('    addWorkflow(name, definition)  // Add workflow to runtime');
      console.log('    removeWorkflow(name)           // Remove workflow from runtime');
      console.log('    getWorkflow(name)              // Get workflow definition');

      console.log(chalk.white('  Core Processing:'));
      console.log('    processAgentlang(code)         // Process raw AgentLang code');
      console.log('    parseAndEvaluateStatement(stmt) // Parse and evaluate AgentLang statement');
      console.log('    // Example: parseAndEvaluateStatement("{MyApp/User {id 1, name \\"Alice\\"}}");');

      console.log(chalk.gray.bold('\n🛠️  Utility Commands (utils.*):'));
      console.log('  utils.help()         // Show this help');
      console.log('  utils.clear()        // Clear screen');
      console.log('  utils.restart()      // Restart REPL');
      console.log('  utils.exit()         // Exit REPL');

      console.log(chalk.gray.bold('\n💡 Tips:'));
      console.log('  • Use tab completion for commands');
      console.log('  • Template literals support multi-line code');
      console.log('  • All functions return promises - use await if needed');
      console.log('  • File watching auto-restarts on changes (if enabled)');
      console.log('  • Use inspect.* commands to explore your application');

      console.log(chalk.blue('\n📚 Examples:'));
      console.log('  al`entity User { id String @id, name String }`');
      console.log('  inst("User", {id: "123", name: "Alice"})');
      console.log('  inspect.entities()');
      console.log('  inspect.instances(MyApp/EntityName)');
      console.log('  m.active()');
      /* eslint-enable no-console */

      return '';
    },
    clear: () => {
      // eslint-disable-next-line no-console
      console.log('\x1b[2J\x1b[0f');
      return '';
    },
    restart: async () => {
      // eslint-disable-next-line no-console
      console.log(chalk.yellow('🔄 Restarting REPL...'));
      await restartRepl();
      return '';
    },
    exit: () => {
      // eslint-disable-next-line no-console
      console.log(chalk.yellow('\n👋 Goodbye!'));
      cleanup();
      process.exit(0);
    },
  };

  return {
    al,
    ag: al, // Alias
    e,
    entity: e, // Alias
    r,
    record: r, // Alias
    ev,
    event: ev, // Alias
    rel,
    relationship: rel, // Alias
    w,
    workflow: w, // Alias
    inst,
    instance: inst, // Alias
    m,
    modules: m, // Alias
    inspect,
    utils,
    // Direct access to runtime functions
    addEntity,
    removeEntity,
    getEntity,
    addRecord,
    removeRecord,
    getRecord,
    addEvent,
    removeEvent,
    getEvent,
    addRelationship,
    removeRelationship,
    getRelationship,
    addWorkflow,
    removeWorkflow,
    getWorkflow,
    processAgentlang,
    parseAndEvaluateStatement,
  };
}

// Setup file watcher for app directory
function setupFileWatcher(appDir: string, options: ReplOptions): chokidar.FSWatcher {
  const debounceMs = options.debounceMs || 1000;
  let restartTimeout: NodeJS.Timeout;
  let isWatcherReady = false;

  const debouncedRestart = () => {
    // Only restart if watcher is ready and not in initial startup phase
    if (!isWatcherReady || !replState || replState.isRestarting || replState.isInitializing) return;

    if (restartTimeout) clearTimeout(restartTimeout);
    restartTimeout = setTimeout(() => {
      if (!replState?.isRestarting && !replState?.isInitializing) {
        void restartRepl();
      }
    }, debounceMs);
  };

  const watcher = chokidar.watch(
    [path.join(appDir, '**/*.al'), path.join(appDir, '**/*.json'), path.join(appDir, 'app.config.json')],
    {
      ignored: ['**/node_modules/**', '**/.git/**', '**/out/**', '**/dist/**'],
      persistent: true,
      ignoreInitial: true, // Ignore initial add events for existing files
    },
  );

  watcher
    .on('ready', () => {
      // Mark watcher as ready after initial scan is complete
      isWatcherReady = true;
    })
    .on('change', filePath => {
      if (!options.quiet && isWatcherReady) {
        // eslint-disable-next-line no-console
        console.log(chalk.blue(`\n📁 File changed: ${path.relative(appDir, filePath)}`));
      }
      debouncedRestart();
    })
    .on('add', filePath => {
      if (!options.quiet && isWatcherReady) {
        // eslint-disable-next-line no-console
        console.log(chalk.green(`\n📁 File added: ${path.relative(appDir, filePath)}`));
      }
      debouncedRestart();
    })
    .on('unlink', filePath => {
      if (!options.quiet && isWatcherReady) {
        // eslint-disable-next-line no-console
        console.log(chalk.red(`\n📁 File removed: ${path.relative(appDir, filePath)}`));
      }
      debouncedRestart();
    })
    .on('error', (error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(chalk.red(`Watcher error: ${String(error)}`));
    });

  return watcher;
}

// Restart REPL functionality
async function restartRepl(): Promise<void> {
  if (!replState || replState.isRestarting) return;

  replState.isRestarting = true;

  try {
    // eslint-disable-next-line no-console
    console.log(chalk.yellow('\n🔄 Restarting AgentLang REPL...'));

    // Reload the application
    if (replState.appDir) {
      await loadApplication(replState.appDir);
    }

    // eslint-disable-next-line no-console
    console.log(chalk.green('✅ REPL restarted successfully'));
    // eslint-disable-next-line no-console
    console.log(chalk.blue('💬 Ready for input\n'));
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(chalk.red(`❌ Failed to restart: ${String(error)}`));
  } finally {
    replState.isRestarting = false;
  }
}

// Load AgentLang application
async function loadApplication(appDir: string): Promise<void> {
  if (!replState) return;

  // Load configuration if available
  try {
    const configPath = path.join(appDir, 'app.config.json');
    const rawConfig = (await loadRawConfig(configPath)) as Record<string, unknown>;
    replState.config = setAppConfig(rawConfig as Parameters<typeof setAppConfig>[0]);
    // eslint-disable-next-line no-console
    console.log(chalk.blue(`📋 Loaded config from ${configPath}`));
  } catch {
    // Config is optional
    if (!replState.options.quiet) {
      // eslint-disable-next-line no-console
      console.log(chalk.yellow('⚠️  No app.config.json found, using defaults'));
    }
  }
  // Load the application
  // eslint-disable-next-line no-console
  console.log(chalk.blue(`📂 Loading application from: ${appDir}`));

  await load(appDir, undefined, async (appSpec?: ApplicationSpec) => {
    if (replState) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      replState.appSpec = appSpec;
      if (appSpec && 'name' in appSpec) {
        // eslint-disable-next-line no-console
        console.log(chalk.green(`✅ Loaded application: ${(appSpec as { name: string }).name}`));
      }
    }
    await runPostInitTasks(appSpec, replState?.config);
  });
}

// Setup signal handlers
function setupSignalHandlers(): void {
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGQUIT'];

  signals.forEach(signal => {
    process.on(signal, () => {
      // eslint-disable-next-line no-console
      console.log(chalk.yellow(`\n\n🛑 Received ${signal}, shutting down gracefully...`));
      cleanup();
      process.exit(0);
    });
  });
}

// Cleanup function
function cleanup(): void {
  if (replState) {
    // Close readline interface
    replState.rl.close();

    // Stop file watcher
    if (replState.watcher) {
      void replState.watcher.close();
    }
  }
}

// Main REPL function
export async function startRepl(appDir = '.', options: ReplOptions = {}): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(chalk.blue.bold('🚀 Starting AgentLang REPL...\n'));

  // Setup signal handlers
  setupSignalHandlers();

  // Resolve app directory
  const resolvedAppDir = path.resolve(process.cwd(), appDir);

  // Initialize REPL state
  replState = {
    appDir: resolvedAppDir,
    options,
    rl: readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: chalk.cyan('agentlang> '),
      completer: (line: string) => {
        const completions = [
          'help',
          '?',
          'exit',
          'quit',
          'clear',
          'restart',
          'al`',
          'al(',
          'e(',
          'r(',
          'ev(',
          'rel(',
          'w(',
          'inst(',
          'm.list()',
          'm.active()',
          'm.get(',
          'm.add(',
          'm.remove(',
          'inspect.modules()',
          'inspect.entities()',
          'inspect.events()',
          'inspect.relationships(',
          'inspect.instances(',
          'utils.help()',
          'utils.clear()',
          'utils.restart()',
          'utils.exit()',
          'addEntity(',
          'removeEntity(',
          'getEntity(',
          'addRecord(',
          'removeRecord(',
          'getRecord(',
          'updateRecord(',
          'queryRecords(',
          'deleteRecord(',
          'listRecords(',
          'countRecords(',
          'existsRecord(',
          'findRecord(',
          'findRecords(',
          'createRecord(',
          'upsertRecord(',
          'bulkInsert(',
          'bulkUpdate(',
          'bulkDelete(',
          'transaction(',
          'parseAndEvaluateStatement(',
          'processAgentlang(',
        ];
        const hits = completions.filter(c => c.startsWith(line));
        return [hits.length ? hits : completions, line];
      },
    }),
    isRestarting: false,
    isInitializing: true,
  };

  try {
    // Initialize AgentLang runtime
    const success = await runPreInitTasks();
    if (!success) {
      throw new Error('Failed to initialize runtime');
    }

    // Load the application if directory is specified
    if (appDir && appDir.trim() && appDir !== '.') {
      await loadApplication(resolvedAppDir);
    } else {
      // Try to load from current directory
      try {
        await loadApplication(process.cwd());
      } catch {
        // eslint-disable-next-line no-console
        console.log(chalk.blue('📂 Starting REPL without loading an application'));
        await runPostInitTasks();
      }
    }

    // eslint-disable-next-line no-console
    console.log(chalk.green('✅ AgentLang runtime initialized'));

    // Setup file watcher AFTER initial load to prevent immediate restart
    if (options.watch && appDir !== '') {
      // Give the initial load time to complete before starting watcher
      await new Promise<void>(resolve => setTimeout(resolve, 100));
      replState.watcher = setupFileWatcher(resolvedAppDir, options);
      // eslint-disable-next-line no-console
      console.log(chalk.green('👀 File watching enabled'));
    }

    // Mark initialization as complete
    replState.isInitializing = false;

    // Give any async startup messages time to complete
    await new Promise<void>(resolve => setTimeout(resolve, 50));

    // eslint-disable-next-line no-console
    console.log(chalk.blue('💬 REPL ready - type "help" for help'));
    // eslint-disable-next-line no-console
    console.log(); // Extra newline for clean prompt appearance

    // Create and expose helper functions globally
    const helpers = createReplHelpers();
    Object.assign(global, helpers);

    // Start REPL loop
    replState.rl.prompt();

    replState.rl.on('line', (input: string) => {
      void (async () => {
        const trimmed = input.trim();

        if (!trimmed) {
          replState?.rl.prompt();
          return;
        }

        try {
          // Handle special commands without parentheses
          if (trimmed === 'help' || trimmed === '?') {
            helpers.utils.help();
            replState?.rl.prompt();
            return;
          }

          if (trimmed === 'exit' || trimmed === 'quit') {
            helpers.utils.exit();
            return;
          }

          if (trimmed === 'clear') {
            helpers.utils.clear();
            replState?.rl.prompt();
            return;
          }

          if (trimmed === 'restart') {
            await helpers.utils.restart();
            replState?.rl.prompt();
            return;
          }

          // Evaluate the input in the global context with helpers
          const result = (await eval(trimmed)) as unknown;

          // Handle promises
          if (result && typeof (result as { then?: (...args: unknown[]) => unknown }).then === 'function') {
            try {
              const resolved = await (result as Promise<unknown>);
              if (resolved !== undefined && resolved !== '') {
                // eslint-disable-next-line no-console
                console.log(chalk.green('→'), resolved);
              }
            } catch (error) {
              // eslint-disable-next-line no-console
              console.error(chalk.red('Promise rejected:'), error);
            }
          } else if (result !== undefined && result !== '') {
            // eslint-disable-next-line no-console
            console.log(chalk.green('→'), result);
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(chalk.red('Error:'), error);
        }

        replState?.rl.prompt();
      })();
    });

    replState.rl.on('close', () => {
      cleanup();
      process.exit(0);
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(chalk.red('❌ Failed to start REPL:'));

    if (error instanceof Error) {
      const nodeError = error as Error & { code?: string; path?: string };
      if (nodeError.code === 'ENOENT') {
        // eslint-disable-next-line no-console
        console.error(chalk.red('File or directory not found:'), nodeError.path || 'unknown path');
        // eslint-disable-next-line no-console
        console.error(
          chalk.yellow('💡 Tip: Make sure the directory exists and contains a valid AgentLang application'),
        );
      } else if (error.message.includes('app.config.json') || error.message.includes('package.json')) {
        // eslint-disable-next-line no-console
        console.error(chalk.red('Could not find required configuration files in the specified directory'));
        // eslint-disable-next-line no-console
        console.error(chalk.yellow('💡 Tip: Make sure you are pointing to a valid AgentLang application directory'));
      } else {
        // eslint-disable-next-line no-console
        console.error(chalk.red('Error:'), error.message);
      }
    } else {
      // eslint-disable-next-line no-console
      console.error(chalk.red('Unknown error:'), error);
    }

    cleanup();
    throw error;
  }
}
