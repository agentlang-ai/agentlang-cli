/**
 * Type definitions for knowledge service
 */

export interface Topic {
  id: string;
  name: string;
  description?: string;
  containerTag?: string;
  documentCount: number;
  type?: string;
  createdBy?: string;
  createdAt?: string;
}

export interface Document {
  id: string;
  title: string;
  fileName: string;
  fileType: string;
  sizeBytes: number;
  currentVersion: number;
  createdAt: string;
  tenantId?: string;
  connectionId?: string;
}

export interface DocumentListResult {
  documents: Document[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UploadResult {
  documentId: string;
  versionId: string;
}

export interface IngestionJob {
  id: string;
  documentId: string;
  status: string;
  progress: number;
  progressStage: string;
  errorMessage?: string;
}

export interface QueryResult {
  chunks: {
    id: string;
    content: string;
    similarity: number;
    containerTag: string;
  }[];
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

export interface TopicDocument {
  id: string;
  tenantId: string;
  topicId: string;
  documentId: string;
  addedBy: string;
  addedAt: string;
}

export interface HealthCheckResponse {
  status?: string;
  version?: string;
  uptime?: number;
  dbStatus?: string;
  s3Status?: string;
  neo4jStatus?: string;
  openaiStatus?: string;
}

export interface ApiTopicsResponse {
  topicsJson: string;
}

export interface ApiDocumentsResponse {
  documentsJson: string;
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiJobsResponse {
  itemsJson: string;
}
