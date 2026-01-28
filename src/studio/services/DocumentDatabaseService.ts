import Database from 'better-sqlite3';
import * as sqlite_vec from 'sqlite-vec';
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
  chunkCount: number;
}

export interface DocumentChunk {
  id: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  embedding?: Float32Array;
}

export interface SearchResult {
  documentId: string;
  originalName: string;
  chunkIndex: number;
  content: string;
  similarity: number;
}

/**
 * Service for managing document storage and vector embeddings using SQLite + sqlite-vec
 */
export class DocumentDatabaseService {
  private db: Database.Database;
  private documentsDir: string;
  private embeddingsDir: string;

  constructor(appPath: string) {
    this.documentsDir = path.join(appPath, 'documents');
    this.embeddingsDir = path.join(appPath, 'documents', 'embeddings');

    // Ensure directories exist
    fs.ensureDirSync(this.documentsDir);
    fs.ensureDirSync(this.embeddingsDir);

    // Initialize SQLite database
    const dbPath = path.join(this.documentsDir, 'documents.db');
    this.db = new Database(dbPath);

    // Load sqlite-vec extension
    sqlite_vec.load(this.db);

    // Initialize schema
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
        uploaded_at TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0
      )
    `);

    // Document chunks table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        UNIQUE(document_id, chunk_index)
      )
    `);

    // Vector embeddings table using sqlite-vec
    // Using 1536 dimensions for OpenAI text-embedding-3-small
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding FLOAT[1536]
      )
    `);

    // Create indexes for better query performance
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id 
      ON document_chunks(document_id)
    `);

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
      INSERT INTO documents (id, original_name, masked_name, mime_type, size, storage_path, uploaded_at, chunk_count)
      VALUES (@id, @originalName, @maskedName, @mimeType, @size, @storagePath, @uploadedAt, @chunkCount)
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
             uploaded_at as uploadedAt, chunk_count as chunkCount
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
             uploaded_at as uploadedAt, chunk_count as chunkCount
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
             uploaded_at as uploadedAt, chunk_count as chunkCount
      FROM documents 
      ORDER BY uploaded_at DESC
      LIMIT ? OFFSET ?
    `);

    return stmt.all(limit, offset) as DocumentMetadata[];
  }

  /**
   * Delete document and all its chunks
   */
  deleteDocument(id: string): void {
    const doc = this.getDocument(id);
    if (!doc) return;

    // Delete file from filesystem
    if (fs.existsSync(doc.storagePath)) {
      fs.unlinkSync(doc.storagePath);
    }

    // Delete embeddings file if exists
    const embeddingFile = path.join(this.embeddingsDir, `embeddings.${doc.maskedName}.txt`);
    if (fs.existsSync(embeddingFile)) {
      fs.unlinkSync(embeddingFile);
    }

    // Delete chunks and their embeddings
    const chunks = this.getDocumentChunks(id);
    const deleteEmbeddingStmt = this.db.prepare('DELETE FROM vec_embeddings WHERE chunk_id = ?');
    for (const chunk of chunks) {
      deleteEmbeddingStmt.run(chunk.id);
    }

    // Delete from database (chunks will be deleted via CASCADE)
    const stmt = this.db.prepare('DELETE FROM documents WHERE id = ?');
    stmt.run(id);
  }

  /**
   * Save document chunks
   */
  saveChunks(documentId: string, chunks: string[]): DocumentChunk[] {
    const insertStmt = this.db.prepare(`
      INSERT INTO document_chunks (id, document_id, chunk_index, content)
      VALUES (@id, @documentId, @chunkIndex, @content)
    `);

    const updateCountStmt = this.db.prepare(`
      UPDATE documents SET chunk_count = ? WHERE id = ?
    `);

    const savedChunks: DocumentChunk[] = [];

    const transaction = this.db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = randomUUID();
        insertStmt.run({
          id: chunkId,
          documentId,
          chunkIndex: i,
          content: chunks[i],
        });

        savedChunks.push({
          id: chunkId,
          documentId,
          chunkIndex: i,
          content: chunks[i],
        });
      }

      updateCountStmt.run(chunks.length, documentId);
    });

    transaction();
    return savedChunks;
  }

  /**
   * Get all chunks for a document
   */
  getDocumentChunks(documentId: string): DocumentChunk[] {
    const stmt = this.db.prepare(`
      SELECT id, document_id as documentId, chunk_index as chunkIndex, content
      FROM document_chunks
      WHERE document_id = ?
      ORDER BY chunk_index ASC
    `);

    return stmt.all(documentId) as DocumentChunk[];
  }

  /**
   * Save embeddings for chunks
   */
  saveEmbeddings(chunkEmbeddings: { chunkId: string; embedding: number[] }[]): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO vec_embeddings (chunk_id, embedding)
      VALUES (?, ?)
    `);

    const transaction = this.db.transaction(() => {
      for (const { chunkId, embedding } of chunkEmbeddings) {
        // Convert to Float32Array for sqlite-vec
        const embeddingArray = new Float32Array(embedding);
        stmt.run(chunkId, embeddingArray);
      }
    });

    transaction();
  }

  /**
   * Search for similar documents using vector similarity
   */
  searchSimilar(queryEmbedding: number[], limit = 5): SearchResult[] {
    // Convert query embedding to JSON string format for sqlite-vec
    const queryJson = JSON.stringify(queryEmbedding);

    // sqlite-vec uses the MATCH operator for KNN search
    // The distance is automatically calculated
    const stmt = this.db.prepare(`
      SELECT 
        dc.document_id as documentId,
        d.original_name as originalName,
        dc.chunk_index as chunkIndex,
        dc.content,
        distance
      FROM vec_embeddings
      JOIN document_chunks dc ON vec_embeddings.chunk_id = dc.id
      JOIN documents d ON dc.document_id = d.id
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `);

    return stmt.all(queryJson, limit) as SearchResult[];
  }

  /**
   * Save embeddings to text file for backup/inspection
   */
  async saveEmbeddingsToFile(
    documentId: string,
    chunkEmbeddings: { chunkId: string; chunkIndex: number; embedding: number[] }[],
  ): Promise<string> {
    const doc = this.getDocument(documentId);
    if (!doc) {
      throw new Error(`Document ${documentId} not found`);
    }

    const filename = `embeddings.${doc.maskedName}.txt`;
    const filepath = path.join(this.embeddingsDir, filename);

    const lines = [
      `Document: ${doc.originalName}`,
      `Document ID: ${doc.id}`,
      `Masked Name: ${doc.maskedName}`,
      `Generated: ${new Date().toISOString()}`,
      `Total Chunks: ${chunkEmbeddings.length}`,
      `Embedding Dimensions: ${chunkEmbeddings[0]?.embedding.length || 0}`,
      '',
      '---',
      '',
    ];

    for (const { chunkId, chunkIndex, embedding } of chunkEmbeddings) {
      lines.push(`Chunk ${chunkIndex} (ID: ${chunkId}):`);
      lines.push(`Embedding: [${embedding.slice(0, 10).join(', ')}...] (showing first 10 of ${embedding.length})`);
      lines.push('');
    }

    await fs.writeFile(filepath, lines.join('\n'), 'utf-8');
    return filepath;
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
