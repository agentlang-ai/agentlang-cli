import { KnowledgeServiceProxy } from './KnowledgeServiceProxy.js';

interface ManagerConfig {
  serviceUrl?: string;
}

/**
 * KnowledgeServiceManager - Manages connection to external knowledge-service
 *
 * Architecture (Option 2): Knowledge-service runs as a separate process
 *
 * User workflow:
 *   Terminal 1: cd knowledge-service && agentlang run src/core.al
 *   Terminal 2: cd my-app && KNOWLEDGE_SERVICE_URL=http://localhost:8080 agentlang dev
 *
 * This class:
 * - Validates connection to knowledge-service
 * - Provides proxy for API calls
 * - Reports helpful errors if service is not available
 */
export class KnowledgeServiceManager {
  private proxy: KnowledgeServiceProxy;
  private serviceUrl: string;
  private ready = false;

  constructor(config: ManagerConfig) {
    this.serviceUrl = config.serviceUrl || process.env.KNOWLEDGE_SERVICE_URL || 'http://localhost:8080';
    this.proxy = new KnowledgeServiceProxy({ serviceUrl: this.serviceUrl });
  }

  /**
   * Check if knowledge-service is available
   */
  async checkConnection(): Promise<{ ok: boolean; message?: string }> {
    try {
      const response = await fetch(`${this.serviceUrl}/KnowledgeService.core/healthCheck`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      if (response.ok) {
        const health = await response.json();
        if (health.status === 'healthy' || health.status === 'degraded') {
          return { ok: true };
        }
        return { ok: false, message: `Service unhealthy: ${health.status}` };
      }

      return { ok: false, message: `HTTP ${response.status}` };
    } catch (err) {
      return {
        ok: false,
        message: `Cannot connect to ${this.serviceUrl}. Is knowledge-service running?`,
      };
    }
  }

  /**
   * Ensure service is available, throw helpful error if not
   */
  async ensureAvailable(): Promise<void> {
    const check = await this.checkConnection();

    if (!check.ok) {
      throw new Error(`
╔════════════════════════════════════════════════════════════════╗
║  Knowledge Service Not Available                               ║
╠════════════════════════════════════════════════════════════════╣
║                                                                ║
║  ${check.message?.padEnd(60)} ║
║                                                                ║
║  To start knowledge-service:                                   ║
║                                                                ║
║    cd /path/to/knowledge-service                               ║
║    export STORE_TYPE=sqlite                                    ║
║    export VECTOR_DB_TYPE=lancedb                               ║
║    export LANCE_DB_PATH=./lance-data                           ║
║    agentlang run src/core.al                                   ║
║                                                                ║
║  Then in another terminal:                                     ║
║                                                                ║
║    cd /path/to/your-app                                        ║
║    export KNOWLEDGE_SERVICE_URL=http://localhost:8080          ║
║    agentlang dev                                               ║
║                                                                ║
╚════════════════════════════════════════════════════════════════╝
`);
    }

    this.ready = true;
  }

  /**
   * Get the proxy instance
   */
  getProxy(): KnowledgeServiceProxy {
    if (!this.ready) {
      console.warn('[KNOWLEDGE-SERVICE] Warning: getProxy() called before ensureAvailable()');
    }
    return this.proxy;
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Get the service URL
   */
  getServiceUrl(): string {
    return this.serviceUrl;
  }
}
