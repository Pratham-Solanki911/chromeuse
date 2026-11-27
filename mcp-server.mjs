#!/usr/bin/env node
// ChromeUse Universal MCP Server & Native Messaging Bridge (Zero external dependencies, Node 20+)
// Works with Antigravity, Claude Desktop/Code, Cursor, GPT/MCP clients, and any MCP host.

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT = Number(process.env.CHROMEUSE_PORT || 18971);
const HOST = "127.0.0.1";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_WS_PAYLOAD = 32 * 1024 * 1024; // 32 MB ceiling for high-DPI screenshots
const SUPPORTED_MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const TOKEN_PATH = path.join(os.homedir(), ".chromeuse-bridge.token");

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".html": "text/html",
  ".zip": "application/zip"
};

function getOrCreateBridgeToken() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const existing = fs.readFileSync(TOKEN_PATH, "utf8").trim();
      if (existing.length >= 32) return existing;
    }
  } catch {}
  const fresh = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(TOKEN_PATH, fresh, { mode: 0o600 });
  } catch {}
  return fresh;
}

// ---- Minimal RFC 6455 WebSocket Connection Wrapper ----

class WsConnection {
  constructor(socket, head) {
    this.socket = socket;
    this.alive = true;
    this._buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this._fragments = [];
    this._fragOpcode = 0;
    this._fragBytes = 0;
    this.onMessage = null;
    this.onClose = null;

    socket.setNoDelay(true);
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._handleClose());
    socket.on("error", () => this._handleClose());
    if (this._buf.length) this._parseLoop();
  }

  _handleClose() {
    if (!this.alive) return;
    this.alive = false;
    this._buf = Buffer.alloc(0);
    this._fragments = [];
    this.onClose?.();
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    if (this._buf.length > MAX_WS_PAYLOAD + 65536) {
      this.close();
      return;
    }
    this._parseLoop();
  }

  _parseLoop() {
    while (this.alive && this._buf.length >= 2) {
      const b0 = this._buf[0];
      const b1 = this._buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this._buf.length < 4) return;
        len = this._buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this._buf.length < 10) return;
        const big = this._buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_WS_PAYLOAD)) {
          this.close();
          return;
        }
        len = Number(big);
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this._buf.length < offset + maskLen + len) return;

      const payload = Buffer.from(this._buf.subarray(offset + maskLen, offset + maskLen + len));
      if (masked) {
        const mask = this._buf.subarray(offset, offset + 4);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      this._buf = this._buf.subarray(offset + maskLen + len);

      // Control frames may be interleaved between fragmented data frames (RFC 6455 §5.4)
      if (opcode === 0x8) {
        this.sendFrame(0x8, Buffer.alloc(0));
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0x0a, payload);
        continue;
      }
      if (opcode === 0x0a) continue;

      if (opcode === 0x1 || opcode === 0x2) {
        if (fin) {
          if (opcode === 0x1) this.onMessage?.(payload.toString("utf8"));
        } else {
          this._fragOpcode = opcode;
          this._fragments = [payload];
          this._fragBytes = payload.length;
        }
      } else if (opcode === 0x0) {
        this._fragBytes += payload.length;
        if (this._fragBytes > MAX_WS_PAYLOAD) {
          this.close();
          return;
        }
        this._fragments.push(payload);
        if (fin) {
          const full = Buffer.concat(this._fragments);
          const origOp = this._fragOpcode;
          this._fragments = [];
          this._fragBytes = 0;
          if (origOp === 0x1) this.onMessage?.(full.toString("utf8"));
        }
      }
    }
  }

  sendFrame(opcode, dataBuf) {
    if (!this.alive) return;
    const len = dataBuf.length;
    let hdr;
    if (len < 126) {
      hdr = Buffer.alloc(2);
      hdr[0] = 0x80 | opcode;
      hdr[1] = len;
    } else if (len < 65536) {
      hdr = Buffer.alloc(4);
      hdr[0] = 0x80 | opcode;
      hdr[1] = 126;
      hdr.writeUInt16BE(len, 2);
    } else {
      hdr = Buffer.alloc(10);
      hdr[0] = 0x80 | opcode;
      hdr[1] = 127;
      hdr.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([hdr, dataBuf]));
    } catch {
      this.close();
    }
  }

  sendJson(obj) {
    this.sendFrame(0x1, Buffer.from(JSON.stringify(obj), "utf8"));
  }

  close() {
    if (!this.alive) return;
    this.alive = false;
    try { this.socket.destroy(); } catch {}
    this.onClose?.();
  }
}

// ---- Bridge Hub (Leader + Peer Relay) ----

export class ChromeUseBridge {
  constructor({ port = PORT, host = HOST, token = getOrCreateBridgeToken() } = {}) {
    this.port = port;
    this.host = host;
    this.token = token;
    this.isLeader = false;
    this.server = null;
    this.extConn = null;
    this.nextRpcId = 1;
    this.pendingRpc = new Map(); // id -> { resolve, reject, timer }
    this.waiters = []; // Array<{ resolve, timer }>
    this.pingTimer = null;
  }

  async start() {
    const claimed = await this._tryListen();
    if (!claimed) {
      this.isLeader = false;
    }
    return this.isLeader;
  }

