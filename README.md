# Agentlang CLI

> A powerful command-line interface for building, running, and managing
> Agentlang applications

[![npm version](https://img.shields.io/npm/v/agentlangcli.svg)](https://www.npmjs.com/package/agentlangcli)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org)
[![License](https://img.shields.io/badge/License-Sustainable%20Use-blue.svg)](LICENSE)

Agentlang is a programming abstraction designed for building reliable AI Agents and Agentic apps. This CLI provides a complete toolkit for developing, testing, and deploying Agentlang applications.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
  - [init](#init)
  - [run](#run)
  - [repl](#repl)
  - [doc](#doc)
  - [parseAndValidate](#parseandvalidate)
  - [ui-gen](#ui-gen)
- [Configuration](#configuration)
- [Examples](#examples)
- [License](#license)

## Features

- **🚀 Project Initialization** - Scaffold new Agentlang applications with
  proper structure
- **▶️ Runtime Execution** - Run Agentlang programs with full runtime support
- **🔄 Interactive REPL** - Test and debug with hot-reloading support
- **✅ Validation** - Parse and validate Agentlang code for syntax and semantic
  correctness
- **📚 API Documentation** - Auto-generate OpenAPI/Swagger docs from your
  modules
- **🎨 UI Generation** - Generate complete React + TypeScript + Vite frontend
  for your agentlang app (uses Claude AI)

## Installation

### Prerequisites

- Node.js 20.0.0 or higher
- npm, pnpm, or yarn

### Global Installation

```bash
npm install -g agentlangcli
```

### Using pnpm

```bash
pnpm install -g agentlangcli
```

After installation, the `agent` command will be available globally.

## Quick Start

```bash
# 1. Initialize a new Agentlang application
agent init MyApp

# 2. Navigate to your project
cd MyApp

# 3. Add your application logic to src/core.al
# (Edit src/core.al with your entities, events, and relationships)

# 4. Run your application
agent run

# 5. Start interactive REPL with hot-reload
agent repl --watch

# 6. Generate API documentation
agent doc --outputHtml docs/api.html
```

## Commands

### init

Initialize a new Agentlang application with the necessary project structure.

```bash
agent init <appname>
```

**Arguments:**

- `<appname>` - Name of the application to initialize (required)

**What it creates:**

- `package.json` with your app name and version 0.0.1
- `config.al` for application configuration
- `src/core.al` with your application module

**Examples:**

```bash
# Initialize a car dealership application
agent init CarDealership

# Initialize an e-commerce app
agent init MyShop

# Initialize with PascalCase for multi-word names
agent init InventoryManagement
```

**Behavior:** The command intelligently checks if a directory is already
initialized by looking for existing `package.json` or `.al` files (excluding
`config.al`). If found, it skips initialization to prevent overwriting your
work.

---

### run

Load and execute an Agentlang module with full runtime support.

```bash
agent run [file]
```

**Arguments:**

- `[file]` - Path to Agentlang source file or directory (default: current
  directory)

**Options:**

- `-c, --config <file>` - Path to configuration file

**Examples:**

```bash
# Run module in current directory
agent run

# Run specific module file
agent run ./my-app/main.al

# Run with custom configuration
agent run ./my-app -c config.json

# Run module from specific directory
agent run ~/projects/erp-system
```

**What it does:** Loads and executes your Agentlang module, starting the runtime
environment and initializing all configured services, databases, and
integrations. The application will start an HTTP server (default port: 8080)
exposing REST APIs for your entities and workflows.

---

### repl

Start an interactive Read-Eval-Print Loop environment for testing and debugging.

```bash
agent repl [directory]
```

**Arguments:**

- `[directory]` - Application directory (default: current directory)

**Options:**

- `-w, --watch` - Watch for file changes and reload automatically
- `-q, --quiet` - Suppress startup messages

**Examples:**

```bash
# Start REPL in current directory
agent repl

# Start REPL in specific directory
agent repl ./my-app

# Start with file watching enabled
agent repl --watch

# Start in quiet mode
agent repl --quiet

# Combine options for development workflow
agent repl . --watch
```

**Features:**

- Execute Agentlang expressions in real-time
- Test entity operations and workflows
- Hot reload with `--watch` flag for rapid development
- Access all loaded entities and functions

---

### doc

Generate API documentation in OpenAPI/Swagger format.

```bash
agent doc [file]
```

**Arguments:**

- `[file]` - Path to Agentlang source file or directory (default: current
  directory)

**Options:**

- `-h, --outputHtml <file>` - Generate HTML documentation
- `-p, --outputPostman <file>` - Generate Postman collection

**Examples:**

```bash
# Generate OpenAPI spec (outputs to console)
agent doc

# Generate HTML documentation
agent doc --outputHtml api-docs.html

# Generate Postman collection
agent doc --outputPostman collection.json

# Generate both HTML and Postman
agent doc -h docs.html -p collection.json

# Generate docs for specific module
agent doc ./my-api -h api.html
```

**Generated Endpoints:**

For each entity in your module:

- `POST /api/{module}/{entity}` - Create entity
- `GET /api/{module}/{entity}` - List entities
- `PUT /api/{module}/{entity}/{id}` - Update entity
- `DELETE /api/{module}/{entity}/{id}` - Delete entity

For relationships:

- `POST /api/{module}/{entity}/{relationship}/{relatedEntity}` - Create related
  entity
- `GET /api/{module}/{entity}/{relationship}/{relatedEntity}` - List related
  entities
- `PUT /api/{module}/{entity}/{relationship}/{relatedEntity}/{id}` - Update
  related entity
- `DELETE /api/{module}/{entity}/{relationship}/{relatedEntity}/{id}` - Delete
  related entity

---

### parseAndValidate

Parse and validate Agentlang source code for syntax and semantic correctness.

```bash
agent parseAndValidate <file>
```

**Arguments:**

- `<file>` - Path to Agentlang source file (required)

**Options:**

- `-d, --destination <dir>` - Output directory for generated files

**Examples:**

```bash
# Validate a source file
agent parseAndValidate ./src/main.al

# Parse and validate with output directory
agent parseAndValidate main.al -d ./out

# Validate in CI/CD pipeline
agent parseAndValidate app.al && npm run deploy
```

**Use Cases:**

- Pre-deployment validation
- CI/CD pipeline integration
- Syntax checking during development

---

### ui-gen

Generate a complete React + TypeScript + Vite application from a UI
specification using Claude AI.

```bash
agent ui-gen [spec-file]
```

**Arguments:**

- `[spec-file]` - Path to ui-spec.json (auto-detects if omitted)

**Options:**

- `-d, --directory <dir>` - Target directory (default: current directory)
- `-k, --api-key <key>` - Anthropic API key (or set `ANTHROPIC_API_KEY` env var)
- `-p, --push` - Automatically commit and push changes to git
- `-m, --message <text>` - User message for incremental updates

**API Key Setup:**

You can provide the Anthropic API key in two ways:

1. **Environment variable (recommended):**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
agent ui-gen
```

2. **Command flag:**

```bash
agent ui-gen --api-key sk-ant-...
```

Get your API key at: https://console.anthropic.com

**Examples:**

```bash
# Basic usage - auto-detect spec file
agent ui-gen

# Use specific spec file
agent ui-gen ui-spec.json

# Generate with custom directory
agent ui-gen -d ./my-project

# With API key and git push
agent ui-gen ui-spec.json -k sk-ant-... -p

# Incremental update with user message
agent ui-gen -m "Add dark mode support"

# Update and push to git
agent ui-gen -m "Fix login form validation" -p
```

**Generation Modes:**

The UI generator intelligently selects the appropriate mode:

- **Fresh Generation** - No existing `ui/` directory → generates complete
  application
- **Incremental Update** - Existing `ui/` directory → adds missing files based
  on spec
- **User-Directed Update** - Using `-m` flag → makes targeted changes per
  instructions

**Generated Application Features:**

- React 18+ with TypeScript
- Vite for fast development and builds
- Authentication (login, signup, forgot password)
- Entity CRUD operations with forms and validation
- Dashboard with charts and statistics
- Relationship management between entities
- Workflow/event execution
- Responsive, mobile-friendly design
- Mock data mode for testing without backend
- Environment-based configuration

**UI Spec Format:**

The generator expects a JSON file with the following structure:

```json
{
  "appInfo": {
    "name": "my-app",
    "title": "My Application",
    "description": "Application description"
  },
  "entities": [
    {
      "name": "Customer",
      "displayName": "Customers",
      "fields": [
        {
          "name": "name",
          "type": "string",
          "required": true
        },
        {
          "name": "email",
          "type": "string",
          "required": true
        }
      ]
    }
  ],
  "relationships": [],
  "workflows": [],
  "navigation": {
    "groups": []
  }
}
```

**Authentication Endpoints:**

The generated application uses the following endpoints:

- `POST /agentlang_auth/login` - User login
- `POST /agentlang_auth/signUp` - User registration
- `POST /agentlang_auth/forgotPassword` - Password recovery

**Environment Configuration:**

Generated `.env` file:

```env
VITE_BACKEND_URL=http://localhost:8080/
VITE_USE_MOCK_DATA=true
```

By default, mock data mode is enabled for immediate testing. Set
`VITE_USE_MOCK_DATA=false` when your backend is ready.

---

## Configuration

The CLI supports configuration through a `config.al` or custom configuration
file.

### Basic Configuration

```javascript
// config.al or app.config.js
{
  "service": {
    "port": 8080
  },
  "store": {
    "type": "sqlite",
    "dbname": "myapp.db"
  }
}
```

### Database Options

#### SQLite (Default)

```javascript
{
  "store": {
    "type": "sqlite",
    "dbname": "myapp.db"  // optional, defaults to in-memory
  }
}
```

#### PostgreSQL

```javascript
{
  "store": {
    "type": "postgres",
    "host": "localhost",
    "username": "postgres",
    "password": "postgres",
    "dbname": "myapp",
    "port": 5432
  }
}
```

### Advanced Configuration

```javascript
{
  "service": {
    "port": 8080
  },
  "store": {
    "type": "postgres",
    "host": "localhost",
    "username": "postgres",
    "password": "postgres",
    "dbname": "myapp",
    "port": 5432
  },
  "graphql": {
    "enabled": true
  },
  "rbacEnabled": true,
  "auditTrail": {
    "enabled": true
  },
  "authentication": {
    "enabled": true
  }
}
```

## Examples

### Simple Agentlang Module

```agentlang
module UserManagement {
  entity User {
    id: UUID
    name: String
    email: String
    createdAt: DateTime
  }

  event UserCreated {
    userId: UUID
    timestamp: DateTime
  }
}
```

### Complete Development Workflow

```bash
# 1. Initialize a new Agentlang application
mkdir my-project && cd my-project
agent init MyApp

# 2. Navigate into the project
cd MyApp

# 3. Add your application logic to src/core.al
# (Edit src/core.al with your entities and logic)

# 4. Test interactively with REPL
agent repl --watch

# 5. Run your Agentlang application
agent run

# 6. Generate API documentation
agent doc -h ./docs/api.html

# 7. Generate UI from specification
export ANTHROPIC_API_KEY=sk-ant-...
agent ui-gen ui-spec.json -p

# 8. Navigate to generated UI and test
cd ui
npm install
npm run dev

# 9. Make iterative updates to UI
cd ..
agent ui-gen -m "Add export to CSV feature"
```

### CI/CD Integration

```bash
# In your CI/CD pipeline
agent parseAndValidate src/main.al
if [ $? -eq 0 ]; then
  echo "Validation successful"
  agent run src/main.al
else
  echo "Validation failed"
  exit 1
fi
```

### E-Commerce Example

```bash
# Initialize e-commerce app
mkdir online-store && cd online-store
agent init OnlineStore
cd OnlineStore

# Start REPL with hot-reload for development
agent repl --watch

# In another terminal, run the application
agent run

# Generate API docs
agent doc -h docs/api-docs.html -p docs/postman-collection.json

# Generate UI
agent ui-gen ui-spec.json --push
```

## File Extensions

The CLI supports Agentlang files with the following extensions:

- `.al` (recommended)
- `.agentlang`

## Error Handling

The CLI provides clear error messages for common issues:

- **Configuration Errors** - Invalid configuration files or missing required
  fields
- **Parse Errors** - Syntax errors in Agentlang code with line numbers
- **Validation Errors** - Semantic errors in Agentlang modules
- **Runtime Errors** - Errors during program execution with stack traces

## Development

### Building from Source

```bash
git clone https://github.com/agentlang/agentlang-cli.git
cd agentlang-cli
npm install
npm run build
```

### Running in Development Mode

```bash
npm run dev
```

### Running Tests

```bash
npm test
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Support

- **Documentation**:
  [GitHub Repository](https://github.com/agentlang/agentlang-cli)
- **Issues**: [GitHub Issues](https://github.com/agentlang/agentlang-cli/issues)
- **Discussions**:
  [GitHub Discussions](https://github.com/agentlang/agentlang-cli/discussions)

## License

This project is licensed under the [Sustainable Use License](LICENSE) - see the
LICENSE file for details.

---

**Made with ❤️ by the Agentlang Team**
