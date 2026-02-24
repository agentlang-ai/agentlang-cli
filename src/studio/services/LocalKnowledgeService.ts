import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs-extra';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import * as sqliteVec from 'sqlite-vec';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnowledgeTopic {
  id: string;
  tenantId: string;
  appId: string;
  name: string;
  description: string;
  containerTag: string;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocument {
  id: string;
  tenantId: string;
  appId: string;
  topicId: string;
  title: string;
  fileName: string;
  fileType: string;
  sizeBytes: number;
  currentVersion: number;
  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeChunk {
  id: string;
  tenantId: string;
  appId: string;
  topicId: string;
  documentId: string;
  documentVersionId: string;
  containerTag: string;
  chunkIndex: number;
  content: string;
  embeddingModel: string;
}

export interface KnowledgeNode {
  id: string;
  tenantId: string;
  appId: string;
  containerTag: string;
  documentVersionId: string;
  name: string;
  entityType: string;
  description: string;
  confidence: number;
}

export interface KnowledgeRelation {
  id: string;
  tenantId: string;
  appId: string;
  containerTag: string;
  documentVersionId: string;
  sourceNodeId: string;
  targetNodeId: string;
  relType: string;
  weight: number;
}

export interface KnowledgeQueryResult {
  chunks: Array<{ id: string; content: string; similarity: number; containerTag: string }>;
  entities: Array<{
    id: string;
    name: string;
    entityType: string;
    description: string;
    confidence: number;
  }>;
  edges: Array<{
    sourceId: string;
    targetId: string;
    relType: string;
    weight: number;
  }>;
  contextString: string;
}

export interface UploadDocumentVersionInput {
  tenantId: string;
  appId: string;
  topicId?: string;
  topicName?: string;
  containerTag?: string;
  title: string;
  fileName: string;
  fileType: string;
  content: string; // base64-encoded file content
  uploadedBy?: string;
}

// ---------------------------------------------------------------------------
// Embedding helper
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL = process.env.AGENTLANG_EMBEDDING_MODEL || 'text-embedding-3-small';
const EMBEDDING_DIMENSIONS = parseInt(process.env.AGENTLANG_EMBEDDING_DIMENSIONS || '1536', 10);
const CHUNK_SIZE = parseInt(process.env.KG_CHUNK_SIZE || '1000', 10);
const CHUNK_OVERLAP = parseInt(process.env.KG_CHUNK_OVERLAP || '200', 10);

async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.AGENTLANG_OPENAI_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Return zero vectors when no API key is configured (dev/test mode)
    return texts.map(() => new Array(EMBEDDING_DIMENSIONS).fill(0));
  }

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });

  const response = await client.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });

  return response.data.map((d) => d.embedding);
}

/**
 * Extract text content from a file buffer based on its file type.
 * Supports PDF, DOCX, HTML, JSON, and plain text.
 */
async function extractText(
  fileBuffer: Buffer,
  fileType: string,
  fileName: string
): Promise<string> {
  const ext = (fileName || '').split('.').pop()?.toLowerCase() ?? '';

  // PDF extraction
  if (fileType === 'pdf' || ext === 'pdf') {
    try {
      const pdfParseModule = await import('pdf-parse');
      const pdfParse = (pdfParseModule as any).default || pdfParseModule;
      const result = await pdfParse(fileBuffer);
      return (result.text || '').trim();
    } catch (err) {
      console.warn(`[LOCAL-KNOWLEDGE] PDF extraction failed for ${fileName}, falling back to raw text`);
      return fileBuffer.toString('utf-8');
    }
  }

  // DOCX / DOC extraction
  if (fileType === 'docx' || fileType === 'doc' || ext === 'docx' || ext === 'doc') {
    try {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      return (result.value || '').trim();
    } catch (err) {
      console.warn(`[LOCAL-KNOWLEDGE] DOCX extraction failed for ${fileName}, falling back to raw text`);
      return fileBuffer.toString('utf-8');
    }
  }

  // HTML — strip tags
  if (fileType === 'html' || ext === 'html' || ext === 'htm') {
    try {
      const cheerio = await import('cheerio');
      const $ = cheerio.load(fileBuffer.toString('utf-8'));
      $('script, style, noscript').remove();
      return ($('body').text() || $.root().text() || '').replace(/\s+/g, ' ').trim();
    } catch (err) {
      console.warn(`[LOCAL-KNOWLEDGE] HTML extraction failed for ${fileName}, falling back to raw text`);
      return fileBuffer.toString('utf-8');
    }
  }

  // JSON — pretty-print
  if (fileType === 'json' || ext === 'json') {
    try {
      const parsed = JSON.parse(fileBuffer.toString('utf-8'));
      return JSON.stringify(parsed, null, 2);
    } catch {
      return fileBuffer.toString('utf-8');
    }
  }

  // Plain text, Markdown, CSV, code files
  return fileBuffer.toString('utf-8');
}