  _tryListen() {
    return new Promise((resolve) => {
      const srv = http.createServer((req, res) => this._handleHttp(req, res));

      srv.on("upgrade", (req, socket, head) => {
        const origin = String(req.headers.origin || "");
        const key = req.headers["sec-websocket-key"];
        // Security boundary: only Chrome Extensions may open the control WebSocket
        if (req.url !== "/ext" || !origin.startsWith("chrome-extension://") || !key) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
        socket.write(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            "\r\n"
          ].join("\r\n")
        );
        this._attachExtension(new WsConnection(socket, head));
      });

      srv.once("error", (err) => {
        if (err.code === "EADDRINUSE") {
          resolve(false);
        } else {
          resolve(false);
        }
      });

      srv.listen(this.port, this.host, () => {
        this.server = srv;
        this.isLeader = true;
        this.pingTimer = setInterval(() => {
          if (this.extConn?.alive) {
            this.extConn.sendJson({ type: "ping", ts: Date.now() });
          }
        }, 15000);
        this.pingTimer.unref?.();
        resolve(true);
      });
    });
  }

  _attachExtension(conn) {
    if (this.extConn && this.extConn !== conn) {
      this.extConn.close();
    }
    this.extConn = conn;
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(conn);
    }

    conn.onMessage = (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (!msg || typeof msg !== "object") return;
      if (msg.id !== undefined && this.pendingRpc.has(msg.id)) {
        const entry = this.pendingRpc.get(msg.id);
        this.pendingRpc.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.ok) entry.resolve(msg.result);
        else entry.reject(new Error(msg.error || "Extension command failed"));
      }
    };

    const prevOnClose = conn.onClose;
    conn.onClose = () => {
      if (this.extConn === conn) {
        this.extConn = null;
        for (const [id, entry] of this.pendingRpc.entries()) {
          this.pendingRpc.delete(id);
          clearTimeout(entry.timer);
          entry.reject(new Error("Chrome extension disconnected during command"));
        }
      }
      prevOnClose?.();
    };
  }

  _handleHttp(req, res) {
    const origin = String(req.headers.origin || "");
    if (req.method === "GET" && req.url === "/health") {
      const headers = { "Content-Type": "application/json" };
      if (origin.startsWith("chrome-extension://")) {
        headers["Access-Control-Allow-Origin"] = origin;
      }
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, connected: Boolean(this.extConn?.alive) }));
      return;
    }

    if (req.method === "POST" && req.url === "/rpc") {
      // Security boundary: block browser cross-site fetches and require local file token
      if (origin || req.headers["sec-fetch-site"] || req.headers["x-chromeuse-token"] !== this.token) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Forbidden" }));
        return;
      }
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_WS_PAYLOAD) req.destroy();
        else chunks.push(c);
      });
      req.on("end", async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const result = await this._callLocalExtension(body.cmd, body.params || {}, body.timeoutMs || 30000);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  }

  _waitForExtension(waitMs = 4500) {
    if (this.extConn?.alive) return Promise.resolve(this.extConn);
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        timer: setTimeout(() => {
          const idx = this.waiters.indexOf(waiter);
          if (idx >= 0) this.waiters.splice(idx, 1);
          reject(
            new Error(
              "ChromeUse extension is not connected. Make sure Chrome is open, ChromeUse is loaded/reloaded at chrome://extensions, and its badge is not set to OFF."
            )
          );
        }, waitMs)
      };
      this.waiters.push(waiter);
    });
  }

  async _callLocalExtension(cmd, params = {}, timeoutMs = 30000) {
    const conn = await this._waitForExtension(4500);
    const id = this.nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for Chrome extension '${cmd}'`));
      }, timeoutMs);
      this.pendingRpc.set(id, { resolve, reject, timer });
      conn.sendJson({ id, cmd, params });
    });
  }

  async call(cmd, params = {}, timeoutMs = 30000) {
    if (this.isLeader) {
      return await this._callLocalExtension(cmd, params, timeoutMs);
    }
    // Peer relay mode -> forward to leader on 127.0.0.1:PORT; promote self if leader exited
    try {
      const res = await fetch(`http://${this.host}:${this.port}/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-ChromeUse-Token": this.token
        },
        body: JSON.stringify({ cmd, params, timeoutMs })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Peer RPC failed");
      return data.result;
    } catch (err) {
      if (String(err?.cause?.code || err?.message || "").includes("ECONNREFUSED")) {
        const promoted = await this._tryListen();
        if (promoted) return await this._callLocalExtension(cmd, params, timeoutMs);
      }
      throw err;
    }
  }

  async close() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const conn = this.extConn;
    this.extConn = null;
    if (conn) conn.close();
    if (this.server) {
      const srv = this.server;
      this.server = null;
      srv.closeAllConnections?.();
      await new Promise((r) => srv.close(() => r()));
    }
    this.isLeader = false;
  }
}

// ---- MCP Tool Definitions (Claude-in-Chrome + Operator Hybrid Suite) ----

