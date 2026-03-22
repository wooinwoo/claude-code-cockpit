// ─── Pencil MCP HTTP Client ───
// Connects to Pencil MCP server in HTTP mode for AI design generation
// Requires: VS Code + Pencil extension active with a .pen file open

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { IS_WIN } from './platform.js';

const PENCIL_BINARY = IS_WIN
  ? 'C:\\Users\\RST\\.vscode\\extensions\\highagency.pencildev-0.6.32\\out\\mcp-server-windows-x64.exe'
  : null; // TODO: macOS path

const DEFAULT_PORT = 9234;
const CONNECT_TIMEOUT = 10000;
const REQUEST_TIMEOUT = 60000;

export class PencilClient {
  constructor(options = {}) {
    this.port = options.port || DEFAULT_PORT;
    this.binaryPath = options.binaryPath || PENCIL_BINARY;
    this.process = null;
    this.sessionId = null;
    this.requestId = 0;
    this.available = false;
  }

  /** Start the MCP server in HTTP mode */
  async start() {
    if (!this.binaryPath || !existsSync(this.binaryPath)) {
      this.available = false;
      return false;
    }

    try {
      this.process = spawn(this.binaryPath, [
        '-app', 'visual_studio_code',
        '-http',
        '-http-port', String(this.port),
      ], { stdio: 'pipe', windowsHide: true });

      this.process.on('error', () => { this.available = false; });
      this.process.on('exit', () => { this.available = false; this.process = null; });

      // Wait for server to be ready
      await this._waitForReady();
      await this._initialize();
      this.available = true;
      return true;
    } catch (e) {
      this.available = false;
      return false;
    }
  }

  /** Stop the MCP server */
  stop() {
    if (this.process) {
      try { this.process.kill(); } catch { /* already dead */ }
      this.process = null;
    }
    this.available = false;
    this.sessionId = null;
  }

  /** Check if Pencil is available */
  isAvailable() { return this.available; }

  /** Wait for HTTP server to respond */
  async _waitForReady() {
    const start = Date.now();
    while (Date.now() - start < CONNECT_TIMEOUT) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping', params: {} }),
          signal: AbortSignal.timeout(2000),
        });
        if (res.status) return; // Any response means server is up
      } catch { /* not ready yet */ }
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error('Pencil MCP server did not start');
  }

  /** Initialize MCP session */
  async _initialize() {
    const res = await this._rawRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'forge', version: '1.0.0' },
    });
    // Session ID from response header
    this.sessionId = res.sessionId || null;
    return res;
  }

  /** Send raw JSON-RPC request */
  async _rawRequest(method, params) {
    const id = ++this.requestId;
    const headers = { 'Content-Type': 'application/json' };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const res = await fetch(`http://127.0.0.1:${this.port}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT),
    });

    // Capture session ID from response headers
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    const data = await res.json();
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    return { ...data.result, sessionId: sid || this.sessionId };
  }

  /** Call a Pencil MCP tool */
  async callTool(name, args = {}) {
    if (!this.available) return null;
    try {
      const result = await this._rawRequest('tools/call', { name, arguments: args });
      return result;
    } catch (e) {
      return null;
    }
  }

  // ─── Convenience Methods ───

  async getGuidelines(topic) {
    return this.callTool('get_guidelines', { topic });
  }

  async getStyleGuideTags() {
    return this.callTool('get_style_guide_tags', {});
  }

  async getStyleGuide(tags, name) {
    return this.callTool('get_style_guide', { tags, name });
  }

  async openDocument(filePathOrTemplate) {
    return this.callTool('open_document', { filePathOrTemplate });
  }

  async batchDesign(operations) {
    return this.callTool('batch_design', { operations });
  }

  async getScreenshot(nodeId) {
    return this.callTool('get_screenshot', nodeId ? { nodeId } : {});
  }

  async exportNodes(nodeIds, format = 'png', folder = '.') {
    return this.callTool('export_nodes', { nodeIds, format, folder });
  }

  async snapshotLayout() {
    return this.callTool('snapshot_layout', {});
  }

  // ─── Forge Integration ───

  /**
   * Design pages for a project. Creates a .pen file, designs each page, returns screenshots.
   * @param {object} plan - Design plan from _runDesign
   * @param {string} outputDir - Directory to save screenshots
   * @returns {object[]} Array of { page, screenshotPath } or null if Pencil unavailable
   */
  async designPages(plan, outputDir) {
    if (!this.available) return null;

    try {
      // Open new document
      await this.openDocument('new');

      // Get style guide for the project type
      const guidelines = await this.getGuidelines('mobile-app');
      const styleTags = await this.getStyleGuideTags();

      // TODO: Use batchDesign to create actual page designs
      // This requires understanding Pencil's design operation syntax
      // For now, return guidelines as design context

      return {
        guidelines: guidelines?.content?.[0]?.text || '',
        styleTags: styleTags?.content?.[0]?.text || '',
        screenshots: [], // Will be populated when batchDesign is implemented
      };
    } catch (e) {
      return null;
    }
  }
}

// ─── Singleton ───
let _instance = null;

export function getPencilClient() {
  if (!_instance) _instance = new PencilClient();
  return _instance;
}

export async function initPencil() {
  const client = getPencilClient();
  const ok = await client.start();
  return ok ? client : null;
}
