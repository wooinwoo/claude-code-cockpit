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
    if (this.available) return true; // Already connected (own process or external)

    // Try connecting to an already-running Pencil MCP first
    try {
      await this._waitForReady();
      await this._initialize();
      this.available = true;
      return true;
    } catch { /* not running, try spawning */ }

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
   * Design pages using LLM-generated Pencil batch_design operations.
   * Instead of AI raster images or hardcoded templates, asks an LLM (Claude)
   * to produce vector UI operations for each page.
   *
   * @param {object} plan - Design plan (pages, shared, designTokens)
   * @param {string} outputDir - Directory to save PNG screenshots
   * @param {function} callLLM - async (systemPrompt, userPrompt) => string
   * @returns {object} { guidelines, designSystem, screenshots: [{page, route, data}] }
   */
  async designPages(plan, outputDir, callLLM) {
    if (!this.available) return null;
    if (!callLLM) throw new Error('callLLM function is required for designPages');

    try {
      // Get mobile app guidelines
      const guidelines = await this.getGuidelines('mobile-app');
      const guidelineText = this._extractText(guidelines);

      const pages = plan.pages || [];
      const primary = plan.designTokens?.primaryColor || '#3182F6';
      const secondary = plan.designTokens?.secondaryColor || '#F2F4F6';
      const appName = plan.shared?.appName || plan.name || 'App';

      // Step 1: Ask LLM to define the design system (colors, shared components)
      console.log(`[Pencil] Generating design system via LLM...`);
      const designSystem = await this._generateDesignSystem(callLLM, {
        appName,
        primary,
        secondary,
        pages: pages.map(p => ({ name: p.name, description: p.description, route: p.route })),
        guidelines: guidelineText?.slice(0, 2000),
      });
      console.log(`[Pencil] Design system:`, JSON.stringify(designSystem).slice(0, 300));

      // Step 2: Design each page via LLM
      const screenshots = [];
      const navItems = pages.slice(0, 5).map(p => ({ name: p.name, icon: p.icon || 'home' }));

      for (let idx = 0; idx < pages.length; idx++) {
        const page = pages[idx];
        try {
          const pageName = (page.name || '').replace(/"/g, '');
          const xOffset = idx * 420;

          // Step 2a: Create the root frame
          const v = String.fromCharCode(97 + idx);
          const frameOps = `frm${v}=I(document, {type:"frame", name:"${pageName}", layout:"vertical", width:390, height:844, x:${xOffset}, fill:"${designSystem.bgColor || '#FFFFFF'}", clip:true})`;
          console.log(`[Pencil] Creating frame for: ${pageName}`);
          const frameResult = await this.batchDesign(frameOps);
          const frameId = this._extractNodeId(frameResult);
          if (!frameId) {
            console.error(`[Pencil] Frame creation failed for ${pageName}`);
            screenshots.push({ page: page.name, route: page.route, data: null });
            continue;
          }

          // Step 2b: Ask LLM for page-specific operations
          console.log(`[Pencil] Generating operations for: ${pageName}`);
          const opsString = await this._generatePageOperations(callLLM, {
            frameId,
            varPrefix: v,
            page,
            designSystem,
            navItems,
            activeNavIndex: idx < 5 ? idx : 0,
            allPages: pages.map(p => p.name),
          });

          if (opsString) {
            console.log(`[Pencil] Executing operations for ${pageName} (${opsString.length} chars)`);
            const designResult = await this.batchDesign(opsString);
            if (!designResult) {
              console.warn(`[Pencil] batch_design returned null for ${pageName}, trying fallback`);
              const fallbackOps = this._buildFallbackOperations(frameId, v, page, designSystem);
              await this.batchDesign(fallbackOps);
            }
          } else {
            console.warn(`[Pencil] LLM returned no operations for ${pageName}, using fallback`);
            const fallbackOps = this._buildFallbackOperations(frameId, v, page, designSystem);
            await this.batchDesign(fallbackOps);
          }

          // Step 2c: Export screenshot
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

      return { guidelines: guidelineText, designSystem, screenshots };
    } catch (e) {
      console.error(`[Pencil] designPages error:`, e.message);
      return null;
    }
  }

  // ─── LLM-Driven Design Helpers ───

  /** System prompt teaching the LLM Pencil batch_design syntax */
  _getPencilSystemPrompt() {
    return `You are a mobile UI designer that outputs Pencil batch_design operations.

## Pencil batch_design Syntax

Each operation creates a UI node:
  varName=I(parent, {properties})

### Node Types
- "frame": container/layout box (use for rows, columns, cards, sections)
- "text": text label
- "icon_font": vector icon from Lucide icon set
- "rectangle": decorative rectangle
- "ellipse": circle/oval

### Layout Properties
- layout: "vertical" | "horizontal" | "none"
- width / height: number (px), "fill_container", or "fit_content"
- padding: number or [top, right, bottom, left]
- gap: number (space between children)
- alignItems: "center" | "start" | "end"
- justifyContent: "center" | "start" | "end" | "space_between"

### Style Properties
- fill: "#RRGGBB" (hex only, no alpha, no named colors)
- cornerRadius: number
- stroke: {align:"inside", fill:"#RRGGBB", thickness:number}
- clip: true/false
- opacity: 0-1

### Text Properties (inside I())
- type: "text", content: "string", fontSize: number, fontWeight: "bold"|"600"|"normal"
- fill: "#RRGGBB", fontFamily: "string"

### Icon Properties
- type: "icon_font", iconFontFamily: "lucide", icon: "icon-name"
- width: number, height: number, fill: "#RRGGBB"

## Rules
1. Variable names: ONLY lowercase letters (a-z). NO digits, no underscores, no camelCase.
2. Max 25 operations per response.
3. All colors must be 6-digit hex (#RRGGBB).
4. The root frame is already created — you receive its ID as parentFrameId.
5. Output ONLY the operations, one per line. No markdown, no explanation, no backticks.
6. Use "fill_container" for full-width elements inside vertical layouts.
7. For bottom tab bars, use layout:"horizontal" with justifyContent:"space_between".
8. Korean text is fine for UI labels.`;
  }

  /** Ask LLM to define a design system (palette, typography, component styles) */
  async _generateDesignSystem(callLLM, context) {
    const systemPrompt = `You are a mobile app design system architect. Output a JSON object defining the design system.
Return ONLY valid JSON, no markdown, no backticks, no explanation.`;

    const userPrompt = `Create a cohesive design system for "${context.appName}" mobile app.
Primary color: ${context.primary}
Secondary/background color: ${context.secondary}
Pages: ${context.pages.map(p => p.name).join(', ')}

Return JSON with this exact structure:
{
  "primary": "#hex",
  "primaryLight": "#hex (10% opacity equivalent on white)",
  "secondary": "#hex",
  "bgColor": "#hex (page background, very light)",
  "cardBg": "#hex (card background, white or near-white)",
  "textPrimary": "#hex (main text, dark)",
  "textSecondary": "#hex (secondary text, gray)",
  "textTertiary": "#hex (caption text, light gray)",
  "border": "#hex (subtle border)",
  "success": "#hex",
  "warning": "#hex",
  "error": "#hex",
  "headerHeight": 56,
  "tabBarHeight": 64,
  "cardRadius": 16,
  "iconRadius": 12,
  "pillRadius": 9999
}`;

    try {
      const raw = await callLLM(systemPrompt, userPrompt);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const ds = JSON.parse(jsonMatch[0]);
        // Ensure required fields have defaults
        return {
          primary: ds.primary || context.primary,
          primaryLight: ds.primaryLight || '#EBF5FF',
          secondary: ds.secondary || context.secondary,
          bgColor: ds.bgColor || '#F7F8FA',
          cardBg: ds.cardBg || '#FFFFFF',
          textPrimary: ds.textPrimary || '#191F28',
          textSecondary: ds.textSecondary || '#8B95A1',
          textTertiary: ds.textTertiary || '#B0B8C1',
          border: ds.border || '#E5E8EB',
          success: ds.success || '#34C759',
          warning: ds.warning || '#FF9F0A',
          error: ds.error || '#FF3B30',
          headerHeight: ds.headerHeight || 56,
          tabBarHeight: ds.tabBarHeight || 64,
          cardRadius: ds.cardRadius || 16,
          iconRadius: ds.iconRadius || 12,
          pillRadius: ds.pillRadius || 9999,
        };
      }
    } catch (e) {
      console.error(`[Pencil] Design system generation failed:`, e.message);
    }
    // Fallback design system
    return {
      primary: context.primary, primaryLight: '#EBF5FF', secondary: context.secondary,
      bgColor: '#F7F8FA', cardBg: '#FFFFFF', textPrimary: '#191F28',
      textSecondary: '#8B95A1', textTertiary: '#B0B8C1', border: '#E5E8EB',
      success: '#34C759', warning: '#FF9F0A', error: '#FF3B30',
      headerHeight: 56, tabBarHeight: 64, cardRadius: 16, iconRadius: 12, pillRadius: 9999,
    };
  }

  /** Ask LLM to generate batch_design operations for a single page */
  async _generatePageOperations(callLLM, context) {
    const { frameId, varPrefix, page, designSystem, navItems, activeNavIndex } = context;
    const ds = designSystem;

    const systemPrompt = this._getPencilSystemPrompt() + `

## Design System (use these exact colors)
- Primary: ${ds.primary}
- Primary Light: ${ds.primaryLight}
- Background: ${ds.bgColor}
- Card: ${ds.cardBg}
- Text Primary: ${ds.textPrimary}
- Text Secondary: ${ds.textSecondary}
- Text Tertiary: ${ds.textTertiary}
- Border: ${ds.border}
- Success: ${ds.success} / Warning: ${ds.warning} / Error: ${ds.error}
- Card corner radius: ${ds.cardRadius}, Icon radius: ${ds.iconRadius}, Pill radius: ${ds.pillRadius}
- Header height: ${ds.headerHeight}, Tab bar height: ${ds.tabBarHeight}

## Typography Scale
- Page title: fontSize 24, fontWeight "bold"
- Section title: fontSize 18, fontWeight "bold"
- Body: fontSize 15, fontWeight "normal"
- Secondary: fontSize 13
- Caption: fontSize 11

## Structure Rules
- Every page has: status bar (44px) + header (${ds.headerHeight}px) + scrollable content + bottom tab bar (${ds.tabBarHeight}px)
- Status bar: frame with height 44, shows time "9:41" on left
- Header: horizontal frame, page title left-aligned, optional action icons right
- Content area: vertical frame with height "fill_container", padding [16,20,${ds.tabBarHeight + 16},20], gap 16
- Bottom tab bar: horizontal frame pinned at bottom, ${navItems.length} items, active item uses primary color
- Use variable prefix "${varPrefix}" for all variable names (e.g., ${varPrefix}hdr, ${varPrefix}cnt, ${varPrefix}tab)`;

    const navDesc = navItems.map((n, i) => `${n.name}${i === activeNavIndex ? ' (ACTIVE)' : ''}: icon "${n.icon}"`).join(', ');

    const userPrompt = `Design the "${page.name}" page for the mobile app.
Parent frame ID: "${frameId}"
Variable prefix: "${varPrefix}" (append letters like ${varPrefix}a, ${varPrefix}b, etc.)

Page description: ${page.description || 'Standard mobile app page'}
${page.components ? `Key components: ${page.components.join(', ')}` : ''}
${page.sections ? `Sections: ${JSON.stringify(page.sections)}` : ''}

Bottom tab bar items: ${navDesc}

Create a realistic, production-quality mobile UI layout with:
1. Status bar (44px, white bg, "9:41" text)
2. Header with page title
3. Main content with cards, lists, or relevant UI for this page type
4. Bottom tab bar with icons and labels

Output only the batch_design operations, one per line. Max 25 operations.`;

    try {
      const raw = await callLLM(systemPrompt, userPrompt);
      // Clean response: remove markdown fences, trim whitespace
      const cleaned = raw
        .replace(/```[a-z]*\n?/g, '')
        .replace(/```/g, '')
        .trim();

      // Validate: must contain I( calls
      if (!cleaned.includes('I(')) {
        console.warn(`[Pencil] LLM response has no I() calls:`, cleaned.slice(0, 200));
        return null;
      }

      // Filter to only lines that are valid operations (contain I( or U( or G()
      const lines = cleaned.split('\n')
        .map(l => l.trim())
        .filter(l => l && (l.includes('I(') || l.includes('U(') || l.includes('G(')))
        .slice(0, 25); // enforce max 25

      return lines.join('\n');
    } catch (e) {
      console.error(`[Pencil] LLM page generation failed for ${page.name}:`, e.message);
      return null;
    }
  }

  /** Fallback: minimal hardcoded layout when LLM fails */
  _buildFallbackOperations(frameId, varPrefix, page, designSystem) {
    const ds = designSystem;
    const v = varPrefix;
    const pageName = (page.name || 'Page').replace(/"/g, '');
    return [
      `${v}hdr=I("${frameId}", {type:"frame", layout:"horizontal", width:"fill_container", height:${ds.headerHeight}, padding:[0,20], alignItems:"center", fill:"${ds.cardBg}"})`,
      `I(${v}hdr, {type:"text", content:"${pageName}", fontSize:24, fontWeight:"bold", fill:"${ds.textPrimary}"})`,
      `${v}cnt=I("${frameId}", {type:"frame", layout:"vertical", width:"fill_container", height:"fill_container", padding:[16,20,80,20], gap:16})`,
      `${v}crd=I(${v}cnt, {type:"frame", layout:"vertical", width:"fill_container", padding:[20,20], gap:8, cornerRadius:${ds.cardRadius}, fill:"${ds.cardBg}", stroke:{align:"inside", fill:"${ds.border}", thickness:1}})`,
      `I(${v}crd, {type:"text", content:"${pageName}", fontSize:18, fontWeight:"bold", fill:"${ds.textPrimary}"})`,
      `I(${v}crd, {type:"text", content:"${(page.description || '').replace(/"/g, '').slice(0, 60)}", fontSize:13, fill:"${ds.textSecondary}"})`,
      `${v}tab=I("${frameId}", {type:"frame", layout:"horizontal", width:"fill_container", height:${ds.tabBarHeight}, padding:[8,20], alignItems:"center", justifyContent:"space_between", fill:"${ds.cardBg}", stroke:{align:"inside", fill:"${ds.border}", thickness:1}})`,
      `I(${v}tab, {type:"icon_font", iconFontFamily:"lucide", icon:"home", width:24, height:24, fill:"${ds.primary}"})`,
    ].join('\n');
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