export const TOOLS = [
  {
    name: "tabs",
    description:
      "List, open, switch/activate, close, close_agent_tabs, reload, navigate back/forward, or group Chrome tabs. Agent tabs are automatically placed in the 'AI Agent' tab group so the user doesn't click them by mistake. IMPORTANT: Always close tabs you opened once your work is finished (use action:'close' or action:'close_agent_tabs').",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["list", "new", "activate", "close", "close_agent_tabs", "reload", "back", "forward", "group"],
          default: "list",
          description: "Tab operation to perform. Use 'close' or 'close_agent_tabs' when done working."
        },
        tabId: { type: "number", description: "Target tab ID (optional; defaults to the agent's active grouped tab)." },
        tabIds: { type: "array", items: { type: "number" }, description: "Multiple tab IDs for close or group." },
        url: { type: "string", description: "URL to open when action is 'new'." },
        active: { type: "boolean", default: true, description: "Focus the new tab immediately." },
        groupTitle: { type: "string", description: "Optional title when action is 'group'." }
      }
    }
  },
  {
    name: "navigate",
    description:
      "Navigate to a URL inside the 'AI Agent' tab group (automatically opens a grouped agent tab instead of overwriting the user's personal tab when starting fresh), wait for load, and return an interactive snapshot. Close tabs you opened via 'tabs' once finished.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", description: "Destination URL." },
        tabId: { type: "number", description: "Optional target tab ID (defaults to active tab)." },
        newTab: { type: "boolean", default: false, description: "Open in a new tab instead of reusing active tab." },
        waitUntil: { type: "string", enum: ["load", "domcontentloaded", "none"], default: "load" },
        timeoutMs: { type: "number", default: 15000 },
        includeSnapshot: { type: "boolean", default: true, description: "Include compact interactive snapshot after load." }
      }
    }
  },
  {
    name: "read_page",
    description:
      "Read the current DOM & accessibility outline of the page with stable [ref_N] element IDs (preferred over screenshots for speed and token efficiency). Supports 'interactive' (controls + landmarks + text cues), 'full' (all visible text + controls), or 'markdown' (clean article/table Markdown).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Optional tab ID (defaults to active tab)." },
        mode: { type: "string", enum: ["interactive", "full", "markdown"], default: "interactive" },
        rootRef: { type: "string", description: "Scope snapshot to subtree of a specific ref (e.g. 'ref_8')." },
        selector: { type: "string", description: "Scope snapshot to a CSS selector (e.g. 'dialog', 'main', '#results')." },
        includeViewportOnly: { type: "boolean", default: false, description: "Only include elements currently inside the viewport." },
        maxDepth: { type: "number", default: 14 },
        maxChars: { type: "number", default: 30000 }
      }
    }
  },
  {
    name: "find",
    description:
      "Fast semantic/keyword/CSS search across the entire page (including off-screen elements and open Shadow DOM). Returns matching [ref_N] IDs, roles, values, and coordinates without dumping the whole page.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: { type: "string", description: "Visible text, label, placeholder, aria-label, or CSS selector to find." },
        role: { type: "string", description: "Optional role filter (e.g. 'button', 'link', 'input', 'textbox', 'combobox')." },
        limit: { type: "number", default: 25 },
        tabId: { type: "number", description: "Optional tab ID (defaults to active tab)." }
      }
    }
  },
  {
    name: "act",
    description:
      "Perform one action or a sequential batch of actions ('steps') on the page: click, double_click, right_click, hover, fill, type, press_key, select, check, uncheck, clear, focus, scroll, or wait. Works seamlessly with React/Vue/Angular inputs and contenteditable rich editors. Set returnSnapshot:true to get the updated page refs in the same round-trip.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tabId: { type: "number", description: "Optional tab ID (defaults to active tab)." },
        action: {
          type: "string",
          enum: ["click", "double_click", "right_click", "hover", "fill", "type", "press_key", "select", "check", "uncheck", "clear", "focus", "scroll", "wait"],
          description: "Action to execute (omit if passing 'steps' batch array)."
        },
        ref: { type: "string", description: "Target element ref from read_page/find (e.g. 'ref_12' or '12')." },
        selector: { type: "string", description: "Fallback CSS selector if not targeting by ref." },
        text: { type: "string", description: "Visible text/label to match (or text condition when action='wait')." },
        value: { type: "string", description: "Text/option value for fill, type, or select." },
        key: { type: "string", description: "Key or shortcut for press_key (e.g. 'Enter', 'Escape', 'Tab', 'Control+a')." },
        clear: { type: "boolean", description: "Clear existing input before typing (when action='type')." },
        submit: { type: "boolean", description: "Press Enter/submit after typing (when action='type')." },
        direction: { type: "string", enum: ["down", "up", "left", "right"], description: "Scroll direction." },
        amount: { type: "number", description: "Scroll distance in pixels (default 600)." },
        x: { type: "number", description: "Viewport X coordinate." },
        y: { type: "number", description: "Viewport Y coordinate." },
        ms: { type: "number", description: "Wait duration in ms when action='wait'." },
        force: { type: "boolean", default: false, description: "Run even if user manually interacted since last read_page." },
        returnSnapshot: { type: "boolean", default: false, description: "Return fresh read_page snapshot after action(s)." },
        steps: {
          type: "array",
          description: "Optional multi-step batch executed sequentially inside the tab in a single call.",
          items: {
            type: "object",
            properties: {
              action: { type: "string" },
              ref: { type: "string" },
              selector: { type: "string" },
              text: { type: "string" },
              value: { type: "string" },
              key: { type: "string" },
              clear: { type: "boolean" },
              submit: { type: "boolean" },
              direction: { type: "string" },
              amount: { type: "number" },
              ms: { type: "number" },
              timeoutMs: { type: "number" }
            },
            required: ["action"]
          }
        }
      }
    }
  },
  {
    name: "form_input",
    description:
      "Populate multiple form fields (inputs, textareas, <select> dropdowns, checkboxes, radios, contenteditables) in one call.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["fields"],
      properties: {
        tabId: { type: "number" },
        submit: { type: "boolean", default: false, description: "Submit the form after filling all fields." },
        force: { type: "boolean", default: false, description: "Run even if user manually interacted since last read_page." },
        fields: {
          type: "array",
          items: {
            type: "object",
            required: ["value"],
            properties: {
              ref: { type: "string", description: "Element ref (e.g. 'ref_5')." },
              selector: { type: "string", description: "CSS selector." },
              label: { type: "string", description: "Field label or placeholder text." },
              value: { type: "string", description: "Value to set (use 'true' or 'false' for checkboxes/radios)." }
            }
          }
        }
      }
    }
  },
  {
    name: "computer",
    description:
      "Visual & spatial browser tool: capture silent viewport or element screenshots (no debugger banner), perform pixel coordinate clicks/drags/scrolls, or handle native JS alert/confirm/prompt dialogs.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["screenshot", "left_click", "double_click", "right_click", "middle_click", "hover", "drag", "scroll", "handle_dialog"],
          default: "screenshot"
        },
        tabId: { type: "number" },
        ref: { type: "string", description: "Crop screenshot to a specific element ref." },
        selector: { type: "string", description: "Crop screenshot to a CSS selector." },
        region: {
          type: "object",
          description: "Crop screenshot to CSS pixel rectangle {x, y, width, height}.",
          properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }
        },
        format: { type: "string", enum: ["jpeg", "png", "webp"], default: "jpeg" },
        quality: { type: "number", default: 82, description: "JPEG/WebP quality (1-100)." },
        maxWidth: { type: "number", default: 1280, description: "Max output width in pixels." },
        filePath: { type: "string", description: "Optional local path to save the screenshot file." },
        x: { type: "number", description: "CSS X coordinate." },
        y: { type: "number", description: "CSS Y coordinate." },
        startX: { type: "number" },
        startY: { type: "number" },
        endX: { type: "number" },
        endY: { type: "number" },
        direction: { type: "string", enum: ["down", "up", "left", "right"] },
        amount: { type: "number" },
        trusted: {
          type: "boolean",
          default: false,
          description: "Set true only when OS-level CDP input is needed (e.g. Canvas/WebGL apps)."
        },
        accept: { type: "boolean", default: true, description: "Accept or dismiss JS dialog when action='handle_dialog'." },
        promptText: { type: "string", description: "Prompt input text when action='handle_dialog'." },
        force: { type: "boolean", default: false, description: "Run even if user manually interacted since last read_page." }
      }
    }
  },
  {
    name: "wait_for",
    description:
      "Wait inside the tab (zero polling overhead) for a selector, text appearance/disappearance, URL substring, or full tab load.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        selector: { type: "string", description: "Wait until CSS selector is visible." },
        selectorHidden: { type: "string", description: "Wait until CSS selector disappears." },
        text: { type: "string", description: "Wait until visible page text contains string." },
        textGone: { type: "string", description: "Wait until visible page text no longer contains string." },
        urlContains: { type: "string", description: "Wait until location.href contains string." },
        loadComplete: { type: "boolean", description: "Wait until tab status is 'complete'." },
        timeoutMs: { type: "number", default: 10000 }
      }
    }
  },
  {
    name: "evaluate",
    description:
      "Execute JavaScript (sync or async/await) in the page's MAIN world (accessing window/app state/fetch) or ISOLATED world and return JSON.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expression"],
      properties: {
        expression: { type: "string", description: "JS expression or async function body to run." },
        args: { type: "array", items: { type: "string" }, description: "Optional string arguments available as `args`." },
        world: { type: "string", enum: ["MAIN", "ISOLATED"], default: "MAIN" },
        tabId: { type: "number" }
      }
    }
  },
  {
    name: "console_logs",
    description: "Read console.log/info/warn/error and uncaught page errors from the tab.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        level: { type: "string", enum: ["log", "info", "warn", "error", "pageerror", "unhandledrejection"] },
        search: { type: "string" },
        clear: { type: "boolean", default: false },
        limit: { type: "number", default: 100 }
      }
    }
  },
  {
    name: "network_requests",
    description:
      "Read recent HTTP/fetch/XHR/document network requests passively recorded on the tab (method, status code, resource type, duration, URL).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        tabId: { type: "number" },
        urlFilter: { type: "string", description: "Case-insensitive URL substring filter." },
        method: { type: "string", description: "HTTP method filter (e.g. GET, POST)." },
        status: { type: "string", description: "Status code filter (e.g. '200', '404', 'ERR')." },
        resourceType: { type: "string", description: "e.g. xmlhttprequest, fetch, main_frame, script." },
        clear: { type: "boolean", default: false },
        limit: { type: "number", default: 80 }
      }
    }
  },
  {
    name: "cookies",
    description: "List, get, set, or delete browser cookies (including HttpOnly cookies) for a URL or domain.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["list", "get", "set", "delete"], default: "list" },
        tabId: { type: "number" },
        url: { type: "string" },
        domain: { type: "string" },
        name: { type: "string" },
        value: { type: "string" },
        path: { type: "string", default: "/" },
        secure: { type: "boolean" },
        httpOnly: { type: "boolean" },
        sameSite: { type: "string", enum: ["no_restriction", "lax", "strict", "unspecified"] },
        expirationDate: { type: "number" }
      }
    }
  },
  {
    name: "upload_file",
    description: "Attach one or more local files to an <input type='file'> element silently without opening an OS file dialog.",
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["filePaths"],
      properties: {
        tabId: { type: "number" },
        ref: { type: "string", description: "Ref ID of the <input type='file'> element." },
        selector: { type: "string", description: "CSS selector of the <input type='file'> element." },
        force: { type: "boolean", default: false, description: "Run even if user manually interacted since last read_page." },
        filePaths: {
          type: "array",
          items: { type: "string" },
          description: "Local file path(s) to upload."
        }
      }
    }
  }
];

