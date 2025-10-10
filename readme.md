# AgentLang CLI

A command-line interface tool for running, validating, and generating
documentation for AgentLang programs. AgentLang is a programming language
designed for building agent-based applications with built-in support for
entities, events, and relationships.

## Features

- **Initialize Projects**: Quickly scaffold new AgentLang applications with the
  proper project structure
- **Run AgentLang Programs**: Execute AgentLang modules with full runtime
  support
- **Interactive REPL**: Test and debug your code with a live REPL environment
  with hot-reloading support
- **Parse and Validate**: Check syntax and semantic correctness of AgentLang
  code
- **Generate API Documentation**: Automatically generate OpenAPI/Swagger
  documentation from your AgentLang modules
- **AI-Powered UI Generation**: Generate complete React + TypeScript + Vite
  applications from UI specifications using Claude AI
- **Database Support**: Built-in support for PostgreSQL, MySQL, and SQLite
- **Authentication**: Integration with Okta and AWS Cognito authentication
  services
- **RBAC**: Role-based access control capabilities
- **Audit Trail**: Comprehensive audit logging

## Installation

### Prerequisites

- Node.js 18+
- npm or pnpm

### Install the CLI

```bash
npm install -g agentlangcli
```

Or install locally:

```bash
npm install agentlangcli
```

You can also use npm if you prefer:

```bash
npm install -g agentlangcli
```

After installation, you can use the `agent` command:

## Usage

The AgentLang CLI provides the following commands:

### 1. Initialize a New Application

Create a new AgentLang application with the necessary project structure:

```bash
agent init <appname>
```

**Description:**

The `init` command creates a new AgentLang application with:

- `package.json` with your app name and version 0.0.1
- `config.al` for application configuration (empty object by default)
- `src/core.al` with your application module declaration

The command intelligently checks if the directory is already initialized by
looking for existing `package.json` or any `.al` files (excluding `config.al`).
If found, it will skip initialization and inform you.

**Examples:**

```bash
# Initialize a new car dealership application
agent init CarDealership
```

**Output:**

```
🚀 Initializing Agentlang application: CarDealership

✓ Created package.json
✓ Created config.al
✓ Created src/core.al

✨ Successfully initialized Agentlang application!

Next steps:
  1. Add your application logic to src/core.al
  2. Run your app with: agent run
```

### 2. Run AgentLang Programs

Execute an AgentLang module with full runtime support:

```bash
agent run <file>
```

**Options:**

- `-c, --config <config>`: Specify a custom configuration file (default:
  `app.config`)

**Example:**

```bash
agent run myapp.al
```

### 3. Parse and Validate

Check the syntax and semantic correctness of your AgentLang code:

```bash
agent parseAndValidate <file>
```

**Options:**

- `-d, --destination <dir>`: Specify destination directory for generated files

**Example:**

```bash
agent parseAndValidate myapp.al
```

### 4. Generate API Documentation

Generate OpenAPI/Swagger documentation from your AgentLang modules:

```bash
agent doc <file>
```

**Options:**

- `-h, --outputHtml <path>`: Generate HTML documentation
- `-p, --outputPostman <path>`: Generate Postman collection

**Example:**

```bash
agent doc myapp.al
agent doc myapp.al -h ./docs/api.html
agent doc myapp.al -p ./docs/postman.json
```

This will generate a `docs/openapi-docs.yml` file in your project directory.

### 5. Interactive REPL

Start an interactive Read-Eval-Print Loop for testing and debugging AgentLang
code:

```bash
agent repl [directory]
```

**Options:**

- `-w, --watch`: Watch for file changes and reload automatically
- `-q, --quiet`: Suppress startup messages

**Example:**

```bash
agent repl                    # Start REPL in current directory
agent repl ./my-app          # Start REPL for specific app
agent repl --watch           # Start with auto-reload
agent repl . --watch         # Start in current dir with auto-reload
```

The REPL provides an interactive environment where you can:

- Execute AgentLang expressions in real-time
- Test entity operations and workflows
- Hot reload with `--watch` flag for rapid development
- Access all loaded entities and functions

### 6. Generate UI from Specification

Generate a complete React + TypeScript + Vite application from a UI
specification using Claude AI:

```bash
agent ui-gen [spec-file]
```

**Options:**

- `-d, --directory <dir>`: Target directory (default: current directory)
- `-k, --api-key <key>`: Anthropic API key (or set `ANTHROPIC_API_KEY` env var)
- `-p, --push`: Automatically commit and push changes to git
- `-m, --message <message>`: User message for incremental updates

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
agent ui-gen -m "Fix login form validation" -p
```

#### API Key Setup

The UI generator requires an Anthropic API key. You can provide it in two ways:

1. Environment variable:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
agent ui-gen
```

2. Command flag:

```bash
agent ui-gen --api-key sk-ant-...
```

#### Generation Modes

The UI generator intelligently selects the appropriate mode:

- **Fresh Generation**: No existing `ui/` directory - generates complete
  application
