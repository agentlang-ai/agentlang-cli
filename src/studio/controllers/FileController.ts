import { Request, Response } from 'express';
import path from 'path';
import { FileService } from '../services/FileService.js';

export class FileController {
  private fileService: FileService;

  constructor(fileService: FileService) {
    this.fileService = fileService;
  }

  getFiles = async (req: Request, res: Response) => {
    try {
      const pathParam = req.query.path as string | undefined;
      if (pathParam) {
        // Fetch file tree for a specific path (e.g., node_modules/depName)
        // Skip ignored paths when fetching from node_modules
        // Use FileService's current targetDir
        const fullPath = path.join(this.fileService.getTargetDir(), pathParam);
        const skipIgnored = pathParam.startsWith('node_modules');
        const fileTree = await this.fileService.getFileTree(fullPath, '', skipIgnored);
        return res.json(fileTree);
      } else {
        // Fetch root file tree
        const fileTree = await this.fileService.getFileTree();
        return res.json(fileTree);
      }
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof (error as { code: unknown }).code === 'string' &&
        (error as { code: string }).code === 'ENOENT'
      ) {
        return res.status(404).json({ error: 'Path not found' });
      }
      return res.status(500).json({ error: 'Failed to read file tree' });
    }
  };

  getFile = async (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    const includeMetadata = req.query.metadata === 'true';
    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }
    try {
      const content = await this.fileService.readFile(filePath);
      if (includeMetadata) {
        const stats = await this.fileService.stat(filePath);
        return res.json({ content, type: stats.type, size: stats.size, mtime: stats.mtime });
      }
      return res.json({ content });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof (error as { code: unknown }).code === 'string' &&
        (error as { code: string }).code === 'ENOENT'
      ) {
        return res.status(404).json({ error: 'File not found' });
      }
      return res.status(500).json({ error: `Failed to read file: ${filePath}` });
    }
  };

  getStat = async (req: Request, res: Response) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      return res.status(400).json({ error: 'File path is required' });
    }
    try {
      const stats = await this.fileService.stat(filePath);
      return res.json(stats);
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof (error as { code: unknown }).code === 'string' &&
        (error as { code: string }).code === 'ENOENT'
      ) {
        return res.status(404).json({ error: 'Path not found' });
      }
      return res.status(500).json({ error: `Failed to get stat for: ${filePath}` });
    }
  };

  saveFile = async (req: Request, res: Response) => {
    const {
      path: filePath,
      content,
      commitMessage,
    } = req.body as {
      path?: string;
      content?: string;
      commitMessage?: string;
    };
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: 'File path and content are required' });
    }
    try {
      await this.fileService.writeFile(filePath, content, commitMessage);
      return res.json({ message: `Successfully wrote to ${filePath}` });
    } catch {
      return res.status(500).json({ error: `Failed to write to file: ${filePath}` });
    }
  };

  getInfo = async (_req: Request, res: Response) => {
    const info = await this.fileService.getPackageInfo();
    return res.json(info);
  };

  getBranch = async (_req: Request, res: Response) => {
    try {
      const branch = await this.fileService.getCurrentBranch();
      return res.json({ branch });
    } catch {
      return res.status(500).json({ error: 'Failed to get current branch' });
    }
  };

  installDependencies = (req: Request, res: Response) => {
    try {
      const { githubUsername, githubToken } = (req.body as { githubUsername?: string; githubToken?: string }) || {};
      this.fileService.installDependencies(githubUsername, githubToken);
      return res.json({ message: 'Dependencies installed successfully' });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return res.status(500).json({ error: errorMessage });
    }
  };
}