export async function executeMcpTool(bridge, name, rawArgs = {}) {
  const args = rawArgs && typeof rawArgs === "object" ? { ...rawArgs } : {};

  if (name === "upload_file") {
    const paths = Array.isArray(args.filePaths) ? args.filePaths.map((p) => path.resolve(String(p))) : [];
    if (!paths.length) throw new Error("filePaths must contain at least one file path");
    let totalBytes = 0;
    for (const p of paths) {
      if (!fs.existsSync(p)) throw new Error(`File does not exist: ${p}`);
      totalBytes += fs.statSync(p).size;
    }
    if (totalBytes <= 512 * 1024) {
      // mytail: 512KB raw (~683KB base64) stays safely below Chrome Native Messaging's 1MB host->extension cap.
      const files = paths.map((p) => ({
        name: path.basename(p),
        mimeType: MIME_BY_EXT[path.extname(p).toLowerCase()] || "application/octet-stream",
        base64: fs.readFileSync(p).toString("base64")
      }));
      const res = await bridge.call("upload_file", { tabId: args.tabId, ref: args.ref, selector: args.selector, files });
      return { content: [{ type: "text", text: res.text || "Uploaded file(s)" }] };
    }
    const res = await bridge.call("upload_file", { tabId: args.tabId, selector: args.selector, filePaths: paths });
    return { content: [{ type: "text", text: res.text || "Uploaded large file(s)" }] };
  }

  const timeoutMs = Math.max(30000, (Number(args.timeoutMs) || 15000) + 10000);
  const res = await bridge.call(name, args, timeoutMs);

  if (res?.image?.base64) {
    let savedMsg = "";
    if (args.filePath) {
      const outPath = path.resolve(String(args.filePath));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, Buffer.from(res.image.base64, "base64"));
      savedMsg = ` (saved to ${outPath})`;
    }
    const content = [{ type: "text", text: (res.text || "Screenshot captured") + savedMsg }];
    if (!args.filePath) {
      content.push({
        type: "image",
        data: res.image.base64,
        mimeType: res.image.mimeType || "image/jpeg"
      });
    }
    return { content };
  }

  return {
    content: [{ type: "text", text: typeof res?.text === "string" ? res.text : JSON.stringify(res ?? {}, null, 2) }]
  };
}