function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end));
    start += CHUNK_SIZE - CHUNK_OVERLAP;
    if (start >= text.length) break;
  }
  if (chunks.length === 0 && text.length > 0) {
    chunks.push(text);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class LocalKnowledgeService {
  private db: Database.Database;
  private storageDir: string;

  constructor(appPath: string) {
    const knowledgeDir = path.join(appPath, 'knowledge');
    fs.ensureDirSync(knowledgeDir);

    this.storageDir = path.join(knowledgeDir, 'files');
    fs.ensureDirSync(this.storageDir);

    const dbPath = path.join(knowledgeDir, 'knowledge.db');
    this.db = new Database(dbPath);

    // Load sqlite-vec extension
    sqliteVec.load(this.db);

    this.initializeSchema();
  }

  private initializeSchema(): void {
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        container_tag TEXT NOT NULL,
        document_count INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(tenant_id, app_id, container_tag)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        topic_id TEXT NOT NULL,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_type TEXT DEFAULT '',
        size_bytes INTEGER DEFAULT 0,
        current_version INTEGER DEFAULT 1,
        is_deleted INTEGER DEFAULT 0,
        storage_key TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (topic_id) REFERENCES topics(id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS document_versions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        size_bytes INTEGER DEFAULT 0,
        content_hash TEXT DEFAULT '',
        storage_key TEXT DEFAULT '',
        mime_type TEXT DEFAULT '',
        original_file_name TEXT DEFAULT '',
        is_current INTEGER DEFAULT 1,
        ingest_status TEXT DEFAULT 'queued',
        uploaded_by TEXT DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(document_id, version),
        FOREIGN KEY (document_id) REFERENCES documents(id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        topic_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        document_version_id TEXT NOT NULL,
        container_tag TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        embedding_model TEXT DEFAULT ''
      )
    `);

    // Virtual table for vector search via sqlite-vec
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunk_embeddings USING vec0(
        chunk_id TEXT PRIMARY KEY,
        embedding float[${EMBEDDING_DIMENSIONS}]
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        container_tag TEXT NOT NULL,
        document_version_id TEXT NOT NULL,
        name TEXT NOT NULL,
        entity_type TEXT DEFAULT '',
        description TEXT DEFAULT '',
        confidence REAL DEFAULT 1.0,
        UNIQUE(container_tag, name, entity_type)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        container_tag TEXT NOT NULL,
        document_version_id TEXT NOT NULL,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        rel_type TEXT DEFAULT 'RELATED_TO',
        weight REAL DEFAULT 1.0,
        FOREIGN KEY (source_node_id) REFERENCES nodes(id),
        FOREIGN KEY (target_node_id) REFERENCES nodes(id)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_container ON chunks(container_tag)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_container ON nodes(container_tag)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_topic ON documents(topic_id)
    `);
  }

  // -------------------------------------------------------------------------
  // Topics
  // -------------------------------------------------------------------------

  createTopic(input: {
    tenantId: string;
    appId: string;
    name: string;
    description?: string;
  }): KnowledgeTopic {
    const id = randomUUID();
    const now = new Date().toISOString();
    const containerTag = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(0, 8)}`;

    this.db
      .prepare(
        `INSERT INTO topics (id, tenant_id, app_id, name, description, container_tag, document_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(id, input.tenantId, input.appId, input.name, input.description || '', containerTag, now, now);

    return {
      id,
      tenantId: input.tenantId,
      appId: input.appId,
      name: input.name,
      description: input.description || '',
      containerTag,
      documentCount: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  listTopics(tenantId: string, appId: string): KnowledgeTopic[] {
    return this.db
      .prepare(
        `SELECT id, tenant_id as tenantId, app_id as appId, name, description,
                container_tag as containerTag, document_count as documentCount,
                created_at as createdAt, updated_at as updatedAt
         FROM topics WHERE tenant_id = ? AND app_id = ? ORDER BY created_at DESC`
      )
      .all(tenantId, appId) as KnowledgeTopic[];
  }

  getTopic(topicId: string): KnowledgeTopic | null {
    return (
      (this.db
        .prepare(
          `SELECT id, tenant_id as tenantId, app_id as appId, name, description,
                  container_tag as containerTag, document_count as documentCount,
                  created_at as createdAt, updated_at as updatedAt
           FROM topics WHERE id = ?`
        )
        .get(topicId) as KnowledgeTopic | undefined) || null
    );
  }

  deleteTopic(topicId: string): void {
    // Delete all knowledge data for this topic
    const docs = this.db
      .prepare('SELECT id FROM documents WHERE topic_id = ?')
      .all(topicId) as Array<{ id: string }>;

    for (const doc of docs) {
      this.deleteDocumentKnowledge(doc.id);
    }

    this.db.prepare('DELETE FROM documents WHERE topic_id = ?').run(topicId);
    this.db.prepare('DELETE FROM topics WHERE id = ?').run(topicId);
  }

  // -------------------------------------------------------------------------
  // Document Upload + Ingestion
  // -------------------------------------------------------------------------

  async uploadDocumentVersion(input: UploadDocumentVersionInput): Promise<{
    documentId: string;
    documentVersionId: string;
    topicId: string;
  }> {
    const now = new Date().toISOString();

    // Resolve or create topic
    let topicId = input.topicId;
    let containerTag = input.containerTag;

    if (!topicId && input.topicName) {
      const existing = this.db
        .prepare('SELECT id, container_tag FROM topics WHERE tenant_id = ? AND app_id = ? AND name = ?')
        .get(input.tenantId, input.appId, input.topicName) as
        | { id: string; container_tag: string }
        | undefined;

      if (existing) {
        topicId = existing.id;
        containerTag = existing.container_tag;
      } else {
        const topic = this.createTopic({
          tenantId: input.tenantId,
          appId: input.appId,
          name: input.topicName,
        });
        topicId = topic.id;
        containerTag = topic.containerTag;
      }
    }

    if (!topicId) {
      throw new Error('topicId or topicName is required');
    }

    if (!containerTag) {
      const topic = this.getTopic(topicId);
      containerTag = topic?.containerTag || topicId;
    }

    // Decode content
    const fileBuffer = Buffer.from(input.content, 'base64');
    const contentHash = createHash('sha256').update(fileBuffer).digest('hex');

    // Store file locally
    const storageKey = `${topicId}/${randomUUID()}-${input.fileName}`;
    const filePath = path.join(this.storageDir, storageKey);
    fs.ensureDirSync(path.dirname(filePath));
    fs.writeFileSync(filePath, fileBuffer);

    // Create or find document
    let docRow = this.db
      .prepare('SELECT id, current_version FROM documents WHERE topic_id = ? AND title = ? AND is_deleted = 0')
      .get(topicId, input.title) as { id: string; current_version: number } | undefined;

    let documentId: string;
    let version: number;

    if (docRow) {
      documentId = docRow.id;
      version = docRow.current_version + 1;
      this.db
        .prepare('UPDATE documents SET current_version = ?, updated_at = ?, size_bytes = ? WHERE id = ?')
        .run(version, now, fileBuffer.length, documentId);
    } else {
      documentId = randomUUID();
      version = 1;
      this.db
        .prepare(
          `INSERT INTO documents (id, tenant_id, app_id, topic_id, title, file_name, file_type, size_bytes, current_version, is_deleted, storage_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
        )
        .run(
          documentId,
          input.tenantId,
          input.appId,
          topicId,
          input.title,
          input.fileName,
          input.fileType,
          fileBuffer.length,
          version,
          storageKey,
          now,
          now
        );

      // Increment topic document count
      this.db.prepare('UPDATE topics SET document_count = document_count + 1, updated_at = ? WHERE id = ?').run(now, topicId);
    }

    // Mark previous versions as not current
    this.db.prepare('UPDATE document_versions SET is_current = 0 WHERE document_id = ?').run(documentId);

    // Create document version
    const documentVersionId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO document_versions (id, document_id, version, size_bytes, content_hash, storage_key, mime_type, original_file_name, is_current, ingest_status, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'processing', ?, ?)`
      )
      .run(
        documentVersionId,
        documentId,
        version,
        fileBuffer.length,
        contentHash,
        storageKey,
        input.fileType,
        input.fileName,
        input.uploadedBy || '',
        now
      );

    // Run ingestion synchronously (local mode — no queue needed)
    try {
      const textContent = await extractText(fileBuffer, input.fileType || '', input.fileName || '');
      await this.ingestDocumentVersion(
        documentVersionId,
        documentId,
        topicId,
        containerTag!,
        input.tenantId,
        input.appId,
        textContent
      );

      this.db
        .prepare("UPDATE document_versions SET ingest_status = 'completed' WHERE id = ?")
        .run(documentVersionId);
    } catch (err) {
      console.error(`[LOCAL-KNOWLEDGE] Ingestion failed for version ${documentVersionId}:`, err);
      this.db
        .prepare("UPDATE document_versions SET ingest_status = 'failed' WHERE id = ?")
        .run(documentVersionId);
    }

    return { documentId, documentVersionId, topicId };
  }

  private async ingestDocumentVersion(
    documentVersionId: string,
    documentId: string,
    topicId: string,
    containerTag: string,
    tenantId: string,
    appId: string,
    textContent: string
  ): Promise<void> {
    // Clean up previous chunks/nodes/relations for this document
    this.deleteDocumentKnowledge(documentId);

    // Chunk the text
    const chunks = splitIntoChunks(textContent);
    if (chunks.length === 0) return;

    // Generate embeddings
    const embeddings = await generateEmbeddings(chunks);

    // Store chunks and embeddings
    const insertChunk = this.db.prepare(
      `INSERT INTO chunks (id, tenant_id, app_id, topic_id, document_id, document_version_id, container_tag, chunk_index, content, embedding_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertEmbedding = this.db.prepare(
      `INSERT INTO chunk_embeddings (chunk_id, embedding) VALUES (?, ?)`
    );

    const insertMany = this.db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = randomUUID();
        insertChunk.run(
          chunkId,
          tenantId,
          appId,
          topicId,
          documentId,
          documentVersionId,
          containerTag,
          i,
          chunks[i],
          EMBEDDING_MODEL
        );
        insertEmbedding.run(chunkId, new Float32Array(embeddings[i]));
      }
    });

    insertMany();

    // Extract entities (simple NER-like extraction from chunks)
    await this.extractAndStoreEntities(
      chunks,
      documentVersionId,
      containerTag,
      tenantId,
      appId
    );
  }

  private async extractAndStoreEntities(
    chunks: string[],
    documentVersionId: string,
    containerTag: string,
    tenantId: string,
    appId: string
  ): Promise<void> {
    // Simple entity extraction: use OpenAI if available, otherwise skip
    const apiKey = process.env.AGENTLANG_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) return;

    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey });

      // Process chunks in batches to extract entities
      const allText = chunks.slice(0, 5).join('\n\n'); // Limit to first 5 chunks for entity extraction
      const response = await client.chat.completions.create({
        model: process.env.AGENTLANG_LLM_MODEL || 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'Extract key entities and relationships from the text. Return JSON: {"entities": [{"name": "...", "entityType": "...", "description": "..."}], "relationships": [{"source": "...", "target": "...", "relType": "...", "description": "..."}]}',
          },
          { role: 'user', content: allText.slice(0, 8000) },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) return;

      const parsed = JSON.parse(content);
      const entities: Array<{ name: string; entityType: string; description: string }> =
        parsed.entities || [];
      const relationships: Array<{
        source: string;
        target: string;
        relType: string;
        description: string;
      }> = parsed.relationships || [];

      // Upsert nodes
      const upsertNode = this.db.prepare(
        `INSERT INTO nodes (id, tenant_id, app_id, container_tag, document_version_id, name, entity_type, description, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1.0)
         ON CONFLICT(container_tag, name, entity_type) DO UPDATE SET
           description = excluded.description,
           document_version_id = excluded.document_version_id`
      );

      const nodeIdMap = new Map<string, string>();

      this.db.transaction(() => {
        for (const entity of entities) {
          const nodeId = randomUUID();
          const key = `${entity.name}::${entity.entityType}`.toLowerCase();
          nodeIdMap.set(key, nodeId);
          upsertNode.run(
            nodeId,
            tenantId,
            appId,
            containerTag,
            documentVersionId,
            entity.name,
            entity.entityType,
            entity.description || ''
          );
        }
      })();

      // Resolve node IDs for relationships (look up by name+type)
      const findNode = this.db.prepare(
        'SELECT id FROM nodes WHERE container_tag = ? AND name = ? LIMIT 1'
      );

      const insertRelation = this.db.prepare(
        `INSERT INTO relations (id, tenant_id, app_id, container_tag, document_version_id, source_node_id, target_node_id, rel_type, weight)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1.0)`
      );

      this.db.transaction(() => {
        for (const rel of relationships) {
          const sourceRow = findNode.get(containerTag, rel.source) as { id: string } | undefined;
          const targetRow = findNode.get(containerTag, rel.target) as { id: string } | undefined;
          if (sourceRow && targetRow) {
            insertRelation.run(
              randomUUID(),
              tenantId,
              appId,
              containerTag,
              documentVersionId,
              sourceRow.id,
              targetRow.id,
              rel.relType || 'RELATED_TO'
            );
          }
        }
      })();
    } catch (err) {
      console.error('[LOCAL-KNOWLEDGE] Entity extraction failed (non-fatal):', err);
    }
  }

  // -------------------------------------------------------------------------
  // Knowledge Query (matching knowledge-service /api/knowledge/query contract)
  // -------------------------------------------------------------------------

  async query(input: {
    queryText: string;
    containerTags?: string[];
    chunkLimit?: number;
    entityLimit?: number;
  }): Promise<KnowledgeQueryResult> {
    const chunkLimit = input.chunkLimit || 10;
    const entityLimit = input.entityLimit || 20;

    // Generate query embedding
    const [queryEmbedding] = await generateEmbeddings([input.queryText]);

    // Vector similarity search via sqlite-vec
    let chunks: Array<{ id: string; content: string; similarity: number; containerTag: string }> =
      [];

    try {
      const vecQuery = input.containerTags?.length
        ? this.db.prepare(
            `SELECT ce.chunk_id, ce.distance, c.content, c.container_tag
             FROM chunk_embeddings ce
             JOIN chunks c ON c.id = ce.chunk_id
             WHERE c.container_tag IN (${input.containerTags.map(() => '?').join(',')})
             AND ce.embedding MATCH ?
             ORDER BY ce.distance
             LIMIT ?`
          )
        : this.db.prepare(
            `SELECT ce.chunk_id, ce.distance, c.content, c.container_tag
             FROM chunk_embeddings ce
             JOIN chunks c ON c.id = ce.chunk_id
             WHERE ce.embedding MATCH ?
             ORDER BY ce.distance
             LIMIT ?`
          );

      const params = input.containerTags?.length
        ? [...input.containerTags, new Float32Array(queryEmbedding), chunkLimit]
        : [new Float32Array(queryEmbedding), chunkLimit];

      const rows = vecQuery.all(...params) as Array<{
        chunk_id: string;
        distance: number;
        content: string;
        container_tag: string;
      }>;

      chunks = rows.map((r) => ({
        id: r.chunk_id,
        content: r.content,
        similarity: 1 - r.distance, // Convert distance to similarity
        containerTag: r.container_tag,
      }));
    } catch (err) {
      console.error('[LOCAL-KNOWLEDGE] Vector search failed:', err);
    }

    // Fetch entities for matching container tags
    let entities: Array<{
      id: string;
      name: string;
      entityType: string;
      description: string;
      confidence: number;
    }> = [];

    let edges: Array<{
      sourceId: string;
      targetId: string;
      relType: string;
      weight: number;
    }> = [];

    if (input.containerTags?.length) {
      const placeholders = input.containerTags.map(() => '?').join(',');

      entities = this.db
        .prepare(
          `SELECT id, name, entity_type as entityType, description, confidence
           FROM nodes WHERE container_tag IN (${placeholders})
           LIMIT ?`
        )
        .all(...input.containerTags, entityLimit) as typeof entities;

      edges = this.db
        .prepare(
          `SELECT source_node_id as sourceId, target_node_id as targetId, rel_type as relType, weight
           FROM relations WHERE container_tag IN (${placeholders})`
        )
        .all(...input.containerTags) as typeof edges;
    }

    // Build context string
    const contextParts: string[] = [];
    if (chunks.length > 0) {
      contextParts.push('## Relevant Document Excerpts\n');
      for (const chunk of chunks) {
        contextParts.push(`${chunk.content}\n---`);
      }
    }
    if (entities.length > 0) {
      contextParts.push('\n## Key Entities\n');
      for (const entity of entities) {
        contextParts.push(`- **${entity.name}** (${entity.entityType}): ${entity.description}`);
      }
    }

    return {
      chunks,
      entities,
      edges,
      contextString: contextParts.join('\n'),
    };
  }

  // -------------------------------------------------------------------------
  // Cleanup helpers
  // -------------------------------------------------------------------------

  deleteDocumentKnowledge(documentId: string): void {
    // Get chunk IDs for this document
    const chunkIds = this.db
      .prepare('SELECT id FROM chunks WHERE document_id = ?')
      .all(documentId) as Array<{ id: string }>;

    // Delete embeddings
    for (const { id } of chunkIds) {
      this.db.prepare('DELETE FROM chunk_embeddings WHERE chunk_id = ?').run(id);
    }

    // Delete chunks
    this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);

    // Delete nodes and relations for document versions
    const versionIds = this.db
      .prepare('SELECT id FROM document_versions WHERE document_id = ?')
      .all(documentId) as Array<{ id: string }>;

    for (const { id } of versionIds) {
      this.db.prepare('DELETE FROM relations WHERE document_version_id = ?').run(id);
      this.db.prepare('DELETE FROM nodes WHERE document_version_id = ?').run(id);
    }
  }

  softDeleteDocument(documentId: string): void {
    this.deleteDocumentKnowledge(documentId);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE documents SET is_deleted = 1, updated_at = ? WHERE id = ?').run(now, documentId);
  }

  // -------------------------------------------------------------------------
  // Document listing
  // -------------------------------------------------------------------------

  listDocuments(topicId: string, limit = 50, offset = 0): KnowledgeDocument[] {
    return this.db
      .prepare(
        `SELECT id, tenant_id as tenantId, app_id as appId, topic_id as topicId,
                title, file_name as fileName, file_type as fileType,
                size_bytes as sizeBytes, current_version as currentVersion,
                is_deleted as isDeleted, created_at as createdAt, updated_at as updatedAt
         FROM documents WHERE topic_id = ? AND is_deleted = 0
         ORDER BY created_at DESC LIMIT ? OFFSET ?`
      )
      .all(topicId, limit, offset) as KnowledgeDocument[];
  }

  // -------------------------------------------------------------------------
  // Ingestion jobs (local mode returns completed immediately)
  // -------------------------------------------------------------------------

  listIngestionJobs(containerTag: string): Array<{
    id: string;
    documentVersionId: string;
    status: string;
    progress: number;
    progressStage: string;
  }> {
    return this.db
      .prepare(
        `SELECT dv.id, dv.id as documentVersionId, dv.ingest_status as status,
                CASE WHEN dv.ingest_status = 'completed' THEN 100 ELSE 0 END as progress,
                dv.ingest_status as progressStage
         FROM document_versions dv
         JOIN documents d ON d.id = dv.document_id
         JOIN topics t ON t.id = d.topic_id
         WHERE t.container_tag = ?
         ORDER BY dv.created_at DESC`
      )
      .all(containerTag) as Array<{
      id: string;
      documentVersionId: string;
      status: string;
      progress: number;
      progressStage: string;
    }>;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
