import fs from 'fs-extra';
import path from 'path';
import { randomUUID } from 'crypto';
import mammoth from 'mammoth';
import { DocumentDatabaseService } from './DocumentDatabaseService.js';
import { VectorStoreService } from './VectorStoreService.js';

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
  chunkCount: number;
}

/**
 * Service for handling file uploads, text extraction, and document processing
 */
export class FileUploadService {
  private documentsDir: string;
  private dbService: DocumentDatabaseService;
  private vectorService: VectorStoreService;

  constructor(appPath: string) {
    this.documentsDir = path.join(appPath, 'documents');

    // Initialize services
    this.dbService = new DocumentDatabaseService(appPath);
    this.vectorService = new VectorStoreService(this.dbService);
  }

  /**
   * Extract text from PDF file
   */
  private async extractPdfText(buffer: Buffer): Promise<string> {
    try {
      // Dynamic import for pdf-parse to handle ESM/CJS compatibility
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: buffer });
      const textResult = await parser.getText();
      return textResult.text;
    } catch (error) {
      throw new Error(`Failed to extract text from PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Extract text from Word document
   */
  private async extractDocxText(buffer: Buffer): Promise<string> {
    try {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } catch (error) {
      throw new Error(`Failed to extract text from DOCX: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Extract text from plain text file
   */
  private extractPlainText(buffer: Buffer): string {
    return buffer.toString('utf-8');
  }

  /**
   * Extract text from file based on MIME type
   */
  private async extractText(buffer: Buffer, mimeType: string): Promise<string> {
    switch (mimeType) {
      case 'application/pdf':
        return this.extractPdfText(buffer);

      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      case 'application/msword':
        return this.extractDocxText(buffer);

      case 'text/plain':
      case 'text/markdown':
      case 'text/html':
      case 'text/csv':
      case 'application/json':
        return this.extractPlainText(buffer);

      default:
        // Try to extract as plain text for unknown types
        try {
          return this.extractPlainText(buffer);
        } catch {
          throw new Error(`Unsupported file type: ${mimeType}`);
        }
    }
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
   * Upload and process a file
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
      chunkCount: 0,
    });
    // eslint-disable-next-line no-console
    console.log(`Saved document metadata with ID: ${doc.id}`);

    // Extract text and process in background
    this.processFileInBackground(doc.id, file.buffer, file.mimetype).catch(error => {
      // eslint-disable-next-line no-console
      console.error(`Failed to process document ${doc.id}:`, error);
    });

    return {
      id: doc.id,
      originalName: doc.originalName,
      maskedName: doc.maskedName,
      size: doc.size,
      mimeType: doc.mimeType,
      uploadedAt: doc.uploadedAt,
      chunkCount: doc.chunkCount,
    };
  }

  /**
   * Process file in background (extract text, chunk, generate embeddings)
   */
  private async processFileInBackground(documentId: string, buffer: Buffer, mimeType: string): Promise<void> {
    try {
      // eslint-disable-next-line no-console
      console.log(`Processing document ${documentId} in background...`);

      // Extract text
      const text = await this.extractText(buffer, mimeType);
      // eslint-disable-next-line no-console
      console.log(`Extracted ${text.length} characters from document`);

      if (text.trim().length === 0) {
        // eslint-disable-next-line no-console
        console.warn(`Document ${documentId} has no extractable text`);
        return;
      }

      // Process with vector service (chunk and embed)
      await this.vectorService.processDocument(documentId, text);

      // eslint-disable-next-line no-console
      console.log(`Successfully processed document ${documentId}`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Error processing document ${documentId}:`, error);
      throw error;
    }
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
      chunkCount: doc.chunkCount,
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
      chunkCount: doc.chunkCount,
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
   * Search for similar documents
   */
  async searchDocuments(query: string, limit = 5) {
    return this.vectorService.search(query, { limit });
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
