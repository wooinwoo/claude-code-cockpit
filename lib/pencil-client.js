// ─── Pencil MCP HTTP Client ───
// Connects to Pencil MCP server in HTTP mode for AI design generation
// Backend-only: user never sees VS Code or Pencil directly

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IS_WIN } from './platform.js';

const PENCIL_BINARY = (() => {
  if (!IS_WIN) return null;
  try {
    const extDir = join(process.env.USERPROFILE || 'C:\\Users\\RST', '.vscode', 'extensions');
    const entries = readdirSync(extDir);
    const pencilDir = entries.filter(e => e.startsWith('highagency.pencildev-')).sort().pop();
    if (pencilDir) {
      const bin = join(extDir, pencilDir, 'out', 'mcp-server-windows-x64.exe');
      if (existsSync(bin)) return bin;
    }
  } catch { /* not found */ }
  return null;
})();

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
    if (this.available && this.process) return true; // Already running

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
    if (data.error) throw new Error(data.error.message?.slice(0, 1000) || JSON.stringify(data.error).slice(0, 1000));
    return { ...data.result, sessionId: sid || this.sessionId };
  }

  /** Call a Pencil MCP tool */
  async callTool(name, args = {}) {
    if (!this.available) { console.warn(`[Pencil] callTool(${name}): not available`); return null; }
    try {
      const result = await this._rawRequest('tools/call', { name, arguments: args });
      // Check for isError in result
      if (result?.isError) {
        const errMsg = result.content?.map(c => c.text).join('\n') || 'unknown error';
        console.error(`[Pencil] callTool(${name}) tool error (full):`, errMsg.slice(0, 1000));
        return null;
      }
      return result;
    } catch (e) {
      console.error(`[Pencil] callTool(${name}) error:`, e.message?.slice(0, 500));
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
   * Design pages for a project using batch_design operations.
   * @param {object} plan - Design plan from _runDesign (pages, shared, designTokens)
   * @param {string} outputDir - Directory to save screenshots
   * @returns {object} { guidelines, screenshots: [{page, data}] }
   */
  async designPages(plan, outputDir) {
    if (!this.available) return null;

    try {
      // Get mobile app guidelines (works without opening a document)
      const guidelines = await this.getGuidelines('mobile-app');
      const guidelineText = this._extractText(guidelines);

      const screenshots = [];
      const pages = plan.pages || [];
      const primary = plan.designTokens?.primaryColor || '#3182F6';

      for (const page of pages) {
        try {
          const idx = pages.indexOf(page);
          const xOffset = idx * 420;
          const pageName = (page.name || '').replace(/"/g, '');
          const pageDesc = (page.description || '').replace(/"/g, '');

          // Step 1: Create empty screen frame
          const frameOps = `frm${String.fromCharCode(97 + idx)}=I(document, {type:"frame", name:"${pageName}", layout:"vertical", width:390, height:844, x:${xOffset}, fill:"#FFFFFF", clip:true, placeholder:true})`;
          console.log(`[Pencil] Creating frame for: ${pageName}`);
          const frameResult = await this.batchDesign(frameOps);
          const frameId = this._extractNodeId(frameResult);
          if (!frameId) { console.error(`[Pencil] Frame creation failed for ${pageName}`); screenshots.push({ page: page.name, route: page.route, data: null }); continue; }

          // Step 2: Let Pencil AI design the page content
          const aiPrompt = `Mobile app screen: ${pageName}. ${pageDesc}. Korean UI, modern minimal style, ${primary} primary color. Include header, main content area, and bottom navigation.`;
          console.log(`[Pencil] AI designing: ${pageName} — "${aiPrompt.slice(0, 80)}..."`);
          const aiResult = await this.callTool('batch_design', {
            operations: `G("${frameId}", "ai", "${aiPrompt.replace(/"/g, '\\"')}")`
          });
          console.log(`[Pencil] AI result:`, JSON.stringify(aiResult)?.slice(0, 200));

          // Step 3: Unmark placeholder
          await this.callTool('batch_design', { operations: `U("${frameId}", {placeholder:false})` });

          // Step 4: Export screenshot
          let ssData = null;
          if (outputDir) {
            try {
              const exportFolder = IS_WIN ? outputDir.replace(/\//g, '\\') : outputDir;
              const exportResult = await this.callTool('export_nodes', { nodeIds: [frameId], format: 'png', outputDir: exportFolder });
              console.log(`[Pencil] Export:`, JSON.stringify(exportResult)?.slice(0, 150));
              const pngPath = join(outputDir, `${frameId}.png`);
              if (existsSync(pngPath)) {
                ssData = readFileSync(pngPath).toString('base64');
              }
            } catch (exportErr) {
              console.error(`[Pencil] Export failed:`, exportErr.message);
            }
          }
          console.log(`[Pencil] Screenshot for ${page.name}: ${ssData ? ssData.length + ' bytes' : 'NONE'}`);
          screenshots.push({ page: page.name, route: page.route, data: ssData });
        } catch (e) {
          console.error(`[Pencil] Failed page "${page.name}":`, e.message);
          screenshots.push({ page: page.name, route: page.route, data: null, error: e.message });
        }
      }

      return { guidelines: guidelineText, screenshots };
    } catch (e) {
      return null;
    }
  }

  /** Extract first node ID from batch_design result */
  _extractNodeId(result) {
    if (!result?.content) return null;
    for (const c of result.content) {
      if (c.type === 'text' && c.text) {
        // Pattern: "Inserted node `nodeId`"
        const m = c.text.match(/Inserted node .(\w+)/);
        if (m) return m[1];
      }
    }
    return null;
  }

  /** Build batch_design operations for a single mobile page */
  _buildPageOperations(page, primaryColor, index) {
    const pageName = (page.name || `Page ${index}`).replace(/"/g, '');
    const desc = (page.description || '').replace(/"/g, '').slice(0, 40);
    const xOffset = index * 420;

    // Ensure primaryColor is hex (Pencil only accepts #RRGGBB)
    const hexColor = /^#[0-9a-fA-F]{3,8}$/.test(primaryColor) ? primaryColor : '#3182F6';
    const v = String.fromCharCode(97 + index); // a, b, c, d, e...
    return [
      `scr${v}=I(document, {type:"frame", name:"${pageName}", layout:"vertical", width:390, height:844, x:${xOffset}, fill:"#F7F8FA", clip:true})`,
      `hdr${v}=I(scr${v}, {type:"frame", layout:"horizontal", width:"fill_container", height:56, padding:[0,20], alignItems:"center", fill:"#FFFFFF"})`,
      `I(hdr${v}, {type:"text", content:"${pageName}", fontSize:20, fontWeight:"bold", fill:"#191F28"})`,
      `cnt${v}=I(scr${v}, {type:"frame", layout:"vertical", width:"fill_container", height:"fill_container", padding:[16,20,80,20], gap:16})`,
      `ban${v}=I(cnt${v}, {type:"frame", layout:"vertical", width:"fill_container", padding:[20,20], gap:8, cornerRadius:16, fill:"${hexColor}"})`,
      `I(ban${v}, {type:"text", content:"${desc || pageName}", fontSize:18, fontWeight:"bold", fill:"#FFFFFF"})`,
      `crd${v}=I(cnt${v}, {type:"frame", layout:"horizontal", width:"fill_container", padding:16, gap:12, cornerRadius:16, fill:"#FFFFFF", stroke:{align:"inside", fill:"#E5E8EB", thickness:1}, alignItems:"center"})`,
      `I(crd${v}, {type:"frame", width:48, height:48, cornerRadius:12, fill:"#E8F3FF"})`,
      `txt${v}=I(crd${v}, {type:"frame", layout:"vertical", width:"fill_container", gap:4})`,
      `I(txt${v}, {type:"text", content:"${pageName} 항목", fontSize:15, fontWeight:"600", fill:"#191F28"})`,
      `I(txt${v}, {type:"text", content:"상세 내용", fontSize:13, fill:"#8B95A1"})`,
    ].join('\n');
  }

  _extractText(result) {
    if (!result?.content) return '';
    const item = result.content.find(c => c.type === 'text');
    return item?.text || '';
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
