import fetch from 'node-fetch';
import type {
  Topic,
  DocumentListResult,
  UploadResult,
  IngestionJob,
  QueryResult,
  ApiTopicsResponse,
  ApiDocumentsResponse,
  ApiJobsResponse,
} from './types.js';

interface ProxyConfig {
  serviceUrl: string;
  timeout?: number;
}

/**
 * KnowledgeServiceProxy - Proxies knowledge API requests to the knowledge-service
 *
 * This class replaces the LocalKnowledgeService with a simple HTTP proxy.
 * All knowledge operations are forwarded to the knowledge-service.
 */
export class KnowledgeServiceProxy {
  private config: ProxyConfig;

  constructor(config: ProxyConfig) {
    this.config = {
      timeout: 30000,
      ...config,
    };
  }

  /**
   * Make a proxied request to the knowledge service
   */
  async proxyRequest<T = unknown>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.config.serviceUrl}${path}`;

    const response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      timeout: this.config.timeout as any,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Knowledge service error (${response.status}): ${errorText}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      const data = (await response.json()) as T;
      return data;
    }

    const text = await response.text();
    return text as T;
  }

  /**
   * Query knowledge context
   */
  async query(
    queryText: string,
    containerTags: string[],
    options?: {
      documentTitles?: string[];
      documentRefs?: string[];
      chunkLimit?: number;
      entityLimit?: number;
    },
  ): Promise<QueryResult> {
    return this.proxyRequest<QueryResult>('POST', '/KnowledgeService.core/queryKnowledgeContext', {
      queryText,
      containerTagsJson: JSON.stringify(containerTags),
      documentTitlesJson: JSON.stringify(options?.documentTitles || []),
      documentRefsJson: JSON.stringify(options?.documentRefs || []),
      chunkLimit: options?.chunkLimit || 5,
      entityLimit: options?.entityLimit || 10,
    });
  }

  /**
   * Create a topic
   */
  async createTopic(input: {
    tenantId?: string;
    appId?: string;
    name: string;
    description?: string;
    documentTitles?: string[];
  }): Promise<{ id: string; containerTag: string }> {
    return this.proxyRequest<{ id: string; containerTag: string }>(
      'POST',
      '/KnowledgeService.core/uploadDocumentVersion',
      {
        tenantId: input.tenantId || 'local',
        appId: input.appId,
        topicName: input.name,
        description: input.description || '',
        documentTitles: input.documentTitles || [],
      },
    );
  }

  /**
   * List topics
   */
  async listTopics(tenantId?: string, appId?: string): Promise<Topic[]> {
    const params = new URLSearchParams();
    if (tenantId) params.append('tenantId', tenantId);
    if (appId) params.append('appId', appId);

    const result = await this.proxyRequest<ApiTopicsResponse>(
      'GET',
      `/KnowledgeService.core/Topic?${params.toString()}`,
    );

    return JSON.parse(result.topicsJson || '[]') as Topic[];
  }

  /**
   * Delete a topic
   */
  async deleteTopic(topicId: string): Promise<void> {
    await this.proxyRequest<unknown>('DELETE', `/KnowledgeService.core/Topic/${topicId}`);
  }

  /**
   * Upload a document
   */
  async uploadDocument(
    topicId: string,
    fileBuffer: Buffer,
    fileName: string,
    fileType: string,
    options?: {
      tenantId?: string;
      appId?: string;
      uploadedBy?: string;
    },
  ): Promise<UploadResult> {
    // Convert buffer to base64 for transport
    const base64Content = fileBuffer.toString('base64');

    return this.proxyRequest<UploadResult>('POST', '/KnowledgeService.core/uploadDocumentVersion', {
      tenantId: options?.tenantId || 'local',
      appId: options?.appId,
      topicId,
      fileName,
      fileType,
      content: base64Content,
      uploadedBy: options?.uploadedBy || 'local-user',
    });
  }

  /**
   * List documents for a topic
   */
  async listDocuments(
    topicId: string,
    options?: {
      tenantId?: string;
      appId?: string;
      page?: number;
      pageSize?: number;
    },
  ): Promise<DocumentListResult> {
    const result = await this.proxyRequest<ApiDocumentsResponse>(
      'POST',
      '/KnowledgeService.core/listDocuments',
      {
        tenantId: options?.tenantId || 'local',
        appId: options?.appId,
        topicId,
        page: options?.page || 1,
        pageSize: options?.pageSize || 20,
      },
    );

    return {
      documents: JSON.parse(result.documentsJson || '[]'),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    };
  }

  /**
   * Delete a document
   */
  async deleteDocument(documentId: string): Promise<void> {
    await this.proxyRequest<unknown>('POST', '/KnowledgeService.core/softDeleteDocument', {
      documentId,
    });
  }

  /**
   * List ingestion jobs
   */
  async listJobs(containerTag?: string): Promise<IngestionJob[]> {
    const params = new URLSearchParams();
    if (containerTag) params.append('containerTag', containerTag);

    const result = await this.proxyRequest<ApiJobsResponse>(
      'GET',
      `/KnowledgeService.core/VectorIngestionQueueItem?${params.toString()}`,
    );

    return JSON.parse(result.itemsJson || '[]') as IngestionJob[];
  }
}
