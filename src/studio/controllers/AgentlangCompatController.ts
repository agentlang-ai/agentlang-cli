import { Request, Response, Router } from 'express';
import { KnowledgeServiceManager } from '../services/KnowledgeServiceManager.js';
import type { Document, TopicDocument } from '../services/types.js';

/**
import { KnowledgeServiceManager } from '../services/KnowledgeServiceManager.js';

/**
 * Agentlang-entity-compatible route handlers for local CLI.
 * Studio's Knowledge page calls /knowledge.core/* entity paths (matching the
 * deployed knowledge-service Agentlang app). This controller proxies those
 * calls to the external knowledge-service.
 */

// Cache the manager instance
let manager: KnowledgeServiceManager | null = null;

function getManager(): KnowledgeServiceManager {
  if (!manager) {
    manager = new KnowledgeServiceManager({});
  }
  return manager;
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
      const proxy = getManager().getProxy();
      const tenantId = (req.query.tenantId as string) || 'local';
      const appId = (req.query.appId as string) || '';
      const topics = await proxy.listTopics(tenantId, appId);
      res.json(wrap('Topic', topics));
    } catch (error) {
      console.error('[COMPAT] List topics error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list topics' });
    }
  });

  router.get('/Topic/:id', async (req: Request, res: Response) => {
    try {
      const proxy = getManager().getProxy();
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const topics = await proxy.listTopics('local', '');
      const topic = topics.find((t: { id: string }) => t.id === id);

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
      const proxy = getManager().getProxy();
      const { tenantId, appId, name, description, type, createdBy } = req.body;
      const topic = await proxy.createTopic({
        tenantId: tenantId || 'local',
        appId: appId || '',
        name,
        description,
        documentTitles: [],
      });
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
      const proxy = getManager().getProxy();
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const topics = await proxy.listTopics('local', '');
      const topic = topics.find((t: { id: string }) => t.id === id);

      if (!topic) {
        res.status(404).json({ error: 'Topic not found' });
        return;
      }
      // Return current state with updates merged
      res.json(wrapSingle('Topic', { ...topic, ...req.body }));
    } catch (error) {
      console.error('[COMPAT] Update topic error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to update topic' });
    }
  });

  router.delete('/Topic/:id', async (req: Request, res: Response) => {
    try {
      const proxy = getManager().getProxy();
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      await proxy.deleteTopic(id);
      res.json({ status: 'ok' });
    } catch (error) {
      console.error('[COMPAT] Delete topic error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete topic' });
    }
  });

  // --- TopicDocument ---

  router.get('/TopicDocument', async (req: Request, res: Response) => {
    try {
      const proxy = getManager().getProxy();
      const topicId = req.query.topicId as string;

      if (!topicId) {
        res.json([]);
        return;
      }

      const result = await proxy.listDocuments(topicId, {
        tenantId: 'local',
        appId: '',
        page: 1,
        pageSize: 1000,
      });
      const topicDocs: TopicDocument[] = result.documents.map((doc: Document) => ({
        id: `${topicId}-${doc.id}`,
        tenantId: doc.tenantId || 'local',
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

  router.post('/TopicDocument', (_req: Request, res: Response) => {
    try {
      // In local mode, documents are already associated with topics at upload time
      const { tenantId, topicId, documentId, addedBy } = _req.body;
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
      const proxy = getManager().getProxy();
      const topicId = req.query.topicId as string;

      if (topicId) {
        const result = await proxy.listDocuments(topicId, { tenantId: 'local', appId: '', page: 1, pageSize: 1000 });
        const enriched = result.documents.map((doc: { id: string; fileName: string; createdAt: string }) => ({
          ...doc,
          connectionId: MANUAL_CONNECTION_ID,
          remotePath: doc.fileName,
          lastSyncedAt: doc.createdAt,
        }));
        res.json(wrap('KnowledgeDocument', enriched));
      } else {
        // List all documents by scanning all topics
        const topics = await proxy.listTopics('local', '');
        const allDocs: Record<string, unknown>[] = [];
        for (const topic of topics) {
          const result = await proxy.listDocuments(topic.id, { tenantId: 'local', appId: '', page: 1, pageSize: 1000 });
          for (const doc of result.documents) {
            allDocs.push({
              ...doc,
              connectionId: MANUAL_CONNECTION_ID,
              remotePath: (doc as { fileName: string }).fileName,
              lastSyncedAt: (doc as { createdAt: string }).createdAt,
            });
          }
        }
        res.json(wrap('KnowledgeDocument', allDocs));
      }
    } catch (error) {
      console.error('[COMPAT] List documents error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list documents' });
    }
  });

  router.get('/KnowledgeDocument/:id', async (req: Request, res: Response) => {
    try {
      const proxy = getManager().getProxy();
      // Look up document by ID across all topics
      const topics = await proxy.listTopics('local', '');
      let found: Record<string, unknown> | null = null;
      const docId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

      for (const topic of topics) {
        const result = await proxy.listDocuments(topic.id, { tenantId: 'local', appId: '', page: 1, pageSize: 1000 });
        const doc = result.documents.find((d: { id: string }) => d.id === docId);
        if (doc) {
          found = {
            ...doc,
            connectionId: MANUAL_CONNECTION_ID,
            remotePath: (doc as { fileName: string }).fileName,
            lastSyncedAt: (doc as { createdAt: string }).createdAt,
          };
          break;
        }
      }

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
      const proxy = getManager().getProxy();
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      await proxy.deleteDocument(id);
      res.json({ status: 'ok' });
    } catch (error) {
      console.error('[COMPAT] Delete document error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete document' });
    }
  });

  // --- Upload workflow ---

  router.post('/uploadDocumentVersion', async (req: Request, res: Response) => {
    try {
      const proxy = getManager().getProxy();
      const {
        tenantId,
        appId,
        topicId,
        fileName,
        mimeType,
        contentBase64,
        createdBy,
      } = req.body as {
        tenantId: string;
        appId: string;
        topicId: string;
        fileName: string;
        mimeType: string;
        contentBase64: string;
        createdBy: string;
      };

      const result = await proxy.uploadDocument(
        topicId,
        Buffer.from(contentBase64, 'base64'),
        fileName,
        mimeType || '',
        {
          tenantId: tenantId || 'local',
          appId: appId || '',
          uploadedBy: createdBy,
        },
      );

      res.json(result);
    } catch (error) {
      console.error('[COMPAT] Upload document version error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to upload document version' });
    }
  });

  // --- Soft delete ---

  router.post('/SoftDeleteDocumentRequest', async (req: Request, res: Response) => {
    try {
      const proxy = getManager().getProxy();
      const { documentId } = req.body;
      await proxy.deleteDocument(documentId as string);
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

  router.post('/reIngestDocumentVersion', (_req: Request, res: Response) => {
    try {
      // In external service mode, re-ingestion is handled by the service
      res.json({ status: 'ok' });
    } catch (error) {
      console.error('[COMPAT] Re-ingest error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to re-ingest' });
    }
  });

  // --- Ingestion Queue Items ---

  router.get('/VectorIngestionQueueItem', async (req: Request, res: Response) => {
    try {
      const proxy = getManager().getProxy();
      const containerTag = (req.query.containerTag as string) || '';
      const jobs = await proxy.listJobs(containerTag);

      // Map to expected format
      const mapped = jobs.map((job: { id: string; status: string; progress: number }) => ({
        ...job,
        status: job.status === 'completed' ? 'completed' : job.status === 'failed' ? 'failed' : 'queued',
        progress: job.progress || 0,
      }));

      res.json(wrap('VectorIngestionQueueItem', mapped));
    } catch (error) {
      console.error('[COMPAT] List vector ingestion jobs error:', error);
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to list ingestion jobs' });
    }
  });

  router.get('/GraphSyncQueueItem', (_req: Request, res: Response) => {
    // Graph sync is handled by the external service
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