// ---- MCP JSON-RPC Stdio Transport ----

export function handleJsonRpcMessage(bridge, msg) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;

  // Notifications have no id
  if (id === undefined || id === null) return null;

  return (async () => {
    try {
      switch (method) {
        case "initialize": {
          const requested = params?.protocolVersion;
          const protocolVersion = SUPPORTED_MCP_VERSIONS.includes(requested) ? requested : "2025-03-26";
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "chrome-use", version: "1.2.0" },
              instructions:
                "Control the user's live Chrome browser silently via ChromeUse (zero remote-debugging prompts). Prefer 'read_page' or 'find' + 'act' (with steps/returnSnapshot) for fast, low-token automation; use 'computer' for screenshots or pixel/canvas coordinates. Agent tabs are isolated in the 'AI Agent' tab group — ALWAYS close tabs you opened once done working (via 'tabs' action:'close' or action:'close_agent_tabs'). If you receive [USER_COMPLETED_AND_TAB_CLOSED] or [USER_INTERACTION_DETECTED], the user manually filled/submitted or updated the page — do NOT treat it as a crash, re-open closed tabs, or re-inject/re-submit already completed forms."
            }
          };
        }
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
        case "resources/list":
          return { jsonrpc: "2.0", id, result: { resources: [] } };
        case "prompts/list":
          return { jsonrpc: "2.0", id, result: { prompts: [] } };
        case "tools/call": {
          const toolName = params?.name;
          if (!TOOLS.some((t) => t.name === toolName)) {
            return {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: `Unknown tool: ${toolName}` }
            };
          }
          try {
            const callRes = await executeMcpTool(bridge, toolName, params?.arguments || {});
            return { jsonrpc: "2.0", id, result: callRes };
          } catch (toolErr) {
            return {
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [{ type: "text", text: `Error: ${toolErr?.message || toolErr}` }]
              }
            };
          }
        }
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` }
          };
      }
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: String(err?.message || err) }
      };
    }
  })();
}

async function runStdioServer() {
  const bridge = new ChromeUseBridge();
  await bridge.start();

  let buffer = Buffer.alloc(0);
  const writeMsg = (obj) => {
    if (!obj) return;
    process.stdout.write(JSON.stringify(obj) + "\n");
  };

  process.stdin.on("data", (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    let nl;
    while ((nl = buffer.indexOf(0x0a)) !== -1) {
      const line = buffer.toString("utf8", 0, nl).replace(/\r$/, "").trim();
      buffer = buffer.subarray(nl + 1);
      if (!line) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        writeMsg({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      const maybePromise = handleJsonRpcMessage(bridge, parsed);
      if (maybePromise) maybePromise.then(writeMsg);
    }
  });

  process.stdin.on("end", async () => {
    await bridge.close();
    process.exit(0);
  });
}

// ---- Chrome Native Messaging Host Mode (`node mcp-server.mjs --native-host`) ----

class NativeStdioConnection {
  constructor(inStream = process.stdin, outStream = process.stdout) {
    this.inStream = inStream;
    this.outStream = outStream;
    this.alive = true;
    this._buf = Buffer.alloc(0);
    this.onMessage = null;
    this.onClose = null;

    inStream.on("data", (chunk) => this._onData(chunk));
    inStream.on("end", () => this.close());
    inStream.on("close", () => this.close());
    inStream.on("error", () => this.close());
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    while (this.alive && this._buf.length >= 4) {
      const msgLen = this._buf.readUInt32LE(0);
      if (msgLen > MAX_WS_PAYLOAD) {
        this.close();
        return;
      }
      if (this._buf.length < 4 + msgLen) return;
      const jsonStr = this._buf.subarray(4, 4 + msgLen).toString("utf8");
      this._buf = this._buf.subarray(4 + msgLen);
      this.onMessage?.(jsonStr);
    }
  }

  sendJson(obj) {
    if (!this.alive) return;
    const payload = Buffer.from(JSON.stringify(obj), "utf8");
    const hdr = Buffer.alloc(4);
    hdr.writeUInt32LE(payload.length, 0);
    try {
      this.outStream.write(Buffer.concat([hdr, payload]));
    } catch {
      this.close();
    }
  }

  close() {
    if (!this.alive) return;
    this.alive = false;
    this.onClose?.();
  }
}

function connectWsToLeader(port, host) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, host);
    sock.setNoDelay(true);
    const onErr = (err) => reject(err);
    sock.once("error", onErr);
    sock.once("connect", () => {
      const wsKey = crypto.randomBytes(16).toString("base64");
      sock.write(
        [
          "GET /ext HTTP/1.1",
          `Host: ${host}:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Origin: chrome-extension://chromeusenativehost",
          `Sec-WebSocket-Key: ${wsKey}`,
          "Sec-WebSocket-Version: 13",
          "\r\n"
        ].join("\r\n")
      );
    });

    let hdrBuf = Buffer.alloc(0);
    const onUpgrade = (chunk) => {
      hdrBuf = Buffer.concat([hdrBuf, chunk]);
      const idx = hdrBuf.indexOf("\r\n\r\n");
      if (idx === -1) return;
      sock.off("data", onUpgrade);
      sock.off("error", onErr);
      const statusLine = hdrBuf.subarray(0, idx).toString("utf8");
      if (!statusLine.startsWith("HTTP/1.1 101")) {
        sock.destroy();
        reject(new Error(`Leader WS upgrade rejected: ${statusLine}`));
        return;
      }
      const leftover = hdrBuf.subarray(idx + 4);
      const conn = new WsConnection(sock, leftover);
      // Override client->server writes to be RFC 6455 masked frames
      conn.sendRawText = (str) => {
        if (!conn.alive) return;
        try {
          sock.write(maskClientFrame(0x1, Buffer.from(str, "utf8"), true));
        } catch {
          conn.close();
        }
      };
      resolve(conn);
    };
    sock.on("data", onUpgrade);
  });
}

