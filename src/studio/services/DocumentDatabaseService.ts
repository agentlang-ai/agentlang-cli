import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs-extra';
import { randomUUID } from 'crypto';

export interface DocumentMetadata {
  id: string;
  originalName: string;
  maskedName: string;
  mimeType: string;
  size: number;
  storagePath: string;
  uploadedAt: string;
}

/**
 * Service for managing document metadata storage using SQLite
 * Files are stored and made available to AgentLang for embedding processing
 */
export class DocumentDatabaseService {
  private db: Database.Database;
  private documentsDir: string;

  constructor(appPath: string) {
    this.documentsDir = path.join(appPath, 'documents');

    fs.ensureDirSync(this.documentsDir);

    const dbPath = path.join(this.documentsDir, 'documents.db');
    this.db = new Database(dbPath);

    this.initializeSchema();
  }

  private initializeSchema(): void {
    // Enable WAL mode for better concurrent access
    this.db.pragma('journal_mode = WAL');

    // Documents metadata table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        original_name TEXT NOT NULL,
        masked_name TEXT NOT NULL UNIQUE,
        mime_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        uploaded_at TEXT NOT NULL
      )
    `);

    // Create index for better query performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_uploaded_at 
      ON documents(uploaded_at DESC)
    `);
  }

  /**
   * Save document metadata to database
   */
  saveDocument(metadata: Omit<DocumentMetadata, 'id'>): DocumentMetadata {
    const id = randomUUID();
    const doc: DocumentMetadata = { id, ...metadata };

    const stmt = this.db.prepare(`
      INSERT INTO documents (id, original_name, masked_name, mime_type, size, storage_path, uploaded_at)
      VALUES (@id, @originalName, @maskedName, @mimeType, @size, @storagePath, @uploadedAt)
    `);

    stmt.run(doc);
    return doc;
  }

  /**
   * Get document metadata by ID
   */
  getDocument(id: string): DocumentMetadata | null {
    const stmt = this.db.prepare(`
      SELECT id, original_name as originalName, masked_name as maskedName, 
             mime_type as mimeType, size, storage_path as storagePath, 
             uploaded_at as uploadedAt
      FROM documents WHERE id = ?
    `);

    return stmt.get(id) as DocumentMetadata | null;
  }

  /**
   * Get document by masked filename
   */
  getDocumentByMaskedName(maskedName: string): DocumentMetadata | null {
    const stmt = this.db.prepare(`
      SELECT id, original_name as originalName, masked_name as maskedName, 
             mime_type as mimeType, size, storage_path as storagePath, 
             uploaded_at as uploadedAt
      FROM documents WHERE masked_name = ?
    `);

    return stmt.get(maskedName) as DocumentMetadata | null;
  }

  /**
   * List all documents
   */
  listDocuments(limit = 100, offset = 0): DocumentMetadata[] {
    const stmt = this.db.prepare(`
      SELECT id, original_name as originalName, masked_name as maskedName, 
             mime_type as mimeType, size, storage_path as storagePath, 
             uploaded_at as uploadedAt
      FROM documents 
      ORDER BY uploaded_at DESC
      LIMIT ? OFFSET ?
    `);

    return stmt.all(limit, offset) as DocumentMetadata[];
  }

  /**
   * Delete document
   */
  deleteDocument(id: string): void {
    const doc = this.getDocument(id);
    if (!doc) return;

    // Delete file from filesystem
    if (fs.existsSync(doc.storagePath)) {
      fs.unlinkSync(doc.storagePath);
    }

    // Delete from database
    const stmt = this.db.prepare('DELETE FROM documents WHERE id = ?');
    stmt.run(id);
  }

  /**
   * Get total document count
   */
  getDocumentCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM documents');
    const result = stmt.get() as { count: number };
    return result.count;
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get database instance (for testing/debugging)
   */
  getDatabase(): Database.Database {
    return this.db;
  }
}
