import OpenAI from 'openai';
import { DocumentDatabaseService } from './DocumentDatabaseService.js';

export interface ChunkingOptions {
  maxChunkSize?: number; // in characters
  overlap?: number; // overlap between chunks in characters
}

export interface EmbeddingOptions {
  provider?: 'openai' | 'ollama';
  model?: string;
  dimensions?: number;
  apiKey?: string;
  baseUrl?: string;
}

export interface EmbeddingResult {
  chunkId: string;
  chunkIndex: number;
  embedding: number[];
}

/**
 * Service for generating and managing vector embeddings
 */
export class VectorStoreService {
  private dbService: DocumentDatabaseService;
  private openaiClient: OpenAI | null = null;
  private defaultOptions: EmbeddingOptions;

  constructor(dbService: DocumentDatabaseService, options?: EmbeddingOptions) {
    this.dbService = dbService;
    this.defaultOptions = {
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      ...options,
    };

    // Initialize OpenAI client if API key is provided
    if (this.defaultOptions.apiKey) {
      this.initializeOpenAI(this.defaultOptions);
    }
  }

  /**
   * Initialize OpenAI client
   */
  private initializeOpenAI(options: EmbeddingOptions): void {
    const config: {
      apiKey?: string;
      baseURL?: string;
    } = {
      apiKey: options.apiKey || process.env.OPENAI_API_KEY,
    };

    if (options.baseUrl) {
      config.baseURL = options.baseUrl;
    }

    if (config.apiKey) {
      this.openaiClient = new OpenAI(config);
    }
  }

  /**
   * Chunk text into smaller pieces for embedding
   */
  chunkText(text: string, options: ChunkingOptions = {}): string[] {
    const maxChunkSize = options.maxChunkSize || 2000;
    const overlap = options.overlap || 200;

    // Simple chunking by characters with overlap
    const chunks: string[] = [];
    let start = 0;

    while (start < text.length) {
      const end = Math.min(start + maxChunkSize, text.length);

      // Try to break at sentence boundary
      let chunkEnd = end;
      if (end < text.length) {
        // Look for sentence endings within last 100 chars
        const lastPart = text.substring(Math.max(start, end - 100), end);
        const sentenceEndMatch = lastPart.match(/[.!?]\s+/g);
        if (sentenceEndMatch) {
          const lastSentenceEnd = lastPart.lastIndexOf(sentenceEndMatch[sentenceEndMatch.length - 1]);
          if (lastSentenceEnd > 0) {
            chunkEnd = Math.max(start, end - 100) + lastSentenceEnd + 1;
          }
        }
      }

      const chunk = text.substring(start, chunkEnd).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      // Move start position with overlap
      start = chunkEnd - overlap;
      if (start <= 0 || start >= text.length - overlap) {
        start = chunkEnd;
      }
    }

    return chunks;
  }

  /**
   * Generate embeddings using OpenAI
   */
  private async generateOpenAIEmbeddings(texts: string[], options: EmbeddingOptions): Promise<number[][]> {
    if (!this.openaiClient) {
      this.initializeOpenAI(options);
      if (!this.openaiClient) {
        throw new Error(
          'OpenAI API key not provided. Set OPENAI_API_KEY environment variable or pass apiKey in options.',
        );
      }
    }

    const model = options.model || this.defaultOptions.model || 'text-embedding-3-small';
    const dimensions = options.dimensions || this.defaultOptions.dimensions;

    try {
      const response = await this.openaiClient.embeddings.create({
        model,
        input: texts,
        dimensions,
      });

      return response.data.map(item => item.embedding);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error generating OpenAI embeddings:', error);
      throw new Error(`Failed to generate embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate embeddings using Ollama
   */
  private async generateOllamaEmbeddings(texts: string[], options: EmbeddingOptions): Promise<number[][]> {
    const baseUrl = options.baseUrl || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    const model = options.model || 'nomic-embed-text';

    const embeddings: number[][] = [];

    try {
      for (const text of texts) {
        const response = await fetch(`${baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, prompt: text }),
        });

        if (!response.ok) {
          throw new Error(`Ollama API error: ${response.statusText}`);
        }

        const data = await response.json() as { embedding: number[] };
        embeddings.push(data.embedding);
      }

      return embeddings;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('Error generating Ollama embeddings:', error);
      throw new Error(
        `Failed to generate embeddings with Ollama: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Generate embeddings for text chunks
   */
  async generateEmbeddings(texts: string[], options?: EmbeddingOptions): Promise<number[][]> {
    const opts = { ...this.defaultOptions, ...options };

    if (texts.length === 0) {
      return [];
    }

    if (opts.provider === 'ollama') {
      return this.generateOllamaEmbeddings(texts, opts);
    } else {
      return this.generateOpenAIEmbeddings(texts, opts);
    }
  }

  /**
   * Process document: chunk text and generate embeddings
   */
  async processDocument(
    documentId: string,
    text: string,
    options?: {
      chunking?: ChunkingOptions;
      embedding?: EmbeddingOptions;
    },
  ): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(`Processing document ${documentId}...`);

    // Step 1: Chunk the text
    const chunks = this.chunkText(text, options?.chunking);
    // eslint-disable-next-line no-console
    console.log(`Generated ${chunks.length} chunks`);

    // Step 2: Save chunks to database
    const savedChunks = this.dbService.saveChunks(documentId, chunks);
    // eslint-disable-next-line no-console
    console.log(`Saved ${savedChunks.length} chunks to database`);

    // Step 3: Generate embeddings
    // eslint-disable-next-line no-console
    console.log('Generating embeddings...');
    const embeddings = await this.generateEmbeddings(chunks, options?.embedding);
    // eslint-disable-next-line no-console
    console.log(`Generated ${embeddings.length} embeddings`);

    // Step 4: Save embeddings to vector store
    const chunkEmbeddings = savedChunks.map((chunk, i) => ({
      chunkId: chunk.id,
      embedding: embeddings[i],
    }));

    this.dbService.saveEmbeddings(chunkEmbeddings);
    // eslint-disable-next-line no-console
    console.log('Saved embeddings to vector store');

    // Step 5: Save embeddings to text file for backup
    const embeddingsWithIndex = savedChunks.map((chunk, i) => ({
      chunkId: chunk.id,
      chunkIndex: i,
      embedding: embeddings[i],
    }));

    const embeddingFile = await this.dbService.saveEmbeddingsToFile(documentId, embeddingsWithIndex);
    // eslint-disable-next-line no-console
    console.log(`Saved embeddings to file: ${embeddingFile}`);
  }

  /**
   * Search for similar content
   */
  async search(
    query: string,
    options?: {
      limit?: number;
      embedding?: EmbeddingOptions;
    },
  ): Promise<
    {
      documentId: string;
      originalName: string;
      chunkIndex: number;
      content: string;
      similarity: number;
    }[]
  > {
    // Generate embedding for query
    const queryEmbeddings = await this.generateEmbeddings([query], options?.embedding);
    const queryEmbedding = queryEmbeddings[0];

    // Search in vector store
    const results = this.dbService.searchSimilar(queryEmbedding, options?.limit || 5);

    return results;
  }
}
