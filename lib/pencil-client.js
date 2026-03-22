// ─── Pencil MCP HTTP Client ───
// Connects to Pencil MCP server in HTTP mode for AI design generation
// Backend-only: user never sees VS Code or Pencil directly

import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
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
   * Design pages for a project using batch_design operations.
   * @param {object} plan - Design plan from _runDesign (pages, shared, designTokens)
   * @param {string} outputDir - Directory to save screenshots
   * @returns {object} { guidelines, screenshots: [{page, data}] }
   */
  async designPages(plan, outputDir) {
    if (!this.available) return null;

    try {
      // Open new document with shadcn template (best starting point)
      await this.openDocument('shadcn');

      // Get mobile app guidelines
      const guidelines = await this.getGuidelines('mobile-app');
      const guidelineText = this._extractText(guidelines);

      const screenshots = [];
      const pages = plan.pages || [];
      const primary = plan.designTokens?.primaryColor || '#3182F6';

      for (const page of pages) {
        try {
          const ops = this._buildPageOperations(page, primary, pages.indexOf(page));
          await this.batchDesign(ops);

          // Get screenshot of the created screen
          const ss = await this.getScreenshot();
          const ssData = ss?.content?.find(c => c.type === 'image')?.data || null;
          screenshots.push({ page: page.name, route: page.route, data: ssData });
        } catch (e) {
          screenshots.push({ page: page.name, route: page.route, data: null, error: e.message });
        }
      }

      return { guidelines: guidelineText, screenshots };
    } catch (e) {
      return null;
    }
  }

  /** Build batch_design operations for a single mobile page */
  _buildPageOperations(page, primaryColor, index) {
    const pageName = page.name || `Page ${index}`;
    const desc = page.description || '';
    const xOffset = index * 420; // Space screens horizontally

    return [
      // Screen frame (iPhone 14 Pro size)
      `screen${index}=I(document, {type:"frame", name:"${pageName}", layout:"vertical", width:390, height:844, x:${xOffset}, fill:"#F7F8FA", clip:true})`,

      // Status bar
      `sb${index}=I(screen${index}, {type:"frame", layout:"horizontal", width:"fill_container", height:54, padding:[0,16], alignItems:"center", justifyContent:"space_between", fill:"#FFFFFF"})`,
      `I(sb${index}, {type:"text", content:"9:41", fontFamily:"Inter", fontSize:15, fontWeight:"600", fill:"#191F28"})`,

      // Header
      `hdr${index}=I(screen${index}, {type:"frame", layout:"horizontal", width:"fill_container", height:56, padding:[0,20], alignItems:"center", justifyContent:"space_between", fill:"#FFFFFF"})`,
      `I(hdr${index}, {type:"text", content:"${pageName}", fontSize:20, fontWeight:"bold", fill:"#191F28"})`,
      `I(hdr${index}, {type:"icon_font", iconFontFamily:"lucide", icon:"bell", width:22, height:22, fill:"#8B95A1"})`,

      // Content wrapper
      `cw${index}=I(screen${index}, {type:"frame", layout:"vertical", width:"fill_container", height:"fill_container", padding:[16,20,100,20], gap:16})`,

      // Hero card
      `hero${index}=I(cw${index}, {type:"frame", layout:"vertical", width:"fill_container", padding:[20,20], gap:8, cornerRadius:16, fill:{type:"linear_gradient", from:[0,0], to:[1,1], stops:[{offset:0, color:"${primaryColor}"}, {offset:1, color:"#6366F1"}]}})`,
      `I(hero${index}, {type:"text", content:"${desc.slice(0, 30) || pageName}", fontSize:18, fontWeight:"bold", fill:"#FFFFFF"})`,
      `I(hero${index}, {type:"text", content:"${desc.slice(30, 80) || '새로운 혜택을 확인하세요'}", fontSize:13, fill:"rgba(255,255,255,0.8)"})`,

      // Content cards (2 sample cards)
      `card1_${index}=I(cw${index}, {type:"frame", layout:"horizontal", width:"fill_container", padding:16, gap:12, cornerRadius:16, fill:"#FFFFFF", stroke:{align:"inside", fill:"#E5E8EB", thickness:1}, alignItems:"center"})`,
      `I(card1_${index}, {type:"frame", width:48, height:48, cornerRadius:12, fill:"${primaryColor}20"})`,
      `ct1_${index}=I(card1_${index}, {type:"frame", layout:"vertical", width:"fill_container", gap:4})`,
      `I(ct1_${index}, {type:"text", content:"샘플 항목 1", fontSize:15, fontWeight:"600", fill:"#191F28"})`,
      `I(ct1_${index}, {type:"text", content:"설명 텍스트가 여기에 표시됩니다", fontSize:13, fill:"#8B95A1"})`,

      `card2_${index}=I(cw${index}, {type:"frame", layout:"horizontal", width:"fill_container", padding:16, gap:12, cornerRadius:16, fill:"#FFFFFF", stroke:{align:"inside", fill:"#E5E8EB", thickness:1}, alignItems:"center"})`,
      `I(card2_${index}, {type:"frame", width:48, height:48, cornerRadius:12, fill:"#10B98120"})`,
      `ct2_${index}=I(card2_${index}, {type:"frame", layout:"vertical", width:"fill_container", gap:4})`,
      `I(ct2_${index}, {type:"text", content:"샘플 항목 2", fontSize:15, fontWeight:"600", fill:"#191F28"})`,
      `I(ct2_${index}, {type:"text", content:"추가 설명이 여기에 표시됩니다", fontSize:13, fill:"#8B95A1"})`,

      // Bottom tab bar
      `tb${index}=I(screen${index}, {type:"frame", layout:"horizontal", width:"fill_container", height:83, padding:[12,21,21,21], justifyContent:"center", fill:"#FFFFFF"})`,
      `pill${index}=I(tb${index}, {type:"frame", layout:"horizontal", width:"fill_container", height:62, cornerRadius:36, stroke:{align:"inside", fill:"#E5E8EB", thickness:1}, padding:4})`,

      // Tab items
      `t1_${index}=I(pill${index}, {type:"frame", layout:"vertical", width:"fill_container", height:"fill_container", cornerRadius:26, gap:4, alignItems:"center", justifyContent:"center", fill:"${primaryColor}"})`,
      `I(t1_${index}, {type:"icon_font", iconFontFamily:"lucide", icon:"home", width:18, height:18, fill:"#FFFFFF"})`,
      `I(t1_${index}, {type:"text", content:"홈", fontSize:10, fontWeight:"600", fill:"#FFFFFF"})`,

      `t2_${index}=I(pill${index}, {type:"frame", layout:"vertical", width:"fill_container", height:"fill_container", cornerRadius:26, gap:4, alignItems:"center", justifyContent:"center"})`,
      `I(t2_${index}, {type:"icon_font", iconFontFamily:"lucide", icon:"search", width:18, height:18, fill:"#8B95A1"})`,
      `I(t2_${index}, {type:"text", content:"검색", fontSize:10, fontWeight:"600", fill:"#8B95A1"})`,
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
