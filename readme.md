# AgentLang CLI

A command-line interface tool for running, validating, and generating documentation for AgentLang programs. AgentLang is a programming language designed for building agent-based applications with built-in support for entities, events, and relationships.

## Features

- **Run AgentLang Programs**: Execute AgentLang modules with full runtime support
- **Parse and Validate**: Check syntax and semantic correctness of AgentLang code
- **Generate API Documentation**: Automatically generate OpenAPI/Swagger documentation from your AgentLang modules
- **Database Support**: Built-in support for PostgreSQL, MySQL, and SQLite
- **Authentication**: Integration with Okta and AWS Cognito authentication services
- **RBAC**: Role-based access control capabilities
- **Audit Trail**: Comprehensive audit logging

## Installation

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Install the CLI

```bash
npm install -g agentcli
```

Or install locally:

```bash
npm install agentcli
```

## Usage

The AgentLang CLI provides three main commands:

### 1. Run AgentLang Programs

Execute an AgentLang module with full runtime support:

```bash
agentts run <file>
```

**Options:**
- `-c, --config <config>`: Specify a custom configuration file (default: `app.config`)

**Example:**
```bash
agentts run myapp.al
```

### 2. Parse and Validate

Check the syntax and semantic correctness of your AgentLang code:

```bash
agentts parseAndValidate <file>
```

**Options:**
- `-d, --destination <dir>`: Specify destination directory for generated files

**Example:**
```bash
agentts parseAndValidate myapp.al
```

### 3. Generate API Documentation

Generate OpenAPI/Swagger documentation from your AgentLang modules:

```bash
agentts doc <file>
```

**Example:**
```bash
agentts doc myapp.al
```

This will generate a `docs/openapi-docs.yml` file in your project directory.

## Configuration

The CLI supports configuration through an `app.config` file (or custom config file). The configuration supports various options:

### Basic Configuration

```javascript
// app.config.js
export default {
  service: {
    port: 8080
  },
  store: {
    type: 'sqlite',
    dbname: 'myapp.db'
  }
}
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

The `doc` command automatically generates OpenAPI documentation for your AgentLang modules. It includes:

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

- `POST /api/{module}/{entity}/{relationship}/{relatedEntity}` - Create related entity
- `GET /api/{module}/{entity}/{relationship}/{relatedEntity}` - List related entities
- `PUT /api/{module}/{entity}/{relationship}/{relatedEntity}/{id}` - Update related entity
- `DELETE /api/{module}/{entity}/{relationship}/{relatedEntity}/{id}` - Delete related entity

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

- **Configuration Errors**: Invalid configuration files or missing required fields
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
agentts parseAndValidate UserManagement.al

# Generate documentation
agentts doc example/usermanagement

# Run the module
agentts run example/usermanagement
```
