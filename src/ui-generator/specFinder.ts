import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';

/**
 * Searches for a UI spec file in the given directory
 * Looks for files in this priority order:
 * 1. ui-spec.json
 * 2. spec.json
 * 3. *.ui-spec.json
 *
 * @param searchDir - Directory to search in (defaults to current working directory)
 * @returns Path to the found spec file
 * @throws Error if no spec file is found
 */
export async function findSpecFile(searchDir: string = process.cwd()): Promise<string> {
  // Priority list of spec file names to search for
  const specFileNames = ['ui-spec.json', 'spec.json'];

  // First, try exact matches
  for (const fileName of specFileNames) {
    const filePath = path.join(searchDir, fileName);
    if (await fs.pathExists(filePath)) {
      // eslint-disable-next-line no-console
      console.log(chalk.gray(`  Found spec file: ${fileName}`));
      return filePath;
    }
  }

  // If no exact match, look for files matching *.ui-spec.json pattern
  try {
    const files = await fs.readdir(searchDir);
    const uiSpecFiles = files.filter(file => file.endsWith('.ui-spec.json'));

    if (uiSpecFiles.length > 0) {
      const filePath = path.join(searchDir, uiSpecFiles[0]);
      // eslint-disable-next-line no-console
      console.log(chalk.gray(`  Found spec file: ${uiSpecFiles[0]}`));
      if (uiSpecFiles.length > 1) {
        // eslint-disable-next-line no-console
        console.log(
          chalk.yellow(
            `  Note: Multiple spec files found, using ${uiSpecFiles[0]}. Other files: ${uiSpecFiles.slice(1).join(', ')}`,
          ),
        );
      }
      return filePath;
    }
  } catch {
    // Directory read failed, continue to error below
  }

  // No spec file found
  throw new Error(
    `No UI spec file found in ${searchDir}.\n` +
      `  Searched for: ${specFileNames.join(', ')}, or any *.ui-spec.json file.\n` +
      '  Please create a spec file or provide the path explicitly.',
  );
}
