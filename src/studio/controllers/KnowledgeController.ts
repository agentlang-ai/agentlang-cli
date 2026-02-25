
import { Request, Response } from 'express';
import { LocalKnowledgeService } from '../services/LocalKnowledgeService.js';

/**
 * Controller for local knowledge API endpoints.
 * Matches the knowledge-service API contract so Studio can use the same
 * endpoints whether talking to deployed knowledge-service or local CLI.
 */
export class KnowledgeController {
  private getService(appPath: string | null): LocalKnowledgeService {
    if (!appPath) {
      throw new Error('No app is currently loaded');
    }
    return new LocalKnowledgeService(appPath);
  }

  // POST /api/knowledge/query
  query = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      const service = this.getService(typeof appPath === 'string' ? appPath : null);

      const { query, queryText, containerTags, containerTagsJson, chunkLimit, entityLimit } = req.body;

      const resolvedQuery = query || queryText || '';
      const resolvedTags: string[] =
        (containerTags as string[] | undefined) ||
        (containerTagsJson ? (JSON.parse(containerTagsJson as string) as string[]) : []);

      const result = await service.query({
        queryText: resolvedQuery,
        containerTags: resolvedTags,
        chunkLimit,
        entityLimit,
      });

      await service.close();
      res.json(result);
    } catch (error) {
      console.error('[LOCAL-KNOWLEDGE] Query error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Knowledge query failed',
      });
    }
  };

  // POST /api/knowledge/topics
  createTopic = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      const service = this.getService(typeof appPath === 'string' ? appPath : null);

      const { tenantId, appId, name, description, documentTitles } = req.body;
      const topic = service.createTopic({
        tenantId,
        appId,
        name,
        description,
        documentTitles,
      });

      await service.close();
      res.json(topic);
    } catch (error) {
      console.error('[LOCAL-KNOWLEDGE] Create topic error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to create topic',
      });
    }
  };

  // GET /api/knowledge/topics
  listTopics = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      const service = this.getService(typeof appPath === 'string' ? appPath : null);

      const tenantId = (req.query.tenantId as string) || '';
      const appId = (req.query.appId as string) || '';
      const topics = service.listTopics(tenantId, appId);

      await service.close();
      res.json(topics);
    } catch (error) {
      console.error('[LOCAL-KNOWLEDGE] List topics error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to list topics',
      });
    }
  };

  // DELETE /api/knowledge/topics/:topicId
  deleteTopic = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      const service = this.getService(typeof appPath === 'string' ? appPath : null);

      const topicId = typeof req.params.topicId === 'string' ? req.params.topicId : req.params.topicId?.[0] || '';
      await service.deleteTopic(topicId);

      await service.close();
      res.json({ success: true });
    } catch (error) {
      console.error('[LOCAL-KNOWLEDGE] Delete topic error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to delete topic',
      });
    }
  };

  // POST /api/knowledge/topics/:topicId/documents:upload
  uploadDocument = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      const service = this.getService(typeof appPath === 'string' ? appPath : null);

      const topicId = typeof req.params.topicId === 'string' ? req.params.topicId : req.params.topicId?.[0] || '';
      const { tenantId, appId, topicName, containerTag, title, fileName, fileType, content, uploadedBy } = req.body;

      const result = await service.uploadDocumentVersion({
        tenantId,
        appId,
        topicId,
        topicName,
        containerTag,
        title,
        fileName,
        fileType,
        content,
        uploadedBy,
      });

      await service.close();
      res.json(result);
    } catch (error) {
      console.error('[LOCAL-KNOWLEDGE] Upload error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to upload document',
      });
    }
  };

  // POST /api/knowledge/upload (workflow-style endpoint matching knowledge-service)
  uploadDocumentVersion = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      const service = this.getService(typeof appPath === 'string' ? appPath : null);

      const { tenantId, appId, topicId, topicName, containerTag, title, fileName, fileType, content, uploadedBy } =
        req.body;

      const result = await service.uploadDocumentVersion({
        tenantId,
        appId,
        topicId,
        topicName,
        containerTag,
        title,
        fileName,
        fileType,
        content,
        uploadedBy,
      });

      await service.close();
      res.json(result);
    } catch (error) {
      console.error('[LOCAL-KNOWLEDGE] Upload version error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to upload document version',
      });
    }
  };

  // GET /api/knowledge/topics/:topicId/documents
  listDocuments = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      const service = this.getService(typeof appPath === 'string' ? appPath : null);

      const topicId = typeof req.params.topicId === 'string' ? req.params.topicId : req.params.topicId?.[0] || '';
      const limit = parseInt((req.query.limit as string) || '50', 10);
      const offset = parseInt((req.query.offset as string) || '0', 10);

      const documents = service.listDocuments(topicId, limit, offset);

      await service.close();
      res.json(documents);
    } catch (error) {
      console.error('[LOCAL-KNOWLEDGE] List documents error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to list documents',
      });
    }
  };

  // DELETE /api/knowledge/documents/:documentId
  deleteDocument = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      const service = this.getService(typeof appPath === 'string' ? appPath : null);

      const documentId =
        typeof req.params.documentId === 'string' ? req.params.documentId : req.params.documentId?.[0] || '';
      await service.softDeleteDocument(documentId);

      await service.close();
      res.json({ success: true });
    } catch (error) {
      console.error('[LOCAL-KNOWLEDGE] Delete document error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to delete document',
      });
    }
  };

  // GET /api/knowledge/jobs
  listJobs = async (req: Request, res: Response): Promise<void> => {
    try {
      const appPath = req.headers['x-app-path'];
      const service = this.getService(typeof appPath === 'string' ? appPath : null);

      const containerTag = (req.query.containerTag as string) || '';
      const jobs = service.listIngestionJobs(containerTag);

      await service.close();
      res.json(jobs);
    } catch (error) {
      console.error('[LOCAL-KNOWLEDGE] List jobs error:', error);
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to list jobs',
      });
    }
  };
}
