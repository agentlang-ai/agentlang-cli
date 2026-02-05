import fs from 'fs-extra';
import path from 'path';
import { randomUUID } from 'crypto';
import { DocumentDatabaseService } from './DocumentDatabaseService.js';

export interface UploadedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface FileUploadResult {
  id: string;
  originalName: string;
  maskedName: string;
  size: number;
  mimeType: string;
  uploadedAt: string;
}

/**
 * Service for handling file uploads
 * Files are stored and made available to AgentLang for embedding processing
 */
export class FileUploadService {
  private documentsDir: string;
  private dbService: DocumentDatabaseService;

  constructor(appPath: string) {
    this.documentsDir = path.join(appPath, 'documents');

    // Initialize database service for metadata
    this.dbService = new DocumentDatabaseService(appPath);
  }

  /**
   * Generate masked filename using UUID
   */
  private generateMaskedFilename(originalName: string): string {
    const ext = path.extname(originalName);
    const uuid = randomUUID();
    return `${uuid}${ext}`;
  }

  /**
   * Upload and store a file
   */
  async uploadFile(file: UploadedFile): Promise<FileUploadResult> {
    // eslint-disable-next-line no-console
    console.log(`Uploading file: ${file.originalname} (${file.size} bytes, ${file.mimetype})`);

    // Generate masked filename
    const maskedName = this.generateMaskedFilename(file.originalname);
    const storagePath = path.join(this.documentsDir, maskedName);

    // Save file to disk
    await fs.writeFile(storagePath, file.buffer);
    // eslint-disable-next-line no-console
    console.log(`Saved file to: ${storagePath}`);

    // Save metadata to database
    const doc = this.dbService.saveDocument({
      originalName: file.originalname,
      maskedName,
      mimeType: file.mimetype,
      size: file.size,
      storagePath,
      uploadedAt: new Date().toISOString(),
    });
    // eslint-disable-next-line no-console
    console.log(`Saved document metadata with ID: ${doc.id}`);

    return {
      id: doc.id,
      originalName: doc.originalName,
      maskedName: doc.maskedName,
      size: doc.size,
      mimeType: doc.mimeType,
      uploadedAt: doc.uploadedAt,
    };
  }

  /**
   * Get file information
   */
  getFile(fileId: string): FileUploadResult | null {
    const doc = this.dbService.getDocument(fileId);
    if (!doc) return null;

    return {
      id: doc.id,
      originalName: doc.originalName,
      maskedName: doc.maskedName,
      size: doc.size,
      mimeType: doc.mimeType,
      uploadedAt: doc.uploadedAt,
    };
  }

  /**
   * List all uploaded files
   */
  listFiles(limit = 100, offset = 0): FileUploadResult[] {
    const docs = this.dbService.listDocuments(limit, offset);
    return docs.map(doc => ({
      id: doc.id,
      originalName: doc.originalName,
      maskedName: doc.maskedName,
      size: doc.size,
      mimeType: doc.mimeType,
      uploadedAt: doc.uploadedAt,
    }));
  }

  /**
   * Delete a file
   */
  deleteFile(fileId: string): void {
    this.dbService.deleteDocument(fileId);
  }

  /**
   * Download a file
   */
  async downloadFile(fileId: string): Promise<{ buffer: Buffer; filename: string; mimeType: string } | null> {
    const doc = this.dbService.getDocument(fileId);
    if (!doc) return null;

    if (!fs.existsSync(doc.storagePath)) {
      throw new Error(`File not found: ${doc.storagePath}`);
    }

    const buffer = await fs.readFile(doc.storagePath);
    return {
      buffer,
      filename: doc.originalName,
      mimeType: doc.mimeType,
    };
  }

  /**
   * Get document stats
   */
  getStats() {
    return {
      totalDocuments: this.dbService.getDocumentCount(),
      storageDir: this.documentsDir,
    };
  }

  /**
   * Close database connections
   */
  close(): void {
    this.dbService.close();
  }
}