async function runNativeHost() {
  const nativeConn = new NativeStdioConnection();
  const bridge = new ChromeUseBridge();
  let upstreamWs = null;
  const pendingOut = [];

  nativeConn.onMessage = (raw) => {
    if (upstreamWs?.alive) upstreamWs.sendRawText(raw);
    else pendingOut.push(raw);
  };

  nativeConn.onClose = async () => {
    if (upstreamWs) upstreamWs.close();
    await bridge.close();
    process.exit(0);
  };

  async function bindOrBridge() {
    if (!nativeConn.alive) return;
    const becameLeader = await bridge.start();
    if (becameLeader) {
      bridge._attachExtension(nativeConn);
      for (const raw of pendingOut.splice(0)) nativeConn.onMessage?.(raw);
      return;
    }
    try {
      const ws = await connectWsToLeader(bridge.port, bridge.host);
      upstreamWs = ws;
      nativeConn.onMessage = (raw) => {
        if (ws.alive) ws.sendRawText(raw);
        else pendingOut.push(raw);
      };
      ws.onMessage = (raw) => {
        try { nativeConn.sendJson(JSON.parse(raw)); } catch {}
      };
      for (const raw of pendingOut.splice(0)) ws.sendRawText(raw);
      ws.onClose = () => {
        if (upstreamWs === ws) upstreamWs = null;
        if (nativeConn.alive) setTimeout(bindOrBridge, 400);
      };
    } catch {
      if (nativeConn.alive) setTimeout(bindOrBridge, 600);
    }
  }

  await bindOrBridge();
}

// ---- Built-in Self-Test Tripwire (`node mcp-server.mjs --self-test`) ----

function maskClientFrame(opcode, payloadBuf, fin = true) {
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(payloadBuf);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  const b0 = (fin ? 0x80 : 0x00) | opcode;
  let hdr;
  if (masked.length < 126) {
    hdr = Buffer.from([b0, 0x80 | masked.length]);
  } else if (masked.length < 65536) {
    hdr = Buffer.alloc(4);
    hdr[0] = b0;
    hdr[1] = 0x80 | 126;
    hdr.writeUInt16BE(masked.length, 2);
  } else {
    hdr = Buffer.alloc(10);
    hdr[0] = b0;
    hdr[1] = 0x80 | 127;
    hdr.writeBigUInt64BE(BigInt(masked.length), 2);
  }
  return Buffer.concat([hdr, mask, masked]);
}

