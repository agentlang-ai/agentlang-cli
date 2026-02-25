/* eslint-disable @typescript-eslint/no-empty-function, @typescript-eslint/no-non-null-assertion */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalKnowledgeService } from '../src/studio/services/LocalKnowledgeService.js';

// No OPENAI_API_KEY set → generateEmbeddings returns zero vectors (dev/test mode)
delete process.env.AGENTLANG_OPENAI_KEY;
delete process.env.OPENAI_API_KEY;

const TENANT = 'test-tenant';
const APP = 'test-app';

let tmpDir: string;
let svc: LocalKnowledgeService;

describe('LocalKnowledgeService', () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'lks-'));
    svc = new LocalKnowledgeService(tmpDir);
  });

  afterEach(async () => {
    await svc.close();
    // Small delay to let LanceDB release file locks
    await new Promise(r => setTimeout(r, 50));
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // ─── Topic CRUD ──────────────────────────────────────────────────────────

  describe('Topic CRUD', () => {
    test('createTopic and getTopic', () => {
      const topic = svc.createTopic({ tenantId: TENANT, appId: APP, name: 'My Topic' });
      expect(topic.id).toBeTruthy();
      expect(topic.name).toBe('My Topic');
      expect(topic.tenantId).toBe(TENANT);
      expect(topic.appId).toBe(APP);
      expect(topic.containerTag).toBeTruthy();
      expect(topic.documentCount).toBe(0);

      const fetched = svc.getTopic(topic.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.name).toBe('My Topic');
    });

    test('listTopics returns all topics for tenant+app', () => {
      svc.createTopic({ tenantId: TENANT, appId: APP, name: 'Topic A' });
      svc.createTopic({ tenantId: TENANT, appId: APP, name: 'Topic B' });
      svc.createTopic({ tenantId: 'other-tenant', appId: APP, name: 'Topic C' });

      const topics = svc.listTopics(TENANT, APP);
      expect(topics.length).toBe(2);
      expect(topics.map(t => t.name).sort()).toEqual(['Topic A', 'Topic B']);
    });

    test('deleteTopic removes topic and its documents', async () => {
      const topic = svc.createTopic({ tenantId: TENANT, appId: APP, name: 'Doomed' });
      await svc.deleteTopic(topic.id);
      expect(svc.getTopic(topic.id)).toBeNull();
    });

    test('each topic gets a unique containerTag', () => {
      const t1 = svc.createTopic({ tenantId: TENANT, appId: APP, name: 'Topic One' });
      const t2 = svc.createTopic({ tenantId: TENANT, appId: APP, name: 'Topic Two' });
      expect(t1.containerTag).not.toBe(t2.containerTag);
      expect(t1.id).not.toBe(t2.id);
    });
  });

  // ─── Document Upload + Ingestion ─────────────────────────────────────────

  describe('Document Upload + Ingestion', () => {
    test('uploadDocumentVersion creates document, version, and chunks', async () => {
      const topic = svc.createTopic({ tenantId: TENANT, appId: APP, name: 'Upload Test' });
      const content = Buffer.from(
        'Artificial intelligence is transforming software development. Machine learning models can now generate code.',
      ).toString('base64');

      const result = await svc.uploadDocumentVersion({
        tenantId: TENANT,
        appId: APP,
        topicId: topic.id,
        containerTag: topic.containerTag,
        title: 'ai-doc.txt',
        fileName: 'ai-doc.txt',
        fileType: 'text',
        content,
      });

      expect(result.documentId).toBeTruthy();
      expect(result.documentVersionId).toBeTruthy();
      expect(result.topicId).toBe(topic.id);

      // Document should be listed
      const docs = svc.listDocuments(topic.id);
      expect(docs.length).toBe(1);
      expect(docs[0].title).toBe('ai-doc.txt');
      expect(docs[0].currentVersion).toBe(1);
    });

    test('uploadDocumentVersion auto-creates topic from topicName', async () => {
      const content = Buffer.from('Test content').toString('base64');

      const result = await svc.uploadDocumentVersion({
        tenantId: TENANT,
        appId: APP,
        topicName: 'Auto-Created Topic',
        title: 'test.txt',
        fileName: 'test.txt',
        fileType: 'text',
        content,
      });

      expect(result.topicId).toBeTruthy();
      const topics = svc.listTopics(TENANT, APP);
      expect(topics.some(t => t.name === 'Auto-Created Topic')).toBe(true);
    });

    test('uploadDocumentVersion bumps version on re-upload', async () => {
      const topic = svc.createTopic({ tenantId: TENANT, appId: APP, name: 'Version Test' });

      const v1 = await svc.uploadDocumentVersion({
        tenantId: TENANT,
        appId: APP,
        topicId: topic.id,
        containerTag: topic.containerTag,
        title: 'doc.txt',
        fileName: 'doc.txt',
        fileType: 'text',
        content: Buffer.from('Version 1 content').toString('base64'),
      });

      const v2 = await svc.uploadDocumentVersion({
        tenantId: TENANT,
        appId: APP,
        topicId: topic.id,
        containerTag: topic.containerTag,
        title: 'doc.txt',
        fileName: 'doc.txt',
        fileType: 'text',
        content: Buffer.from('Version 2 content with updates').toString('base64'),
      });

      expect(v2.documentId).toBe(v1.documentId);
      expect(v2.documentVersionId).not.toBe(v1.documentVersionId);

      const docs = svc.listDocuments(topic.id);
      expect(docs[0].currentVersion).toBe(2);
    });

    test('throws when neither topicId nor topicName provided', async () => {
      await expect(
        svc.uploadDocumentVersion({
          tenantId: TENANT,
          appId: APP,
          title: 'test.txt',
          fileName: 'test.txt',
          fileType: 'text',
          content: Buffer.from('test').toString('base64'),
        }),
      ).rejects.toThrow('topicId or topicName is required');
    });
  });

  // ─── Knowledge Query ─────────────────────────────────────────────────────

  describe('Knowledge Query', () => {
    test('query returns results after ingestion (zero-vector mode returns entities/context)', async () => {
      const topic = svc.createTopic({ tenantId: TENANT, appId: APP, name: 'Query Test' });
      await svc.uploadDocumentVersion({
        tenantId: TENANT,
        appId: APP,
        topicId: topic.id,
        containerTag: topic.containerTag,
        title: 'knowledge.txt',
        fileName: 'knowledge.txt',
        fileType: 'text',
        content: Buffer.from(
          'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.',
        ).toString('base64'),
      });

      // In zero-vector mode, vector search may return empty but entities should exist
      const result = await svc.query({
        queryText: 'TypeScript',
        containerTags: [topic.containerTag],
        chunkLimit: 5,
      });

      // Verify the query completes without error and returns a valid result
      expect(result).toBeDefined();
      expect(result.contextString).toBeDefined();
      // Verify document was actually ingested by checking listDocuments
      const docs = svc.listDocuments(topic.id);
      expect(docs.length).toBe(1);
      expect(docs[0].title).toBe('knowledge.txt');
    });

    test('query with no matching containerTag returns empty', async () => {
      const topic = svc.createTopic({ tenantId: TENANT, appId: APP, name: 'Empty Query' });
      await svc.uploadDocumentVersion({
        tenantId: TENANT,
        appId: APP,
        topicId: topic.id,
        containerTag: topic.containerTag,
        title: 'doc.txt',
        fileName: 'doc.txt',
        fileType: 'text',
        content: Buffer.from('Some content').toString('base64'),
      });

      const result = await svc.query({
        queryText: 'test',
        containerTags: ['nonexistent-tag'],
        chunkLimit: 5,
      });

      expect(result.chunks.length).toBe(0);
    });

    test('query respects chunkLimit', async () => {
      const topic = svc.createTopic({ tenantId: TENANT, appId: APP, name: 'Limit Test' });
      // Upload a large document that will produce multiple chunks
      const longContent = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}: ${'x'.repeat(200)}`).join('\n');
      await svc.uploadDocumentVersion({
        tenantId: TENANT,
        appId: APP,
        topicId: topic.id,
        containerTag: topic.containerTag,
        title: 'large.txt',
        fileName: 'large.txt',
        fileType: 'text',
        content: Buffer.from(longContent).toString('base64'),
      });

      const result = await svc.query({
        queryText: 'Paragraph',
        containerTags: [topic.containerTag],
        chunkLimit: 2,
      });

      expect(result.chunks.length).toBeLessThanOrEqual(2);
    });
  });

  // ─── Delete Document Knowledge ───────────────────────────────────────────

  describe('Delete Document Knowledge', () => {
    test('deleteDocumentKnowledge removes chunks and entities', async () => {
      const topic = svc.createTopic({ tenantId: TENANT, appId: APP, name: 'Delete Test' });
      const result = await svc.uploadDocumentVersion({
        tenantId: TENANT,
        appId: APP,
        topicId: topic.id,
        containerTag: topic.containerTag,
        title: 'to-delete.txt',
        fileName: 'to-delete.txt',
        fileType: 'text',
        content: Buffer.from('Content that will be deleted').toString('base64'),
      });

      // Verify document exists
      const docsBefore = svc.listDocuments(topic.id);
      expect(docsBefore.length).toBe(1);

      // Delete knowledge data (chunks, nodes, relations)
      svc.deleteDocumentKnowledge(result.documentId);

      // After deleteDocumentKnowledge, the document record still exists
      // but its knowledge data (chunks/nodes/relations) should be gone
      // Verify by querying — should return empty even if doc record remains
      const afterQuery = await svc.query({
        queryText: 'deleted',
        containerTags: [topic.containerTag],
        chunkLimit: 10,
      });
      expect(afterQuery.chunks.length).toBe(0);
      expect(afterQuery.entities.length).toBe(0);
    });
  });

  // ─── List Documents ──────────────────────────────────────────────────────

  describe('List Documents', () => {
    test('listDocuments returns documents for a topic', async () => {
      const topic = svc.createTopic({ tenantId: TENANT, appId: APP, name: 'List Test' });
      await svc.uploadDocumentVersion({
        tenantId: TENANT,
        appId: APP,
        topicId: topic.id,
        containerTag: topic.containerTag,
        title: 'doc1.txt',
        fileName: 'doc1.txt',
        fileType: 'text',
        content: Buffer.from('First document').toString('base64'),
      });
      await svc.uploadDocumentVersion({
        tenantId: TENANT,
        appId: APP,
        topicId: topic.id,
        containerTag: topic.containerTag,
        title: 'doc2.txt',
        fileName: 'doc2.txt',
        fileType: 'text',
        content: Buffer.from('Second document').toString('base64'),
      });

      const docs = svc.listDocuments(topic.id);
      expect(docs.length).toBe(2);
      expect(docs.map(d => d.title).sort()).toEqual(['doc1.txt', 'doc2.txt']);
    });

    test('listDocuments respects limit and offset', async () => {
      const topic = svc.createTopic({ tenantId: TENANT, appId: APP, name: 'Pagination Test' });
      for (let i = 0; i < 5; i++) {
        await svc.uploadDocumentVersion({
          tenantId: TENANT,
          appId: APP,
          topicId: topic.id,
          containerTag: topic.containerTag,
          title: `doc${i}.txt`,
          fileName: `doc${i}.txt`,
          fileType: 'text',
          content: Buffer.from(`Document ${i}`).toString('base64'),
        });
      }

      const page1 = svc.listDocuments(topic.id, 2, 0);
      expect(page1.length).toBe(2);

      const page2 = svc.listDocuments(topic.id, 2, 2);
      expect(page2.length).toBe(2);

      const page3 = svc.listDocuments(topic.id, 2, 4);
      expect(page3.length).toBe(1);
    });
  });
});
