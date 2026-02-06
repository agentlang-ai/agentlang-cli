import { Request, Response } from 'express';
import { FileUploadService } from '../services/FileUploadService.js';

// Extend Express Request to include multer's file property
type MulterFile = Express.Multer.File;

interface MulterRequest extends Request {
  file?: MulterFile;
}

/**
 * Controller for handling document upload and management endpoints
 */
export class DocumentController {
  /**
   * Initialize upload service for current app
   */
  private getUploadService(appPath: string | null): FileUploadService {
    if (!appPath) {
      throw new Error('No app is currently loaded');
    }

    // Create new instance per request (could be cached per app path)
    return new FileUploadService(appPath);
  }

  /**
   * Upload a file
   * POST /documents/upload
   */
  upload = async (req: MulterRequest, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      const uploadService = this.getUploadService(typeof appPath === 'string' ? appPath : null);

      if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
      }

      const result = await uploadService.uploadFile({
        fieldname: req.file.fieldname,
        originalname: req.file.originalname,
        encoding: req.file.encoding,
        mimetype: req.file.mimetype,
        size: req.file.size,
        buffer: req.file.buffer,
      });

      res.json(result);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error uploading file:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to upload file',
      });
    }
  };

  /**
   * List all uploaded files
   * GET /documents
   */
  list = (req: Request, res: Response): void => {
    try {
      const appPath = req.headers['x-app-path'];
      const uploadService = this.getUploadService(typeof appPath === 'string' ? appPath : null);

      const limit = parseInt(typeof req.query.limit === 'string' ? req.query.limit : '100') || 100;
      const offset = parseInt(typeof req.query.offset === 'string' ? req.query.offset : '0') || 0;

      const files = uploadService.listFiles(limit, offset);
      const stats = uploadService.getStats();

      res.json({
        files,
        total: stats.totalDocuments,
        limit,
        offset,
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error listing files:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to list files',
      });
    }
  };

  /**
   * Get file information
   * GET /documents/:id
   */
  get = (req: Request, res: Response): void => {
    try {
      const appPath = req.headers['x-app-path'];
      const uploadService = this.getUploadService(typeof appPath === 'string' ? appPath : null);

      const id = typeof req.params.id === 'string' ? req.params.id : req.params.id?.[0] || '';
      const file = uploadService.getFile(id);

      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      res.json(file);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error getting file:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get file',
      });
    }
  };

  /**
   * Download a file
   * GET /documents/:id/download
   */
  download = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      const uploadService = this.getUploadService(typeof appPath === 'string' ? appPath : null);

      const id = typeof req.params.id === 'string' ? req.params.id : req.params.id?.[0] || '';
      const result = await uploadService.downloadFile(id);

      if (!result) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
      res.send(result.buffer);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error downloading file:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to download file',
      });
    }
  };

  /**
   * Delete a file
   * DELETE /documents/:id
   */
  delete = (req: Request, res: Response): void => {
    try {
      const appPath = req.headers['x-app-path'];
      const uploadService = this.getUploadService(typeof appPath === 'string' ? appPath : null);

      const id = typeof req.params.id === 'string' ? req.params.id : req.params.id?.[0] || '';
      uploadService.deleteFile(id);

      res.json({ success: true });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error deleting file:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to delete file',
      });
    }
  };

  /**
   * Get stats
   * GET /documents/stats
   */
  stats = (req: Request, res: Response): void => {
    try {
      const appPath = req.headers['x-app-path'];
      const uploadService = this.getUploadService(typeof appPath === 'string' ? appPath : null);

      const stats = uploadService.getStats();

      res.json(stats);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error getting stats:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get stats',
      });
    }
  };
}