async function runSelfTest() {
  const testPort = 28971 + Math.floor(Math.random() * 1000);
  const token = "test-secret-" + crypto.randomBytes(16).toString("hex");
  const leader = new ChromeUseBridge({ port: testPort, token });
  const peer = new ChromeUseBridge({ port: testPort, token });

  try {
    const leaderOk = await leader.start();
    const peerOk = await peer.start();
    if (!leaderOk || peerOk) throw new Error(`Expected leader=true, peer=false; got ${leaderOk}, ${peerOk}`);

    // 1. Verify untrusted Origin is rejected on HTTP /rpc and WS /ext
    const evilRpc = await fetch(`http://127.0.0.1:${testPort}/rpc`, {
      method: "POST",
      headers: { Origin: "https://evil.example", "X-ChromeUse-Token": token },
      body: JSON.stringify({ cmd: "tabs" })
    });
    if (evilRpc.status !== 403) throw new Error(`Expected 403 for browser Origin on /rpc, got ${evilRpc.status}`);

    // 2. Connect simulated Chrome Extension client via raw TCP + RFC 6455 upgrade
    const sock = net.connect(testPort, "127.0.0.1");
    await new Promise((resolve, reject) => {
      sock.once("error", reject);
      sock.once("connect", () => {
        const wsKey = crypto.randomBytes(16).toString("base64");
        sock.write(
          [
            "GET /ext HTTP/1.1",
            `Host: 127.0.0.1:${testPort}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Origin: chrome-extension://chromeusetestid",
            `Sec-WebSocket-Key: ${wsKey}`,
            "Sec-WebSocket-Version: 13",
            "\r\n"
          ].join("\r\n")
        );
      });
      let resp = "";
      const onUpgradeData = (chunk) => {
        resp += chunk.toString("utf8");
        if (resp.includes("\r\n\r\n")) {
          sock.off("data", onUpgradeData);
          if (!resp.startsWith("HTTP/1.1 101")) reject(new Error(`WS upgrade failed: ${resp}`));
          else resolve();
        }
      };
      sock.on("data", onUpgradeData);
    });

    // Simple server->client unmasked frame reader for mock extension
    let extBuf = Buffer.alloc(0);
    sock.on("data", (c) => {
      extBuf = Buffer.concat([extBuf, c]);
      while (extBuf.length >= 2) {
        const op = extBuf[0] & 0x0f;
        let len = extBuf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (extBuf.length < 4) return; len = extBuf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (extBuf.length < 10) return; len = Number(extBuf.readBigUInt64BE(2)); off = 10; }
        if (extBuf.length < off + len) return;
        const payloadBuf = extBuf.subarray(off, off + len);
        extBuf = extBuf.subarray(off + len);
        if (op !== 0x1) continue; // skip pong control frames
        const msg = JSON.parse(payloadBuf.toString("utf8"));
        if (msg.cmd === "read_page") {
          // Send a 90KB fragmented response (>64KB) with an interleaved Ping frame to stress-test framing!
          const bigText = `[tab 1] Title: Test\n` + "A".repeat(90000);
          const replyBuf = Buffer.from(JSON.stringify({ id: msg.id, ok: true, result: { text: bigText } }), "utf8");
          const part1 = replyBuf.subarray(0, 70000); // >65535 triggers 64-bit length field
          const part2 = replyBuf.subarray(70000);
          sock.write(maskClientFrame(0x1, part1, false));
          sock.write(maskClientFrame(0x9, Buffer.from("hb"), true)); // interleaved ping
          sock.write(maskClientFrame(0x0, part2, true));
        } else if (msg.cmd === "computer") {
          const reply = JSON.stringify({
            id: msg.id,
            ok: true,
            result: {
              text: "Screenshot ok",
              image: { base64: Buffer.from("fakejpeg").toString("base64"), mimeType: "image/jpeg", width: 800, height: 600 }
            }
          });
          sock.write(maskClientFrame(0x1, Buffer.from(reply, "utf8"), true));
        }
      }
    });

    // 3. Test MCP initialize + tools/list + fragmented >64KB read_page + peer-relayed screenshot
    const initRes = await handleJsonRpcMessage(leader, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" }
    });
    if (initRes.result.serverInfo.name !== "chrome-use") throw new Error("Bad initialize response");
    if (!initRes.result.instructions.includes("close_agent_tabs") || !initRes.result.instructions.includes("USER_COMPLETED_AND_TAB_CLOSED")) {
      throw new Error("Missing tab-cleanup or human-activity instructions in initialize");
    }

    const listRes = await handleJsonRpcMessage(leader, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    if (listRes.result.tools.length !== 13) throw new Error(`Expected 13 tools, got ${listRes.result.tools.length}`);
    const checkSchema = (node, loc) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node.type)) throw new Error(`Union type array not allowed at ${loc}`);
      if (node.type === "array" && (!node.items || typeof node.items.type !== "string")) {
        throw new Error(`Array items missing scalar type at ${loc}`);
      }
      if (node.properties) {
        for (const [k, v] of Object.entries(node.properties)) checkSchema(v, `${loc}.${k}`);
      }
      if (node.items) checkSchema(node.items, `${loc}[]`);
    };
    for (const t of listRes.result.tools) checkSchema(t.inputSchema, t.name);

    const readRes = await handleJsonRpcMessage(leader, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "read_page", arguments: {} }
    });
    if (!readRes.result.content[0].text.endsWith("A".repeat(100))) {
      throw new Error("Fragmented >64KB WS frame reassembly failed");
    }

    // Call through Peer Relay instance!
    const peerShot = await handleJsonRpcMessage(peer, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "computer", arguments: { action: "screenshot" } }
    });
    if (peerShot.result.content[1]?.type !== "image") {
      throw new Error("Peer-relayed screenshot missing MCP image block");
    }

    // 4. Test Chrome Native Messaging 4-byte LE framing + --native-host bridge relay
    const { PassThrough } = await import("node:stream");
    const mockIn = new PassThrough();
    const mockOut = new PassThrough();
    const nativeTest = new NativeStdioConnection(mockIn, mockOut);
    const receivedNative = [];
    nativeTest.onMessage = (s) => receivedNative.push(JSON.parse(s));
    const samplePayload = Buffer.from(JSON.stringify({ id: 99, ok: true, result: { text: "native-ok" } }), "utf8");
    const sampleHdr = Buffer.alloc(4);
    sampleHdr.writeUInt32LE(samplePayload.length, 0);
    mockIn.write(sampleHdr.subarray(0, 2)); // split across chunks to verify stream framing
    mockIn.write(Buffer.concat([sampleHdr.subarray(2), samplePayload]));
    if (receivedNative[0]?.result?.text !== "native-ok") {
      throw new Error("NativeStdioConnection 4-byte LE framing check failed");
    }

    sock.destroy();
    console.log("self-test ok: Native Messaging LE32, WS RFC6455 (>64KB + fragmentation + ping), Origin guard, Peer Relay, and 13 MCP tools verified.");
  } finally {
    await peer.close();
    await leader.close();
  }
}

async function installNativeHost() {
  const { execFileSync } = await import("node:child_process");
  const rootDir = import.meta.dirname;
  const extDirLower = path.join(rootDir, "extension").toLowerCase();
  const argId = process.argv.find((a) => a.startsWith("--ext-id="))?.split("=")[1]?.trim();
  const foundIds = new Set(argId ? [argId] : []);

  // Auto-discover loaded ChromeUse unpacked extension ID across local Chrome profiles
  const chromeBase =
    process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data")
      : process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome")
        : path.join(os.homedir(), ".config", "google-chrome");

  if (fs.existsSync(chromeBase)) {
    for (const entry of fs.readdirSync(chromeBase)) {
      for (const pref of ["Secure Preferences", "Preferences"]) {
        const p = path.join(chromeBase, entry, pref);
        if (!fs.existsSync(p)) continue;
        try {
          const settings = JSON.parse(fs.readFileSync(p, "utf8"))?.extensions?.settings || {};
          for (const [id, info] of Object.entries(settings)) {
            const pLower = String(info?.path || "").toLowerCase();
            if (pLower === extDirLower || info?.manifest?.name === "ChromeUse") foundIds.add(id);
          }
        } catch {}
      }
    }
  }

  if (!foundIds.size) {
    throw new Error(
      `Could not auto-detect ChromeUse Extension ID. Load '${path.join(rootDir, "extension")}' at chrome://extensions first, or pass --ext-id=<32-char-id>.`
    );
  }

  const serverScript = path.join(rootDir, "mcp-server.mjs");
  let launcherPath;
  if (process.platform === "win32") {
    launcherPath = path.join(rootDir, "native-host.cmd");
    fs.writeFileSync(launcherPath, `@echo off\r\n"${process.execPath}" "${serverScript}" --native-host\r\n`);
  } else {
    launcherPath = path.join(rootDir, "native-host.sh");
    fs.writeFileSync(launcherPath, `#!/usr/bin/env sh\nexec "${process.execPath}" "${serverScript}" --native-host\n`, { mode: 0o755 });
  }

  const manifest = {
    name: "com.chromeuse.bridge",
    description: "ChromeUse Universal MCP Native Messaging Bridge",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [...foundIds].map((id) => `chrome-extension://${id}/`)
  };

  if (process.platform === "win32") {
    const manifestPath = path.join(rootDir, "native-host.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    execFileSync("reg.exe", [
      "add",
      "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.chromeuse.bridge",
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      manifestPath,
      "/f"
    ]);
    console.log(`Registered ChromeUse Native Host -> ${manifestPath} (IDs: ${[...foundIds].join(", ")})`);
  } else {
    const targetDir =
      process.platform === "darwin"
        ? path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
        : path.join(os.homedir(), ".config", "google-chrome", "NativeMessagingHosts");
    fs.mkdirSync(targetDir, { recursive: true });
    const manifestPath = path.join(targetDir, "com.chromeuse.bridge.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Registered ChromeUse Native Host -> ${manifestPath} (IDs: ${[...foundIds].join(", ")})`);
  }
}

if (process.argv.includes("--self-test")) {
  runSelfTest().catch((err) => {
    console.error("self-test FAILED:", err);
    process.exit(1);
  });
} else if (process.argv.includes("--install")) {
  installNativeHost().catch((err) => {
    console.error("Install failed:", err.message || err);
    process.exit(1);
  });
} else if (process.argv.includes("--native-host")) {
  runNativeHost();
} else {
  runStdioServer();
}