- **Incremental Update**: Existing `ui/` directory found - adds missing files
  based on spec
- **User-Directed Update**: Using `-m` flag with existing `ui/` - makes targeted
  changes

#### Generated Application Features

The generated UI includes:

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

#### UI Spec Format

The generator expects a JSON file with structure like:

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

The generated application uses the following authentication endpoints:

- `POST /agentlang_auth/login` - User login
- `POST /agentlang_auth/signUp` - User registration
- `POST /agentlang_auth/forgotPassword` - Password recovery

#### Environment Configuration

The generated application creates a `.env` file with:

```env
VITE_BACKEND_URL=http://localhost:8080/
VITE_USE_MOCK_DATA=true
```

By default, mock data mode is enabled so you can test the UI immediately without
a backend. Set `VITE_USE_MOCK_DATA=false` when your backend is ready.

## Configuration

The CLI supports configuration through an `app.config` file (or custom config
file). The configuration supports various options:

### Basic Configuration

```javascript
// app.config.js
export default {
  service: {
    port: 8080,
  },
  store: {
    type: 'sqlite',
    dbname: 'myapp.db',
  },
};
```

### Database Configuration

#### SQLite (Default)

```javascript
{
  store: {
    type: 'sqlite',
    dbname: 'myapp.db' // optional
  }
}
```

#### PostgreSQL

```javascript
{
  store: {
    type: 'postgres',
    host: 'localhost',
    username: 'postgres',
    password: 'postgres',
    dbname: 'postgres',
    port: 5432
  }
}
```

### Advanced Configuration

```javascript
{
  service: {
    port: 8080
  },
  store: {
    type: 'postgres',
    host: 'localhost',
    username: 'postgres',
    password: 'postgres',
    dbname: 'myapp',
    port: 5432
  },
  graphql: {
    enabled: true
  },
  rbacEnabled: true,
  auditTrail: {
    enabled: true
  },
  authentication: {
    // ... auth config
  }
}
```

## API Documentation Generation

The `doc` command automatically generates OpenAPI documentation for your
AgentLang modules. It includes:

- **Entity Endpoints**: Full CRUD operations for all entities
- **Relationship Endpoints**: Nested API endpoints for entity relationships
- **Event Endpoints**: Event handling endpoints
- **Authentication**: Bearer token authentication
- **Response Schemas**: Properly typed request/response schemas

### Generated Endpoints

For each entity in your AgentLang module, the following endpoints are generated:

- `POST /api/{module}/{entity}` - Create entity
- `GET /api/{module}/{entity}` - List entities
- `PUT /api/{module}/{entity}/{id}` - Update entity
- `DELETE /api/{module}/{entity}/{id}` - Delete entity

For relationships, additional nested endpoints are generated:

- `POST /api/{module}/{entity}/{relationship}/{relatedEntity}` - Create related
  entity
- `GET /api/{module}/{entity}/{relationship}/{relatedEntity}` - List related
  entities
- `PUT /api/{module}/{entity}/{relationship}/{relatedEntity}/{id}` - Update
  related entity
- `DELETE /api/{module}/{entity}/{relationship}/{relatedEntity}/{id}` - Delete
  related entity

## File Extensions

The CLI supports AgentLang files with the following extensions:

- `.al` (default)
- `.agentlang`

## Development

### Building from Source

```bash
git clone <repository>
cd agentlang-cli/app2
npm install
npm run build
```

### Running in Development

```bash
npm run dev
```

## Error Handling

The CLI provides clear error messages for:

- **Configuration Errors**: Invalid configuration files or missing required
  fields
- **Parse Errors**: Syntax errors in AgentLang code
- **Validation Errors**: Semantic errors in AgentLang modules
- **Runtime Errors**: Errors during program execution

## Examples

### Simple AgentLang Module

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

### Running the Module

```bash
# Validate the module
agent parseAndValidate UserManagement.al

# Generate documentation
agent doc example/usermanagement

# Run the module
agent run example/usermanagement

# Test in REPL with hot-reload
agent repl example/usermanagement --watch
```

### Full Development Workflow

```bash
# 1. Initialize a new AgentLang application
mkdir my-project && cd my-project
agent init MyApp

# 2. Add your application logic to src/core.al
# ... edit src/core.al ...

# 3. Run your AgentLang application
agent run

# 4. Test interactively with REPL
agent repl --watch

# 5. Generate API documentation
agent doc -h ./docs/api.html

# 6. Generate UI from specification
export ANTHROPIC_API_KEY=sk-ant-...
agent ui-gen ui-spec.json -p

# 7. Navigate to generated UI and test
cd ui
npm install
npm run dev

# 8. Make iterative updates to UI
agent ui-gen -m "Add export to CSV feature"
```

### Quick Start Example

```bash
# Initialize a new project
mkdir car-dealership && cd car-dealership
agent init CarDealership

# Your project structure is now:
# car-dealership/
# ├── package.json
# ├── config.al
# └── src/
#     └── core.al

# Start building your application in src/core.al
agent repl --watch

# Run your application
agent run
```
