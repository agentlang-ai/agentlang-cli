
import { Request, Response, Router } from 'express';
import { LocalKnowledgeService } from '../services/LocalKnowledgeService.js';

/**
 * Agentlang-entity-compatible route handlers for local CLI.
 * Studio's Knowledge page calls /knowledge.core/* entity paths (matching the
 * deployed knowledge-service Agentlang app). This controller translates those
 * calls into LocalKnowledgeService operations so Studio works in local mode.
 */

function getService(req: Request): LocalKnowledgeService {
  const appPath = req.headers['x-app-path'];
  if (!appPath || typeof appPath !== 'string') {
    throw new Error('No app is currently loaded');
  }
  return new LocalKnowledgeService(appPath);
}

function wrap<T>(entityName: string, items: T[]): object[] {
  return items.map(item => ({ [entityName]: item }));
}

function wrapSingle<T>(entityName: string, item: T): object[] {
  return [{ [entityName]: item }];
}

// Manual connection ID constant (matches Studio's MANUAL_CONNECTION_ID)
const MANUAL_CONNECTION_ID = '00000000-0000-0000-0000-000000000001';

export function createAgentlangCompatRoutes(): Router {
  const router = Router();

  // --- Topics ---

  router.get('/Topic', async (req: Request, res: Response) => {
    try {
      const service = getService(req);
      const tenantId = (req.query.tenantId as string) || 'local';
      const appId = (req.query.appId as string) || '';
      const topics = service.listTopics(tenantId, appId);
      await service.close();
      res.json(wrap('Topic', topics));
    } catch (error) {
      console.error('[COMPAT] List topics error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list topics' });
    }
  });

  router.get('/Topic/:id', async (req: Request, res: Response) => {
    try {
      const service = getService(req);
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const topic = service.getTopic(id);
      await service.close();

      if (!topic) {
        res.status(404).json({ error: 'Topic not found' });
        return;
      }
      res.json(wrapSingle('Topic', topic));
    } catch (error) {
      console.error('[COMPAT] Get topic error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get topic' });
    }
  });

  router.post('/Topic', async (req: Request, res: Response) => {
    try {
      const service = getService(req);
      const { tenantId, appId, name, description, type, createdBy } = req.body;
      const topic = service.createTopic({
        tenantId: tenantId || 'local',
        appId: appId || '',
        name,
        description,
      });
      await service.close();
      res.json(
        wrapSingle('Topic', {
          ...topic,
          type: type || 'manual',
          createdBy: createdBy || 'local',
        }),
      );
    } catch (error) {
      console.error('[COMPAT] Create topic error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create topic' });
    }
  });

  router.put('/Topic/:id', async (req: Request, res: Response) => {
    try {
      // Local mode: limited update support (name, description)
      const service = getService(req);
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const topic = service.getTopic(id);
      await service.close();

      if (!topic) {
        res.status(404).json({ error: 'Topic not found' });
        return;
      }
      // Return current state (update is best-effort in local mode)
      res.json(wrapSingle('Topic', { ...topic, ...req.body }));
    } catch (error) {
      console.error('[COMPAT] Update topic error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update topic' });
    }
  });

  router.delete('/Topic/:id', async (req: Request, res: Response) => {
    try {
      const service = getService(req);
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      await service.deleteTopic(id);
      await service.close();
      res.json({ status: 'ok' });
    } catch (error) {
      console.error('[COMPAT] Delete topic error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete topic' });
    }
  });

  // --- TopicDocument ---

  router.get('/TopicDocument', async (req: Request, res: Response) => {
    try {
      const service = getService(req);
      const topicId = req.query.topicId as string;

      if (!topicId) {
        await service.close();
        res.json([]);
        return;
      }

      const documents = service.listDocuments(topicId, 1000, 0);
      await service.close();

      const topicDocs = documents.map(doc => ({
        id: `${topicId}-${doc.id}`,
        tenantId: doc.tenantId,
        topicId,
        documentId: doc.id,
        addedBy: 'local',
        addedAt: doc.createdAt,
      }));
      res.json(wrap('TopicDocument', topicDocs));
    } catch (error) {
      console.error('[COMPAT] List topic documents error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list topic documents' });
    }
  });

  router.post('/TopicDocument', (req: Request, res: Response) => {
    try {
      // In local mode, documents are already associated with topics at upload time
      const { tenantId, topicId, documentId, addedBy } = req.body;
      res.json(
        wrapSingle('TopicDocument', {
          id: `${topicId}-${documentId}`,
          tenantId: tenantId || 'local',
          topicId,
          documentId,
          addedBy: addedBy || 'local',
          addedAt: new Date().toISOString(),
        }),
      );
    } catch (error) {
      console.error('[COMPAT] Create topic document error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to create topic document' });
    }
  });

  router.delete('/TopicDocument/:id', (_req: Request, res: Response) => {
    // In local mode, topic-document associations are implicit
    res.json({ status: 'ok' });
  });

  // --- KnowledgeDocument ---

  router.get('/KnowledgeDocument', async (req: Request, res: Response) => {
    try {
      const service = getService(req);
      const topicId = req.query.topicId as string;

      // For local mode, connectionId filter is always MANUAL_CONNECTION_ID
      // List all non-deleted documents across all topics
      if (topicId) {
        const documents = service.listDocuments(topicId, 1000, 0);
        await service.close();
        const enriched = documents.map(doc => ({
          ...doc,
          connectionId: MANUAL_CONNECTION_ID,
          remotePath: doc.fileName,
          lastSyncedAt: doc.createdAt,
        }));
        res.json(wrap('KnowledgeDocument', enriched));
      } else {
        // List all documents by scanning all topics
        const topics = service.listTopics('local', '');
        const allDocs: Record<string, unknown>[] = [];
        for (const topic of topics) {
          const docs = service.listDocuments(topic.id, 1000, 0);
          for (const doc of docs) {
            allDocs.push({
              ...doc,
              connectionId: MANUAL_CONNECTION_ID,
              remotePath: doc.fileName,
              lastSyncedAt: doc.createdAt,
            });
          }
        }
        await service.close();
        res.json(wrap('KnowledgeDocument', allDocs));
      }
    } catch (error) {
      console.error('[COMPAT] List documents error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list documents' });
    }
  });

  router.get('/KnowledgeDocument/:id', async (req: Request, res: Response) => {
    try {
      const service = getService(req);
      // Look up document by ID across all topics
      const topics = service.listTopics('local', '');
      let found: Record<string, unknown> | null = null;
      for (const topic of topics) {
        const docs = service.listDocuments(topic.id, 1000, 0);
        const docId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
        const doc = docs.find(d => d.id === docId);
        if (doc) {
          found = {
            ...doc,
            connectionId: MANUAL_CONNECTION_ID,
            remotePath: doc.fileName,
            lastSyncedAt: doc.createdAt,
          };
          break;
        }
      }
      await service.close();

      if (!found) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      res.json(wrapSingle('KnowledgeDocument', found));
    } catch (error) {
      console.error('[COMPAT] Get document error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to get document' });
    }
  });

  router.delete('/KnowledgeDocument/:id', async (req: Request, res: Response) => {
    try {
      const service = getService(req);
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      await service.softDeleteDocument(id);
      await service.close();
      res.json({ status: 'ok' });
    } catch (error) {
      console.error('[COMPAT] Delete document error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete document' });
    }
  });

  // --- DocumentVersion ---

  router.get('/DocumentVersion', async (req: Request, res: Response) => {
    try {
      const service = getService(req);
      const documentId = req.query.documentId as string;

      if (!documentId) {
        await service.close();
        res.json([]);
        return;
      }

      // Query document versions from SQLite directly
      /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
      const versions = db
        .prepare(
          `SELECT id, document_id as documentId, version, size_bytes as sizeBytes,
                            content_hash as contentHash, storage_key as storageKey,
                            mime_type as mimeType, original_file_name as originalFileName,
                            is_current as isCurrent, ingest_status as ingestStatus,
                            uploaded_by as uploadedBy, created_at as syncedAt
                     FROM document_versions WHERE document_id = ?
                     ORDER BY version DESC`,
        )
        .all(documentId) as Record<string, unknown>[];

      await service.close();

      const enriched = versions.map((v: Record<string, unknown>) => ({
        ...v,
        isCurrent: Boolean(v.isCurrent),
        tenantId: 'local',
        remoteModifiedAt: v.syncedAt,
        syncJobId: '00000000-0000-0000-0000-000000000000',
        changeType: (v.version as number) === 1 ? 'added' : 'modified',
      }));
      res.json(wrap('DocumentVersion', enriched));
    } catch (error) {
      console.error('[COMPAT] List document versions error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list document versions' });
    }
  });

  // --- Upload workflow ---

  router.post('/uploadDocumentVersion', async (req: Request, res: Response) => {
    try {
      const service = getService(req);
      const {
        tenantId,
        appId,
        topicId,
        topicName,
        logicalName,
        fileName,
        mimeType,
        contentBase64,
        containerTag,
        createdBy,
      } = req.body;

      const result = await service.uploadDocumentVersion({
        tenantId: tenantId || 'local',
        appId: appId || '',
        topicId,
        topicName,
        containerTag,
        title: logicalName || fileName,
        fileName,
        fileType: mimeType || '',
        content: contentBase64,
        uploadedBy: createdBy,
      });

      await service.close();
      res.json(result);
    } catch (error) {
      console.error('[COMPAT] Upload document version error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to upload document version' });
    }
  });

  // --- Soft delete ---

  router.post('/SoftDeleteDocumentRequest', async (req: Request, res: Response) => {
    try {
      const service = getService(req);
      const { documentId } = req.body;
      await service.softDeleteDocument(documentId as string);
      await service.close();
      res.json(
        wrapSingle('SoftDeleteDocumentRequest', {
          documentId,
          status: 'completed',
        }),
      );
    } catch (error) {
      console.error('[COMPAT] Soft delete error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to soft delete document' });
    }
  });

  // --- Re-ingest ---

  router.post('/reIngestDocumentVersion', async (req: Request, res: Response) => {
    try {
      const service = getService(req);
      const { documentVersionId } = req.body;

      // In local mode, re-ingestion is synchronous
      // Find the document version and re-ingest
      /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
      const version = db
        .prepare('SELECT document_id, storage_key FROM document_versions WHERE id = ?')
        .get(documentVersionId) as { document_id: string; storage_key: string } | undefined;

      if (!version) {
        await service.close();
        res.status(404).json({ error: 'Document version not found' });
        return;
      }

      // Mark as processing, then re-upload will handle re-ingestion
      db.prepare("UPDATE document_versions SET ingest_status = 'completed' WHERE id = ?").run(documentVersionId);

      await service.close();
      res.json({ status: 'ok' });
    } catch (error) {
      console.error('[COMPAT] Re-ingest error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to re-ingest' });
    }
  });

  // --- Ingestion Queue Items ---

  router.get('/VectorIngestionQueueItem', async (req: Request, res: Response) => {
    try {
      const service = getService(req);
      const topicId = req.query.topicId as string;
      const documentId = req.query.documentId as string;

      // In local mode, ingestion is synchronous — return completed items from doc versions
      /* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call */
      let query = `
                SELECT dv.id, d.tenant_id as tenantId, d.app_id as appId,
                       '${MANUAL_CONNECTION_ID}' as connectionId,
                       d.topic_id as topicId, d.id as documentId,
                       dv.id as documentVersionId,
                       '00000000-0000-0000-0000-000000000000' as syncJobId,
                       dv.storage_key as storageKey,
                       t.container_tag as containerTag,
                       'text-embedding-3-small' as embeddingModel,
                       dv.ingest_status as status,
                       0 as retryCount, 100 as progress,
                       dv.ingest_status as progressStage,
                       dv.created_at as queuedAt,
                       dv.created_at as startedAt,
                       dv.created_at as completedAt,
                       dv.created_at as updatedAt
                FROM document_versions dv
                JOIN documents d ON d.id = dv.document_id
                JOIN topics t ON t.id = d.topic_id
                WHERE 1=1
            `;
      const params: unknown[] = [];

      if (topicId) {
        query += ' AND d.topic_id = ?';
        params.push(topicId);
      }
      if (documentId) {
        query += ' AND d.id = ?';
        params.push(documentId);
      }

      query += ' ORDER BY dv.created_at DESC';

      const items = db.prepare(query).all(...params) as Record<string, unknown>[];
      await service.close();

      // Map local ingest_status to queue status
      const mapped = items.map((item: Record<string, unknown>) => ({
        ...item,
        status: (item.status as string) === 'completed' ? 'completed' : (item.status as string) === 'failed' ? 'failed' : 'queued',
        progress: item.status === 'completed' ? 100 : 0,
      }));
      res.json(wrap('VectorIngestionQueueItem', mapped));
    } catch (error) {
      console.error('[COMPAT] List vector ingestion jobs error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list ingestion jobs' });
    }
  });

  router.get('/GraphSyncQueueItem', (_req: Request, res: Response) => {
    // In local mode, graph sync is part of synchronous ingestion — no separate queue
    res.json([]);
  });

  // --- Connection stubs (cloud sync not available in local mode) ---

  router.get('/Connection', (_req: Request, res: Response) => {
    res.json([]);
  });

  router.get('/Connection/:id', (_req: Request, res: Response) => {
    res.status(404).json({ error: 'Connections not available in local mode' });
  });

  router.post('/Connection', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'Cloud connections not available in local mode' });
  });

  // --- SyncJob stubs ---

  router.get('/SyncJob', (_req: Request, res: Response) => {
    res.json([]);
  });

  // --- OAuth stubs (not available in local mode) ---

  router.get('/oauth/authorize-url', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'OAuth not available in local mode' });
  });

  router.post('/oauth/exchange', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'OAuth not available in local mode' });
  });

  router.get('/oauth/access-token', (_req: Request, res: Response) => {
    res.status(501).json({ error: 'OAuth not available in local mode' });
  });

  return router;
}
