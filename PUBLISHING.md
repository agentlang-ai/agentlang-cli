# Publishing Guide

This guide explains how to publish the AgentLang CLI package to npm.

## Prerequisites

1. **npm account**: You need an npm account to publish packages
2. **npm login**: Make sure you're logged in to npm (`npm login`)
3. **Package ownership**: Ensure you have the right to publish the
   `agentlangcli` package name

## Pre-publishing Checklist

Before publishing, ensure:

1. ✅ **Build works**: `npm run build` completes successfully
2. ✅ **CLI works**: `node bin/cli.js --help` shows the correct commands
3. ✅ **Package structure**: `npm pack --dry-run` shows the correct files
4. ✅ **Version number**: Update version in `package.json` if needed
5. ✅ **README**: Documentation is up to date
6. ✅ **License**: LICENSE file is present

## Publishing Steps

### 1. Update Version (if needed)

```bash
# Update version in package.json
npm version patch  # for bug fixes
npm version minor  # for new features
npm version major  # for breaking changes
```

### 2. Build the Package

```bash
npm run build
```

### 3. Test the Package Locally

```bash
# Test the CLI
node bin/cli.js --help

# Test the package structure
npm pack --dry-run
```

### 4. Publish to npm

```bash
npm publish
```

### 5. Verify Publication

```bash
# Check the published package
npm view agentlangcli

# Test installation
npm install -g agentlangcli
agent --help
```

## Package Configuration

The package is configured with:

- **Entry point**: `out/main.js`
- **Binary**: `bin/cli.js` (creates `agent` command)
- **Files included**: `out/`, `bin/`, `README.md`, `LICENSE`
- **Files excluded**: Source files, dev files, build configs (via `.npmignore`)

## Troubleshooting

### Common Issues

1. **Package name taken**: Change the name in `package.json`
2. **Build fails**: Check TypeScript compilation and esbuild
3. **CLI not found**: Ensure `bin/cli.js` has correct shebang and permissions
4. **Missing dependencies**: Check `package.json` dependencies

### Testing Before Publishing

```bash
# Test in a clean environment
mkdir test-install
cd test-install
npm install ../agentlang-cli
./node_modules/.bin/agent --help
```

## Version Management

- Use semantic versioning (MAJOR.MINOR.PATCH)
- Update CHANGELOG.md for significant changes
- Tag releases in git: `git tag v0.0.1`

## Security

- Never commit API keys or secrets
- Use `.npmignore` to exclude sensitive files
- Review dependencies for security vulnerabilities: `npm audit`
