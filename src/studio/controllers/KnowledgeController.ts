import { Request, Response } from 'express';
import { KnowledgeServiceManager } from '../services/KnowledgeServiceManager.js';

/**
 * Controller that proxies all knowledge API requests to knowledge-service.
 *
 * This replaces the LocalKnowledgeService with a proxy pattern that forwards
 * all requests to a local instance of knowledge-service running in LanceDB mode.
 */
export class KnowledgeController {
  private manager: KnowledgeServiceManager | null = null;

  private async getManager(): Promise<KnowledgeServiceManager> {
    if (!this.manager) {
      this.manager = new KnowledgeServiceManager({});
      await this.manager.ensureAvailable();
    }
    return this.manager;
  }

  // POST /api/knowledge/query
  query = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      if (!appPath || typeof appPath !== 'string') {
        res.status(400).json({ error: 'x-app-path header is required' });
        return;
      }

      const manager = await this.getManager();
      const proxy = manager.getProxy();

      const {
        query,
        queryText,
        containerTags,
        containerTagsJson,
        chunkLimit,
        entityLimit,
      } = req.body as {
        query?: string;
        queryText?: string;
        containerTags?: string[];
        containerTagsJson?: string;
        chunkLimit?: number;
        entityLimit?: number;
      };

      const resolvedQuery = query || queryText || '';
      const resolvedTags: string[] =
        (containerTags) ||
        (containerTagsJson ? (JSON.parse(containerTagsJson) as string[]) : []);

      const result = await proxy.query(resolvedQuery, resolvedTags, {
        chunkLimit: chunkLimit || 5,
        entityLimit: entityLimit || 10,
      });

      res.json(result);

      res.json(result);
    } catch (error) {
      console.error('[KNOWLEDGE-PROXY] Query error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Knowledge query failed',
      });
    }
  };

  // POST /api/knowledge/topics
  createTopic = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      if (!appPath || typeof appPath !== 'string') {
        res.status(400).json({ error: 'x-app-path header is required' });
        return;
      }

      const manager = await this.getManager();
      const proxy = manager.getProxy();

      const { tenantId, appId, name, description, documentTitles } = req.body;

      const topic = await proxy.createTopic({
        tenantId,
        appId,
        name,
        description,
        documentTitles,
      });

      res.json(topic);
    } catch (error) {
      console.error('[KNOWLEDGE-PROXY] Create topic error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to create topic',
      });
    }
  };

  // GET /api/knowledge/topics
  listTopics = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      if (!appPath || typeof appPath !== 'string') {
        res.status(400).json({ error: 'x-app-path header is required' });
        return;
      }

      const manager = await this.getManager();
      const proxy = manager.getProxy();

      const tenantId = (req.query.tenantId as string) || undefined;
      const appId = (req.query.appId as string) || undefined;

      const topics = await proxy.listTopics(tenantId, appId);

      res.json(topics);
    } catch (error) {
      console.error('[KNOWLEDGE-PROXY] List topics error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to list topics',
      });
    }
  };

  // DELETE /api/knowledge/topics/:topicId
  deleteTopic = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      if (!appPath || typeof appPath !== 'string') {
        res.status(400).json({ error: 'x-app-path header is required' });
        return;
      }

      const manager = await this.getManager();
      const proxy = manager.getProxy();

      const topicId = typeof req.params.topicId === 'string' ? req.params.topicId : req.params.topicId?.[0] || '';

      await proxy.deleteTopic(topicId);

      res.json({ success: true });
    } catch (error) {
      console.error('[KNOWLEDGE-PROXY] Delete topic error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to delete topic',
      });
    }
  };

  // POST /api/knowledge/topics/:topicId/documents:upload
  uploadDocument = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      if (!appPath || typeof appPath !== 'string') {
        res.status(400).json({ error: 'x-app-path header is required' });
        return;
      }

      const manager = await this.getManager();
      const proxy = manager.getProxy();

      const topicId = typeof req.params.topicId === 'string' ? req.params.topicId : req.params.topicId?.[0] || '';

      const {
        tenantId,
        appId,
        title,
        fileName,
        fileType: docFileType,
        content,
        uploadedBy,
      } = req.body as {
        tenantId?: string;
        appId?: string;
        title?: string;
        fileName?: string;
        fileType?: string;
        content?: string;
        uploadedBy?: string;
      };

      if (!content) {
        res.status(400).json({ error: 'Content is required' });
        return;
      }

      // Decode base64 content
      const fileBuffer = Buffer.from(content, 'base64');

      const result = await proxy.uploadDocument(
        topicId,
        fileBuffer,
        (fileName || title || 'document'),
        (docFileType || 'application/octet-stream'),
        {
          tenantId,
          appId,
          uploadedBy,
        },
      );

      res.json(result);
    } catch (error) {
      console.error('[KNOWLEDGE-PROXY] Upload error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to upload document',
      });
    }
  };

  // POST /api/knowledge/upload
  uploadDocumentVersion = async (req: Request, res: Response): Promise<void> => {
    // Same as uploadDocument
    return this.uploadDocument(req, res);
  };

  // GET /api/knowledge/topics/:topicId/documents
  listDocuments = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      if (!appPath || typeof appPath !== 'string') {
        res.status(400).json({ error: 'x-app-path header is required' });
        return;
      }

      const manager = await this.getManager();
      const proxy = manager.getProxy();

      const topicId = typeof req.params.topicId === 'string' ? req.params.topicId : req.params.topicId?.[0] || '';

      const tenantId = (req.query.tenantId as string) || undefined;
      const appId = (req.query.appId as string) || undefined;
      const page = parseInt((req.query.page as string) || '1', 10);
      const pageSize = parseInt((req.query.pageSize as string) || '20', 10);

      const result = await proxy.listDocuments(topicId, {
        tenantId,
        appId,
        page,
        pageSize,
      });

      res.json(result);
    } catch (error) {
      console.error('[KNOWLEDGE-PROXY] List documents error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to list documents',
      });
    }
  };

  // DELETE /api/knowledge/documents/:documentId
  deleteDocument = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      if (!appPath || typeof appPath !== 'string') {
        res.status(400).json({ error: 'x-app-path header is required' });
        return;
      }

      const manager = await this.getManager();
      const proxy = manager.getProxy();

      const documentId =
        typeof req.params.documentId === 'string' ? req.params.documentId : req.params.documentId?.[0] || '';

      await proxy.deleteDocument(documentId);

      res.json({ success: true });
    } catch (error) {
      console.error('[KNOWLEDGE-PROXY] Delete document error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to delete document',
      });
    }
  };

  // GET /api/knowledge/jobs
  listJobs = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      if (!appPath || typeof appPath !== 'string') {
        res.status(400).json({ error: 'x-app-path header is required' });
        return;
      }

      const manager = await this.getManager();
      const proxy = manager.getProxy();

      const containerTag = (req.query.containerTag as string) || '';
      const jobs = await proxy.listJobs(containerTag);

      res.json(jobs);
    } catch (error) {
      console.error('[KNOWLEDGE-PROXY] List jobs error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to list jobs',
      });
    }
  };
}
