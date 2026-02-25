import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs-extra';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import * as lancedb from '@lancedb/lancedb';
import { Schema, Field, Float32, Utf8, FixedSizeList, Int32 } from 'apache-arrow';

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
  chunks: { id: string; content: string; similarity: number; containerTag: string }[];
  entities: {
    id: string;
    name: string;
    entityType: string;
    description: string;
    confidence: number;
  }[];
  edges: {
    sourceId: string;
    targetId: string;
    relType: string;
    weight: number;
  }[];
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

  return response.data.map(d => d.embedding);
}

/**
 * Extract text content from a file buffer based on its file type.
 * Supports PDF, DOCX, HTML, JSON, and plain text.
 */
async function extractText(fileBuffer: Buffer, fileType: string, fileName: string): Promise<string> {
  const ext = (fileName || '').split('.').pop()?.toLowerCase() ?? '';

  // PDF extraction
  if (fileType === 'pdf' || ext === 'pdf') {
    try {
      const pdfParseModule = await import('pdf-parse');
      const pdfParse = (pdfParseModule as any).default || pdfParseModule;
      const result = await pdfParse(fileBuffer);
      return (result.text || '').trim();
    } catch (_err) {
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
    } catch (_err) {
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
    } catch (_err) {
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
// Neo4j helper — sanitize Cypher labels
// ---------------------------------------------------------------------------

function sanitizeCypherLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase();
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class LocalKnowledgeService {
  private db: Database.Database; // SQLite for metadata only
  private storageDir: string;
  private lanceConn: lancedb.Connection | null = null;
  private lanceTable: lancedb.Table | null = null;
  private neo4jDriver: any = null;
  private neo4jConnected = false;
  private lanceReady = false;
  private initPromise: Promise<void>;

  constructor(appPath: string) {
    const knowledgeDir = path.join(appPath, 'knowledge');
    fs.ensureDirSync(knowledgeDir);

    this.storageDir = path.join(knowledgeDir, 'files');
    fs.ensureDirSync(this.storageDir);

    // SQLite for metadata (topics, documents, versions)
    const dbPath = path.join(knowledgeDir, 'knowledge.db');
    this.db = new Database(dbPath);
    this.initializeMetadataSchema();

    // Async init for LanceDB + Neo4j
    this.initPromise = this.initAsyncStores(knowledgeDir);
  }

  private initializeMetadataSchema(): void {
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

    // Chunk metadata in SQLite (content + metadata, embeddings in LanceDB)
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

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_container ON chunks(container_tag)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_documents_topic ON documents(topic_id)
    `);
  }

  private async initAsyncStores(knowledgeDir: string): Promise<void> {
    // Initialize LanceDB
    try {
      const lancePath = path.join(knowledgeDir, 'lance');
      fs.ensureDirSync(lancePath);
      this.lanceConn = await lancedb.connect(lancePath);

      const tableNames = await this.lanceConn.tableNames();
      if (tableNames.includes('chunk_embeddings')) {
        this.lanceTable = await this.lanceConn.openTable('chunk_embeddings');
      } else {
        const schema = new Schema([
          new Field('id', new Utf8(), false),
          new Field('embedding', new FixedSizeList(EMBEDDING_DIMENSIONS, new Field('item', new Float32())), false),
          new Field('containerTag', new Utf8(), true),
          new Field('chunkIndex', new Int32(), true),
        ]);
        this.lanceTable = await this.lanceConn.createEmptyTable('chunk_embeddings', schema);
      }
      this.lanceReady = true;
      console.log('[LOCAL-KNOWLEDGE] LanceDB initialized');
    } catch (err) {
      console.warn('[LOCAL-KNOWLEDGE] LanceDB initialization failed:', err);
    }

    // Initialize Neo4j
    try {
      const neo4jUri = process.env.GRAPH_DB_URI || 'bolt://localhost:7687';
      const neo4jUser = process.env.GRAPH_DB_USER || 'neo4j';
      const neo4jPassword = process.env.GRAPH_DB_PASSWORD || 'password';

      const neo4jModule = await import('neo4j-driver');
      const neo4j = neo4jModule.default;
      this.neo4jDriver = neo4j.driver(neo4jUri, neo4j.auth.basic(neo4jUser, neo4jPassword));
      await this.neo4jDriver.verifyConnectivity();
      this.neo4jConnected = true;
      console.log(`[LOCAL-KNOWLEDGE] Neo4j connected at ${neo4jUri}`);
    } catch (err) {
      console.warn('[LOCAL-KNOWLEDGE] Neo4j not available — graph features disabled:', err);
    }
  }

  /** Wait for async stores to be ready */
  async ensureReady(): Promise<void> {
    await this.initPromise;
  }

  // -------------------------------------------------------------------------
  // Config Management
  // -------------------------------------------------------------------------

  /**
   * Update config.al to enable knowledge graph for the app
   */
  private async updateConfigForKnowledgeGraph(appId: string): Promise<void> {
    try {
      // Find the project root (look for config.al)
      const projectRoot = this.findProjectRoot();
      if (!projectRoot) {
        console.warn('[LOCAL-KNOWLEDGE] Could not find project root for config update');
        return;
      }

      const configPath = path.join(projectRoot, 'config.al');

      // Read existing config or create new one
      let config: any = {};
      if (await fs.pathExists(configPath)) {
        try {
          const configContent = await fs.readFile(configPath, 'utf-8');
          config = JSON.parse(configContent) || {};
        } catch (parseErr) {
          console.warn('[LOCAL-KNOWLEDGE] Failed to parse existing config.al, creating new one');
        }
      }

      // Check if knowledgeGraph section needs updating
      const needsUpdate =
        !config.knowledgeGraph || !config.knowledgeGraph.serviceUrl || config.knowledgeGraph.serviceUrl === '';

      if (needsUpdate) {
        // Add or update knowledgeGraph section
        config.knowledgeGraph = {
          ...config.knowledgeGraph,
          serviceUrl: 'http://localhost:4000',
          enabled: true,
        };

        // Write back the updated config
        await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
        console.log(`[LOCAL-KNOWLEDGE] Updated config.al for knowledge graph (appId: ${appId})`);
      } else {
        console.log(`[LOCAL-KNOWLEDGE] Knowledge graph already configured in config.al (appId: ${appId})`);
      }
    } catch (err) {
      // Don't throw - config update should not break topic creation
      console.warn('[LOCAL-KNOWLEDGE] Failed to update config.al:', err);
    }
  }

  /**
   * Find the project root directory by looking for config.al
   */
  private findProjectRoot(): string | null {
    let currentDir = process.cwd();
    const maxDepth = 10;
    let depth = 0;

    while (depth < maxDepth) {
      const configPath = path.join(currentDir, 'config.al');
      if (fs.pathExistsSync(configPath)) {
        return currentDir;
      }
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break; // Reached filesystem root
      currentDir = parentDir;
      depth++;
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Topics
  // -------------------------------------------------------------------------

  createTopic(input: {
    tenantId?: string;
    appId?: string;
    name: string;
    description?: string;
    documentTitles?: string[];
  }): KnowledgeTopic {
    const id = randomUUID();
    const now = new Date().toISOString();
    const containerTag = `${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(0, 8)}`;

    // Use defaults for agent-initiated topic creation
    const tenantId = input.tenantId || 'local';
    const appId = input.appId || this.getAppIdFromPath();

    this.db
      .prepare(
        `INSERT INTO topics (id, tenant_id, app_id, name, description, container_tag, document_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        tenantId,
        appId,
        input.name,
        input.description || '',
        containerTag,
        input.documentTitles?.length || 0,
        now,
        now,
      );

    // Associate documents if provided
    if (input.documentTitles && input.documentTitles.length > 0) {
      for (const docTitle of input.documentTitles) {
        try {
          // Find document by title
          const doc = this.db
            .prepare('SELECT id FROM documents WHERE title = ? AND app_id = ?')
            .get(docTitle, appId) as { id: string } | undefined;

          if (doc) {
            // Create topic-document association
            this.db
              .prepare(
                'INSERT INTO topic_documents (id, tenant_id, topic_id, document_id, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)',
              )
              .run(randomUUID(), tenantId, id, doc.id, 'system', now);
          }
        } catch (err) {
          console.warn(`[LOCAL-KNOWLEDGE] Failed to associate document ${docTitle}:`, err);
        }
      }
    }

    // Auto-update config.al for knowledge graph
    this.updateConfigForKnowledgeGraph(appId).catch(err => {
      console.warn('[LOCAL-KNOWLEDGE] Failed to update config.al:', err);
    });

    return {
      id,
      tenantId,
      appId,
      name: input.name,
      description: input.description || '',
      containerTag,
      documentCount: input.documentTitles?.length || 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Get app ID from project path
   */
  private getAppIdFromPath(): string {
    const projectRoot = this.findProjectRoot();
    if (projectRoot) {
      return path.basename(projectRoot);
    }
    return 'default';
  }

  listTopics(tenantId: string, appId: string): KnowledgeTopic[] {
    return this.db
      .prepare(
        `SELECT id, tenant_id as tenantId, app_id as appId, name, description,
                container_tag as containerTag, document_count as documentCount,
                created_at as createdAt, updated_at as updatedAt
         FROM topics WHERE tenant_id = ? AND app_id = ? ORDER BY created_at DESC`,
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
           FROM topics WHERE id = ?`,
        )
        .get(topicId) as KnowledgeTopic | undefined) || null
    );
  }

  async deleteTopic(topicId: string): Promise<void> {
    const docs = this.db.prepare('SELECT id FROM documents WHERE topic_id = ?').all(topicId) as { id: string }[];

    for (const doc of docs) {
      await this.deleteDocumentKnowledge(doc.id);
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
    await this.ensureReady();
    const now = new Date().toISOString();

    // Resolve or create topic
    let topicId = input.topicId;
    let containerTag = input.containerTag;

    if (!topicId && input.topicName) {
      const existing = this.db
        .prepare('SELECT id, container_tag FROM topics WHERE tenant_id = ? AND app_id = ? AND name = ?')
        .get(input.tenantId, input.appId, input.topicName) as { id: string; container_tag: string } | undefined;

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
    const docRow = this.db
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
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
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
          now,
        );

      // Increment topic document count
      this.db
        .prepare('UPDATE topics SET document_count = document_count + 1, updated_at = ? WHERE id = ?')
        .run(now, topicId);
    }

    // Mark previous versions as not current
    this.db.prepare('UPDATE document_versions SET is_current = 0 WHERE document_id = ?').run(documentId);

    // Create document version
    const documentVersionId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO document_versions (id, document_id, version, size_bytes, content_hash, storage_key, mime_type, original_file_name, is_current, ingest_status, uploaded_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'processing', ?, ?)`,
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
        now,
      );

    // Run ingestion synchronously (local mode — no queue needed)
    try {
      const textContent = await extractText(fileBuffer, input.fileType || '', input.fileName || '');
      await this.ingestDocumentVersion(
        documentVersionId,
        documentId,
        topicId,
        containerTag,
        input.tenantId,
        input.appId,
        textContent,
      );

      this.db.prepare("UPDATE document_versions SET ingest_status = 'completed' WHERE id = ?").run(documentVersionId);
    } catch (err) {
      console.error(`[LOCAL-KNOWLEDGE] Ingestion failed for version ${documentVersionId}:`, err);
      this.db.prepare("UPDATE document_versions SET ingest_status = 'failed' WHERE id = ?").run(documentVersionId);
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
    textContent: string,
  ): Promise<void> {
    // Clean up previous chunks/nodes/relations for this document
    await this.deleteDocumentKnowledge(documentId);

    // Chunk the text
    const chunks = splitIntoChunks(textContent);
    if (chunks.length === 0) return;

    // Generate embeddings
    const embeddings = await generateEmbeddings(chunks);

    // Store chunk metadata in SQLite
    const insertChunk = this.db.prepare(
      `INSERT INTO chunks (id, tenant_id, app_id, topic_id, document_id, document_version_id, container_tag, chunk_index, content, embedding_model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const chunkIds: string[] = [];
    const insertMany = this.db.transaction(() => {
      for (let i = 0; i < chunks.length; i++) {
        const chunkId = randomUUID();
        chunkIds.push(chunkId);
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
          EMBEDDING_MODEL,
        );
      }
    });
    insertMany();

    // Store embeddings in LanceDB
    if (this.lanceReady && this.lanceTable) {
      try {
        const records = chunkIds.map((id, i) => ({
          id,
          embedding: embeddings[i],
          containerTag,
          chunkIndex: i,
        }));
        await this.lanceTable.add(records);
      } catch (err) {
        console.error('[LOCAL-KNOWLEDGE] Failed to store embeddings in LanceDB:', err);
      }
    }

    // Extract entities and store in Neo4j
    await this.extractAndStoreEntities(chunks, documentVersionId, containerTag, tenantId, appId);
  }

  private async extractAndStoreEntities(
    chunks: string[],
    documentVersionId: string,
    containerTag: string,
    tenantId: string,
    appId: string,
  ): Promise<void> {
    const apiKey = process.env.AGENTLANG_OPENAI_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) return;
    if (!this.neo4jConnected || !this.neo4jDriver) {
      console.warn('[LOCAL-KNOWLEDGE] Neo4j not connected — skipping entity extraction');
      return;
    }

    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey });

      const allText = chunks.slice(0, 5).join('\n\n');
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
      const entities: { name: string; entityType: string; description: string }[] = parsed.entities || [];
      const relationships: {
        source: string;
        target: string;
        relType: string;
        description: string;
      }[] = parsed.relationships || [];

      // Upsert nodes in Neo4j
      const session = this.neo4jDriver.session();
      try {
        for (const entity of entities) {
          const nodeId = randomUUID();
          await session.run(
            `MERGE (n:KnowledgeNode {containerTag: $containerTag, name: $name, entityType: $entityType})
             ON CREATE SET n.id = $id, n.tenantId = $tenantId, n.appId = $appId,
                           n.documentVersionId = $documentVersionId, n.description = $description,
                           n.confidence = 1.0, n.createdAt = datetime()
             ON MATCH SET n.description = $description, n.documentVersionId = $documentVersionId,
                          n.updatedAt = datetime()
             RETURN n.id AS id`,
            {
              id: nodeId,
              containerTag,
              name: entity.name,
              entityType: entity.entityType,
              description: entity.description || '',
              tenantId,
              appId,
              documentVersionId,
            },
          );
        }

        // Create relationships in Neo4j
        for (const rel of relationships) {
          await session.run(
            `MATCH (a:KnowledgeNode {containerTag: $containerTag, name: $source})
             MATCH (b:KnowledgeNode {containerTag: $containerTag, name: $target})
             MERGE (a)-[r:${sanitizeCypherLabel(rel.relType || 'RELATED_TO')}]->(b)
             ON CREATE SET r.id = $id, r.containerTag = $containerTag,
                           r.documentVersionId = $documentVersionId,
                           r.weight = 1.0, r.createdAt = datetime()
             RETURN r`,
            {
              id: randomUUID(),
              containerTag,
              source: rel.source,
              target: rel.target,
              documentVersionId,
            },
          );
        }
      } finally {
        await session.close();
      }
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
    await this.ensureReady();
    const chunkLimit = input.chunkLimit || 10;
    const entityLimit = input.entityLimit || 20;

    // Generate query embedding
    const [queryEmbedding] = await generateEmbeddings([input.queryText]);

    // Vector similarity search via LanceDB
    const chunks: { id: string; content: string; similarity: number; containerTag: string }[] = [];

    if (this.lanceReady && this.lanceTable) {
      try {
        let searchQuery = this.lanceTable.vectorSearch(queryEmbedding).limit(chunkLimit);

        if (input.containerTags?.length) {
          const tagFilter = input.containerTags.map(t => `containerTag = '${t.replace(/'/g, "''")}'`).join(' OR ');
          searchQuery = searchQuery.where(`(${tagFilter})`);
        }

        const results = await searchQuery.toArray();

        // Look up chunk content from SQLite metadata
        for (const row of results) {
          const chunkRow = this.db.prepare('SELECT content, container_tag FROM chunks WHERE id = ?').get(row.id) as
            | { content: string; container_tag: string }
            | undefined;

          if (chunkRow) {
            chunks.push({
              id: row.id,
              content: chunkRow.content,
              similarity: 1 - (row._distance || 0),
              containerTag: chunkRow.container_tag,
            });
          }
        }
      } catch (err) {
        console.error('[LOCAL-KNOWLEDGE] LanceDB vector search failed:', err);
      }
    }

    // Fetch entities and edges from Neo4j
    let entities: {
      id: string;
      name: string;
      entityType: string;
      description: string;
      confidence: number;
    }[] = [];

    let edges: {
      sourceId: string;
      targetId: string;
      relType: string;
      weight: number;
    }[] = [];

    if (this.neo4jConnected && this.neo4jDriver && input.containerTags?.length) {
      const session = this.neo4jDriver.session();
      try {
        // Fetch nodes
        const nodeResult = await session.run(
          `MATCH (n:KnowledgeNode)
           WHERE n.containerTag IN $containerTags
           RETURN n.id AS id, n.name AS name, n.entityType AS entityType,
                  n.description AS description, n.confidence AS confidence
           LIMIT $limit`,
          { containerTags: input.containerTags, limit: entityLimit },
        );

        entities = nodeResult.records.map((r: any) => ({
          id: r.get('id'),
          name: r.get('name'),
          entityType: r.get('entityType') || '',
          description: r.get('description') || '',
          confidence: r.get('confidence') || 1.0,
        }));

        // Fetch edges
        const edgeResult = await session.run(
          `MATCH (a:KnowledgeNode)-[r]->(b:KnowledgeNode)
           WHERE a.containerTag IN $containerTags
           RETURN a.id AS sourceId, b.id AS targetId, type(r) AS relType,
                  COALESCE(r.weight, 1.0) AS weight`,
          { containerTags: input.containerTags },
        );

        edges = edgeResult.records.map((r: any) => ({
          sourceId: r.get('sourceId'),
          targetId: r.get('targetId'),
          relType: r.get('relType'),
          weight: typeof r.get('weight') === 'object' ? r.get('weight').toNumber() : r.get('weight'),
        }));
      } catch (err) {
        console.error('[LOCAL-KNOWLEDGE] Neo4j query failed:', err);
      } finally {
        await session.close();
      }
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

  async deleteDocumentKnowledge(documentId: string): Promise<void> {
    // Get chunk IDs for this document
    const chunkIds = this.db.prepare('SELECT id FROM chunks WHERE document_id = ?').all(documentId) as {
      id: string;
    }[];

    // Delete embeddings from LanceDB
    if (this.lanceReady && this.lanceTable && chunkIds.length > 0) {
      try {
        for (const { id } of chunkIds) {
          await this.lanceTable.delete(`id = '${id.replace(/'/g, "''")}'`);
        }
      } catch (err) {
        console.error('[LOCAL-KNOWLEDGE] Failed to delete embeddings from LanceDB:', err);
      }
    }

    // Delete chunks from SQLite
    this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);

    // Delete nodes and relations from Neo4j
    if (this.neo4jConnected && this.neo4jDriver) {
      const versionIds = this.db
        .prepare('SELECT id FROM document_versions WHERE document_id = ?')
        .all(documentId) as { id: string }[];

      if (versionIds.length > 0) {
        const session = this.neo4jDriver.session();
        try {
          const ids = versionIds.map(v => v.id);
          await session.run(
            `MATCH (n:KnowledgeNode)
             WHERE n.documentVersionId IN $versionIds
             DETACH DELETE n`,
            { versionIds: ids },
          );
        } catch (err) {
          console.error('[LOCAL-KNOWLEDGE] Failed to delete nodes from Neo4j:', err);
        } finally {
          await session.close();
        }
      }
    }
  }

  async softDeleteDocument(documentId: string): Promise<void> {
    await this.deleteDocumentKnowledge(documentId);
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
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(topicId, limit, offset) as KnowledgeDocument[];
  }

  // -------------------------------------------------------------------------
  // Ingestion jobs (local mode returns completed immediately)
  // -------------------------------------------------------------------------

  listIngestionJobs(containerTag: string): {
    id: string;
    documentVersionId: string;
    status: string;
    progress: number;
    progressStage: string;
  }[] {
    return this.db
      .prepare(
        `SELECT dv.id, dv.id as documentVersionId, dv.ingest_status as status,
                CASE WHEN dv.ingest_status = 'completed' THEN 100 ELSE 0 END as progress,
                dv.ingest_status as progressStage
         FROM document_versions dv
         JOIN documents d ON d.id = dv.document_id
         JOIN topics t ON t.id = d.topic_id
         WHERE t.container_tag = ?
         ORDER BY dv.created_at DESC`,
      )
      .all(containerTag) as {
      id: string;
      documentVersionId: string;
      status: string;
      progress: number;
      progressStage: string;
    }[];
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    this.db.close();

    if (this.lanceTable) {
      this.lanceTable = null;
    }
    if (this.lanceConn) {
      this.lanceConn = null;
    }

    if (this.neo4jDriver) {
      await this.neo4jDriver.close();
      this.neo4jDriver = null;
      this.neo4jConnected = false;
    }
  }
}
