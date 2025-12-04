# Publishing Guide

This guide explains how to compile and publish the `@agentlang/cli` package to
npm.

## Quick Start

```bash
# 1. Login to npm
npm login

# 2. Update version (if needed)
npm version patch  # or minor/major

# 3. Build and publish
npm run build
npm publish --access public

# 4. Verify
npm view @agentlang/cli
```

## Prerequisites

1. **npm account**: You need an npm account to publish packages
2. **npm login**: Make sure you're logged in to npm (`npm login`)
3. **Package ownership**: Ensure you have access to publish to the `@agentlang`
   organization on npm
4. **Organization access**: You must be a member of the `@agentlang` npm
   organization

## Pre-publishing Checklist

Before publishing, ensure:

1. ✅ **Build works**: `npm run build` completes successfully
2. ✅ **CLI works**: `node bin/cli.js --help` shows the correct commands
3. ✅ **Package structure**: `npm pack --dry-run` shows the correct files
4. ✅ **Version number**: Update version in `package.json` if needed
5. ✅ **README**: Documentation is up to date
6. ✅ **License**: LICENSE file is present

## Publishing Steps

### 1. Ensure You're Logged In

```bash
# Check if you're logged in
npm whoami

# If not logged in, login to npm
npm login

# Make sure you're logged in to the correct registry
npm config get registry
# Should show: https://registry.npmjs.org/
```

### 2. Update Version (if needed)

```bash
# Update version in package.json (this also creates a git tag)
npm version patch  # for bug fixes (0.6.2 -> 0.6.3)
npm version minor  # for new features (0.6.2 -> 0.7.0)
npm version major  # for breaking changes (0.6.2 -> 1.0.0)

# Or manually edit package.json and then:
git add package.json package-lock.json
git commit -m "chore: bump version to X.Y.Z"
git tag vX.Y.Z
```

### 3. Build the Package

```bash
# Clean previous builds (optional)
rm -rf out/

# Build TypeScript and bundle with esbuild
npm run build

# Verify build output exists
ls -la out/
ls -la bin/cli.js
```

### 4. Run Pre-publish Checks

```bash
# Type check
npm run typecheck

# Lint check
npm run lint:check

# Format check
npm run format:check

# Or run all checks
npm run check
```

### 5. Test the Package Locally

```bash
# Test the CLI binary directly
node bin/cli.js --help

# Test the package structure (shows what will be published)
npm pack --dry-run

# Actually create a tarball to inspect
npm pack

# Test installation from tarball (optional)
npm install -g agentlang-cli-*.tgz
agent --help
npm uninstall -g @agentlang/cli
rm agentlang-cli-*.tgz
```

### 6. Publish to npm

```bash
# Publish to npm (automatically runs prepublishOnly script which builds)
npm publish

# If publishing a scoped package for the first time, make it public:
npm publish --access public

# Verify the package was published
npm view @agentlang/cli
```

### 7. Push Git Tags (if you used npm version)

```bash
# Push commits and tags to remote
git push origin main
git push origin --tags

# Or if on a branch
git push origin serve-studio-cmd
git push origin --tags
```

### 8. Verify Publication

```bash
# Check the published package
npm view @agentlang/cli

# Test installation
npm install -g @agentlang/cli
agent --help
```

## Package Configuration

The package is configured with:

- **Package name**: `@agentlang/cli`
- **Entry point**: `out/main.js`
- **Binary**: `bin/cli.js` (creates `agent` command)
- **Files included**: `out/`, `bin/`, `.pnpmrc`, `README.md`, `LICENSE` (defined
  in `package.json` `files` field)
- **Files excluded**: Source files (`src/`), dev files, build configs,
  `node_modules/`, etc.
- **Build process**:
  - TypeScript compilation (`tsc -b tsconfig.src.json`)
  - ESBuild bundling (`node esbuild.mjs`)
  - Output: `out/*.js` and `out/*.js.map` files

## Build Process Details

### TypeScript Compilation

```bash
# Compiles TypeScript to JavaScript
tsc -b tsconfig.src.json

# Output: out/*.js files with type definitions
```

### ESBuild Bundling

```bash
# Bundles and optimizes the code
node esbuild.mjs

# Options:
# --watch: Watch mode for development
# --minify: Minify output (for production)
```

### Complete Build Command

The `npm run build` command runs:

1. `tsc -b tsconfig.src.json` - TypeScript compilation
2. `node esbuild.mjs` - ESBuild bundling

### Prepublish Hook

The `prepublishOnly` script automatically runs `npm run build` before
publishing, ensuring the package is always built with the latest code.

## Troubleshooting

### Common Issues

1. **Organization access denied**: Ensure you're a member of the `@agentlang`
   npm organization
2. **Build fails**: Check TypeScript compilation and esbuild
3. **CLI not found**: Ensure `bin/cli.js` has correct shebang and permissions
4. **Missing dependencies**: Check `package.json` dependencies
5. **Publish fails**: Make sure you're logged in with `npm login` and have 2FA
   enabled if required

### Testing Before Publishing

```bash
# Test in a clean environment
mkdir test-install
cd test-install
npm install ../agentlang-cli
./node_modules/.bin/agent --help

# Or test published version
npm install -g @agentlang/cli@latest
agent --help
```

## Version Management

- Use semantic versioning (MAJOR.MINOR.PATCH)
- Update CHANGELOG.md for significant changes
- Tag releases in git: `git tag v0.0.1`

## Security

- Never commit API keys or secrets
- Use `.npmignore` to exclude sensitive files
- Review dependencies for security vulnerabilities: `npm audit`
