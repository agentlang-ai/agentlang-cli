import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';

export interface UISpec {
  appInfo: {
    name: string;
    title: string;
    description: string;
  };
  [key: string]: unknown;
}

export async function loadUISpec(specPath: string): Promise<UISpec> {
  try {
    // Resolve the absolute path
    const absolutePath = path.resolve(process.cwd(), specPath);

    // Check if file exists
    if (!(await fs.pathExists(absolutePath))) {
      throw new Error(`UI spec file not found: ${absolutePath}`);
    }

    // Read and parse the JSON file
    const content = await fs.readFile(absolutePath, 'utf-8');
    const spec = JSON.parse(content) as UISpec;

    // Validate the spec has required fields
    if (!spec.appInfo || !spec.appInfo.name) {
      throw new Error('Invalid UI spec: missing appInfo.name');
    }

    // eslint-disable-next-line no-console
    console.log(chalk.green(`✓ Loaded spec for: ${spec.appInfo.title || spec.appInfo.name}`));

    return spec;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in spec file: ${error.message}`);
    }
    throw error;
  }
}
