# Publishing Guide

This guide explains how to compile and publish the `@agentlang/cli` package to
npm.

## Automated Release Process (Recommended)

**As of version 0.8.9+**, this repository uses an automated tag-based release
process.

### How It Works

1. **Push a Version Tag**: When you push a tag like `0.8.9`, the workflow
   automatically triggers
2. **PR Creation**: The workflow creates a Pull Request that includes:
   - Updated `package.json` with the new version
   - Updated `CHANGELOG.md` with all commits since the last tag
   - Updated `package-lock.json` (via `npm install`)
   - Updated `pnpm-lock.yaml` (via `pnpm install`)
   - Links to all commits with author mentions
3. **Review & Merge**: Review the PR and merge it to apply the changes
4. **Publish**: The publish workflow handles npm publishing automatically when
   the tag exists

### Quick Start

```bash
# 1. Create and push a version tag
git tag 0.8.9
git push origin 0.8.9

# 2. Wait for automated PR creation (~1-2 minutes)
# 3. Review the auto-generated PR with CHANGELOG and version updates
# 4. Merge the PR
# 5. Package automatically publishes to npm
```

### Benefits

- Automatic CHANGELOG generation from git commits
- Automatic version bumping in package.json
- Automatic lock file updates (both npm and pnpm)
- Automatic npm publishing
- GitHub Release creation with formatted release notes
- Reduced human error and manual steps

### Step-by-Step Workflow

#### 1. Decide on the Version Number

Follow [Semantic Versioning](https://semver.org/):

- **Major** (1.0.0 → 2.0.0): Breaking changes
- **Minor** (0.8.0 → 0.9.0): New features, backwards compatible
- **Patch** (0.8.8 → 0.8.9): Bug fixes, backwards compatible

#### 2. Create and Push the Tag

```bash
# Create a tag locally (recommended: no 'v' prefix)
git tag 0.8.9

# Push the tag to trigger the workflow
git push origin 0.8.9

# Note: Tags with 'v' prefix also work as a fallback
git tag v0.8.9  # This also works, 'v' will be stripped
```

#### 3. Workflow Runs Automatically

The workflow will:

- Extract the version from the tag (strips 'v' prefix if present)
- Find all commits since the previous tag
- Generate a CHANGELOG entry with commit messages, links, and author mentions
- Update `package.json` version
- Run `npm install` to update `package-lock.json`
- Run `pnpm install` to update `pnpm-lock.yaml`
- Create a Pull Request with all these changes

#### 4. Review the Pull Request

The automated PR will be titled **"Release X.Y.Z"** and will include:

- All file changes (package.json, CHANGELOG.md, lock files)
- A summary of commits included in this release
- Links to individual commits
- Author attributions

Review the PR to ensure:

- Version number is correct
- All commits since the last tag are included
- CHANGELOG entries are accurate
- Lock files are properly updated

#### 5. Merge the Pull Request

Once approved, merge the PR. This will:

- Update the repository with the new version
- Update the CHANGELOG
- Ensure lock files are in sync

#### 6. Publishing to npm

The `publish.yml` workflow handles publishing to npm automatically when:

- A tag is pushed (which you already did in step 2)
- A GitHub release is published

The package will be published as `@agentlang/cli` on npm.

### CHANGELOG Format

The CHANGELOG is automatically generated in this format:

```markdown
## [0.8.9](https://github.com/agentlang/agentlang-cli/compare/0.8.8...0.8.9) (2025-12-30)

### Changes

- add new feature
  ([abc123](https://github.com/agentlang/agentlang-cli/commit/abc123)) -
  @username
- fix bug in REPL
  ([def456](https://github.com/agentlang/agentlang-cli/commit/def456)) -
  @username

---
```

### Complete Example

```bash
# 1. Make sure you're on main with latest changes
git checkout main
git pull origin main

# 2. Create and push the version tag
git tag 0.9.0
git push origin 0.9.0

# 3. Wait for the GitHub Actions workflow to complete (~1-2 minutes)
#    Check: https://github.com/agentlang/agentlang-cli/actions

# 4. Review the auto-generated PR
#    Go to: https://github.com/agentlang/agentlang-cli/pulls

# 5. Merge the PR after review

# 6. The publish workflow automatically publishes to npm
#    Check: https://www.npmjs.com/package/@agentlang/cli
```

### Troubleshooting

**Workflow doesn't trigger**

- Ensure the tag follows the format: `X.Y.Z` or `vX.Y.Z`
- Check that you pushed the tag: `git push origin <tag-name>`
- Verify GitHub Actions is enabled for the repository

**PR not created**

- Check the Actions tab for workflow errors
- Ensure GitHub Actions has proper permissions

**npm publish fails**

- Ensure `NPM_TOKEN` secret is configured in GitHub repository settings
- Verify you have publish access to the `@agentlang` npm organization

**Duplicate tags**

- Delete the tag first: `git tag -d 0.8.9 && git push origin :refs/tags/0.8.9`
- Then create and push the new tag

### Best Practices

1. **Tag from main**: Always create tags from the `main` branch
2. **Test before tagging**: Ensure linting and type checking pass before
   creating a release tag
3. **Use semantic versioning**: Follow semver guidelines for version numbers
4. **Review the PR**: Always review the automated PR before merging
5. **Clear commit messages**: Write clear commit messages since they appear in
   the CHANGELOG

### First Release Note

Since this repository previously had no git tags, the first release will include
ALL commits in the repository history. For subsequent releases, the CHANGELOG
will only include commits between tags.

---

## Manual Publishing Process (Legacy/Fallback)

The following manual process is kept for reference and emergency situations.
**Under normal circumstances, use the automated process above.**

### Quick Start

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
