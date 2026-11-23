// ChromeUse MV3 Background Service Worker
// Connects via Chrome Native Messaging ("com.chromeuse.bridge") — zero TCP/WebSocket calls in Chrome,
// so net::ERR_CONNECTION_REFUSED can never occur even when the IDE/MCP client is closed.

const NATIVE_HOST = "com.chromeuse.bridge";
const MAX_RING = 200; // mytail: 200 network entries per tab ring buffer; raise if profiling heavy SPAs.

let nativePort = null;
let paused = false;
let reconnectTimer = null;

// tabId -> Array<{ id, method, url, type, status, durationMs, error, ts }>
const netLogs = new Map();
const pendingReq = new Map(); // requestId -> entry

async function loadState() {
  try {
    const stored = await chrome.storage.local.get(["paused"]);
    paused = Boolean(stored.paused);
  } catch {
    paused = false;
  }
  updateBadge();
}

function updateBadge() {
  if (paused) {
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#D97706" });
    chrome.action.setTitle({ title: "ChromeUse: PAUSED (click to resume)" });
  } else if (nativePort) {
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#16A34A" });
    chrome.action.setTitle({ title: "ChromeUse: Ready (click to pause)" });
  } else {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: "ChromeUse: Standby (click to pause)" });
  }
}

async function ensureOffscreen() {
  try {
    if (chrome.offscreen.hasDocument && (await chrome.offscreen.hasDocument())) return;
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "On-demand screenshot canvas cropping and compression"
    });
  } catch (err) {
    if (!String(err?.message || err).includes("Only a single offscreen")) {
      // ignore race if already created
    }
  }
}

function scheduleReconnect(delay = 2500) {
  if (paused || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBridge();
  }, delay);
}

function connectBridge() {
  if (paused || nativePort) return;
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    updateBadge();

    port.postMessage({
      type: "hello",
      extensionVersion: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent
    });

    port.onMessage.addListener(async (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ping") {
        try { port.postMessage({ type: "pong", ts: Date.now() }); } catch {}
        return;
      }
      if (msg.id !== undefined && msg.cmd) {
        try {
          if (paused) throw new Error("ChromeUse is paused by user (click the ChromeUse toolbar icon in Chrome to resume).");
          const result = await handleCommand(msg.cmd, msg.params || {});
          if (nativePort === port) port.postMessage({ id: msg.id, ok: true, result });
        } catch (err) {
          if (nativePort === port) port.postMessage({ id: msg.id, ok: false, error: String(err?.message || err) });
        }
      }
    });

    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // consume lastError so Chrome never logs an unchecked error
      if (nativePort === port) nativePort = null;
      updateBadge();
      if (!paused) scheduleReconnect(2500);
    });
  } catch {
    nativePort = null;
    updateBadge();
    scheduleReconnect(3000);
  }
}

function disconnectBridge() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (nativePort) {
    try { nativePort.disconnect(); } catch {}
    nativePort = null;
  }
  updateBadge();
}

// Headless single-click toggle on toolbar icon
chrome.action.onClicked.addListener(async () => {
  paused = !paused;
  await chrome.storage.local.set({ paused });
  if (paused) {
    disconnectBridge();
  } else {
    updateBadge();
    connectBridge();
  }
});

chrome.alarms.create("cext_heartbeat", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "cext_heartbeat" && !paused && !nativePort) {
    connectBridge();
  }
});

// Passive, zero-footprint network tracking per tab
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || details.url.startsWith("chrome-extension://")) return;
    const entry = {
      id: details.requestId,
      method: details.method,
      url: details.url,
      type: details.type,
      status: "pending",
      durationMs: null,
      error: null,
      ts: Math.round(details.timeStamp),
      _start: details.timeStamp
    };
    pendingReq.set(details.requestId, entry);
    let list = netLogs.get(details.tabId);
    if (!list) {
      list = [];
      netLogs.set(details.tabId, list);
    }
    list.push(entry);
    if (list.length > MAX_RING) list.shift();
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    const entry = pendingReq.get(details.requestId);
    if (!entry) return;
    pendingReq.delete(details.requestId);
    entry.status = details.statusCode;
    entry.durationMs = Math.max(0, Math.round(details.timeStamp - entry._start));
    delete entry._start;
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    const entry = pendingReq.get(details.requestId);
    if (!entry) return;
    pendingReq.delete(details.requestId);
    entry.status = "ERR";
    entry.error = details.error || "Network error";
    entry.durationMs = Math.max(0, Math.round(details.timeStamp - entry._start));
    delete entry._start;
  },
  { urls: ["<all_urls>"] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  netLogs.delete(tabId);
});

// ---- Helpers for Tab & Script Execution ----

function isRestrictedUrl(url = "") {
  return (
    !url ||
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("devtools://") ||
    url.startsWith("view-source:") ||
    url.startsWith("https://chromewebstore.google.com") ||
    url.startsWith("https://chrome.google.com/webstore")
  );
}

async function resolveTab(tabId, { allowCreate = false } = {}) {
  if (tabId !== undefined && tabId !== null) {
    const t = await chrome.tabs.get(Number(tabId));
    if (!t) throw new Error(`Tab ${tabId} not found`);
    return t;
  }
  const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const normal = focused.find((t) => !t.url?.startsWith("devtools://"));
  if (normal) return normal;

  const anyActive = await chrome.tabs.query({ active: true });
  if (anyActive.length > 0) return anyActive[0];

  const all = await chrome.tabs.query({});
  if (all.length > 0) return all[0];

  if (allowCreate) {
    return await chrome.tabs.create({ url: "about:blank", active: true });
  }
  throw new Error("No open Chrome tabs found. Use navigate with newTab:true or tabs action:'new'.");
}

function parseFrameFromRef(ref) {
  if (!ref) return 0;
  const s = String(ref).trim().replace(/^ref_/, "");
  const m = /^f(\d+)_/.exec(s);
  return m ? Number(m[1]) : 0;
}

async function ensureDomAgent(tabId, frameId = 0) {
  const check = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "ISOLATED",
    func: () => Boolean(globalThis.__cext && globalThis.__cext.version === 1)
  });
  if (!check?.[0]?.result) {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: "ISOLATED",
      files: ["dom-agent.js"]
    });
  }
}

async function runDomAgent(tabId, method, params = {}, frameId = 0) {
  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab.url)) {
    throw new Error(
      `Tab ${tabId} is on restricted browser URL "${tab.url}". Use 'navigate' to load an http(s) page or switch tabs via 'tabs'.`
    );
  }
  await ensureDomAgent(tabId, frameId);
  const injected = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: "ISOLATED",
    func: async (m, p) => {
      try {
        return { ok: true, value: await globalThis.__cext.dispatch(m, p) };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    },
    args: [method, params]
  });
  const res = injected?.[0]?.result;
  if (!res) throw new Error(`Script execution returned no result on tab ${tabId}`);
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

async function ensureConsoleHook(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "MAIN",
      func: () => {
        if (window.__cextConsoleHooked) return;
        window.__cextConsoleHooked = true;
        const buf = (window.__cextConsoleBuf = []);
        const push = (level, args) => {
          const text = args
            .map((a) => {
              if (typeof a === "string") return a;
              if (a instanceof Error) return a.stack || a.message;
              try { return JSON.stringify(a); } catch { return String(a); }
            })
            .join(" ");
          buf.push({ level, text: text.slice(0, 2000), ts: Date.now() });
          if (buf.length > 200) buf.shift();
        };
        for (const lvl of ["log", "info", "warn", "error"]) {
          const orig = console[lvl]?.bind(console);
          if (!orig) continue;
          console[lvl] = (...args) => {
            try { push(lvl, args); } catch {}
            return orig(...args);
          };
        }
        window.addEventListener("error", (e) => push("pageerror", [e.error || e.message || "Error"]));
        window.addEventListener("unhandledrejection", (e) => push("unhandledrejection", [e.reason || "Unhandled rejection"]));
      }
    });
  } catch {
    // Ignore on restricted pages
  }
}

async function waitForTabLoad(tabId, waitUntil = "load", timeoutMs = 15000) {
  if (waitUntil === "none") return;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === "complete") return;
    if (waitUntil === "domcontentloaded" && t.status === "complete") return;
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function withDebugger(tabId, fn) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    return await fn((method, commandParams = {}) => chrome.debugger.sendCommand(target, method, commandParams));
  } finally {
    try { await chrome.debugger.detach(target); } catch {}
  }
}

// ---- Command Router ----

async function handleCommand(cmd, params) {
  switch (cmd) {
    case "tabs":
      return await cmdTabs(params);
    case "navigate":
      return await cmdNavigate(params);
    case "read_page":
      return await cmdReadPage(params);
    case "find":
      return await cmdFind(params);
    case "act": {
      const tab = await resolveTab(params.tabId);
      await ensureConsoleHook(tab.id);
      const firstRef = params.ref ?? params.steps?.[0]?.ref;
      const frameId = parseFrameFromRef(firstRef);
      return await runDomAgent(tab.id, "act", params, frameId);
    }
    case "form_input": {
      const tab = await resolveTab(params.tabId);
      await ensureConsoleHook(tab.id);
      const firstRef = params.fields?.[0]?.ref;
      const frameId = parseFrameFromRef(firstRef);
      return await runDomAgent(tab.id, "form_input", params, frameId);
    }
    case "wait_for": {
      const tab = await resolveTab(params.tabId);
      if (params.loadComplete) {
        await waitForTabLoad(tab.id, "load", params.timeoutMs || 15000);
        return { text: `Tab ${tab.id} load complete (${tab.url})` };
      }
      return await runDomAgent(tab.id, "wait_for", params, 0);
    }
    case "computer":
      return await cmdComputer(params);
    case "evaluate":
      return await cmdEvaluate(params);
    case "console_logs":
      return await cmdConsoleLogs(params);
    case "network_requests":
      return await cmdNetworkRequests(params);
    case "cookies":
      return await cmdCookies(params);
    case "upload_file":
      return await cmdUploadFile(params);
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

async function cmdTabs({ action = "list", tabId, url = "about:blank", active = true, tabIds, groupTitle } = {}) {
  switch (action) {
    case "list": {
      const all = await chrome.tabs.query({});
      const focusedWin = await chrome.windows.getLastFocused().catch(() => null);
      const lines = all.map((t) => {
        const isCurrent = t.active && (!focusedWin || t.windowId === focusedWin.id);
        return `${isCurrent ? "* " : "  "}[tab ${t.id}] (win ${t.windowId}${t.pinned ? ", pinned" : ""}${t.audible ? ", audible" : ""}) "${t.title || ""}" — ${t.url || ""}`;
      });
      return {
        tabs: all.map((t) => ({ id: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url, status: t.status })),
        text: `Open tabs (${all.length}):\n${lines.join("\n")}`
      };
    }
    case "new": {
      const created = await chrome.tabs.create({ url, active });
      if (url && url !== "about:blank") await waitForTabLoad(created.id, "load", 12000);
      const updated = await chrome.tabs.get(created.id);
      return { tabId: updated.id, text: `Opened [tab ${updated.id}] "${updated.title || ""}" — ${updated.url}` };
    }
    case "activate": {
      const t = await resolveTab(tabId);
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      return { tabId: t.id, text: `Activated [tab ${t.id}] "${t.title || ""}" — ${t.url}` };
    }
    case "close": {
      const ids = Array.isArray(tabIds) && tabIds.length ? tabIds.map(Number) : [(await resolveTab(tabId)).id];
      await chrome.tabs.remove(ids);
      return { text: `Closed tab(s): ${ids.join(", ")}` };
    }
    case "reload": {
      const t = await resolveTab(tabId);
      await chrome.tabs.reload(t.id);
      await waitForTabLoad(t.id, "load", 15000);
      return { text: `Reloaded [tab ${t.id}] — ${t.url}` };
    }
    case "back": {
      const t = await resolveTab(tabId);
      await chrome.tabs.goBack(t.id);
      await waitForTabLoad(t.id, "load", 10000);
      const after = await chrome.tabs.get(t.id);
      return { text: `Navigated back in [tab ${t.id}] -> ${after.url}` };
    }
    case "forward": {
      const t = await resolveTab(tabId);
      await chrome.tabs.goForward(t.id);
      await waitForTabLoad(t.id, "load", 10000);
      const after = await chrome.tabs.get(t.id);
      return { text: `Navigated forward in [tab ${t.id}] -> ${after.url}` };
    }
    case "group": {
      const ids = Array.isArray(tabIds) && tabIds.length ? tabIds.map(Number) : [(await resolveTab(tabId)).id];
      const groupId = await chrome.tabs.group({ tabIds: ids });
      if (groupTitle && chrome.tabGroups?.update) {
        await chrome.tabGroups.update(groupId, { title: groupTitle }).catch(() => {});
      }
      return { text: `Grouped tabs [${ids.join(", ")}]${groupTitle ? ` under "${groupTitle}"` : ""}` };
    }
    default:
      throw new Error(`Unsupported tabs action: ${action}`);
  }
}

async function cmdNavigate({ url, tabId, newTab = false, waitUntil = "load", timeoutMs = 15000, includeSnapshot = true } = {}) {
  if (!url) throw new Error("url is required");
  const normalizedUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `https://${url}`;

  let tab;
  if (newTab) {
    tab = await chrome.tabs.create({ url: normalizedUrl, active: true });
  } else {
    tab = await resolveTab(tabId, { allowCreate: true });
    tab = await chrome.tabs.update(tab.id, { url: normalizedUrl });
  }

  await waitForTabLoad(tab.id, waitUntil, timeoutMs);
  const finalTab = await chrome.tabs.get(tab.id);
  await ensureConsoleHook(finalTab.id);

  let snap = "";
  if (includeSnapshot && !isRestrictedUrl(finalTab.url)) {
    try {
      const page = await cmdReadPage({ tabId: finalTab.id, mode: "interactive", maxChars: 16000 });
      snap = `\n\n${page.text}`;
    } catch {
      // Page might still be redirecting
    }
  }
  return {
    tabId: finalTab.id,
    text: `Navigated [tab ${finalTab.id}] to ${finalTab.url}${snap}`
  };
}

async function cmdReadPage(params = {}) {
  const tab = await resolveTab(params.tabId);
  await ensureConsoleHook(tab.id);
  const topRes = await runDomAgent(tab.id, "read_page", params, 0);
  let combined = `[tab ${tab.id}] ${topRes.text}`;

  // Automatically inspect visible cross-origin iframes if present and not scoped to a specific ref
  if (topRes.crossOriginFrames?.length > 0 && !params.rootRef && !params.selector && params.mode !== "markdown") {
    try {
      const frames = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        world: "ISOLATED",
        func: () => (window === window.top ? null : location.href)
      });
      for (const f of frames || []) {
        if (!f.frameId || !f.result || f.result === "about:blank") continue;
        try {
          const sub = await runDomAgent(
            tab.id,
            "read_page",
            { ...params, maxChars: 4000, framePrefix: `f${f.frameId}_` },
            f.frameId
          );
          if (sub?.text) combined += `\n\n${sub.text}`;
        } catch { /* subframe restricted */ }
      }
    } catch { /* ignore */ }
  }

  return { text: combined };
}

async function cmdFind(params = {}) {
  const tab = await resolveTab(params.tabId);
  const top = await runDomAgent(tab.id, "find", params, 0);
  return { text: `[tab ${tab.id}] ${top.text}` };
}

async function cmdComputer(params = {}) {
  const { action = "screenshot" } = params;
  const tab = await resolveTab(params.tabId);

  if (action === "screenshot") {
    await ensureOffscreen();
    if (!tab.active) {
      await chrome.tabs.update(tab.id, { active: true });
      await new Promise((r) => setTimeout(r, 120));
    }

    let crop = params.region || null;
    let dpr = 1;
    let viewportWidth = tab.width || 1280;
    let viewportHeight = tab.height || 720;

    if (!isRestrictedUrl(tab.url)) {
      try {
        if (params.ref || params.selector) {
          const frameId = parseFrameFromRef(params.ref);
          const bbox = await runDomAgent(tab.id, "get_bbox", { ref: params.ref, selector: params.selector }, frameId);
          crop = { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
          dpr = bbox.dpr || 1;
          viewportWidth = bbox.viewportWidth || viewportWidth;
          viewportHeight = bbox.viewportHeight || viewportHeight;
        } else {
          const vp = await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [0] },
            world: "ISOLATED",
            func: () => ({ dpr: window.devicePixelRatio || 1, w: window.innerWidth, h: window.innerHeight })
          });
          if (vp?.[0]?.result) {
            dpr = vp[0].result.dpr;
            viewportWidth = vp[0].result.w;
            viewportHeight = vp[0].result.h;
          }
        }
      } catch { /* fallback to raw tab dimensions */ }
    }

    const rawDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
    const format = params.format || "jpeg";
    const quality = typeof params.quality === "number" ? Math.max(0.1, Math.min(1, params.quality / 100)) : 0.82;
    const processed = await chrome.runtime.sendMessage({
      type: "cext_process_image",
      dataUrl: rawDataUrl,
      crop,
      maxWidth: params.maxWidth ?? 1280,
      format,
      quality,
      dpr
    });

    if (!processed?.ok) {
      throw new Error(processed?.error || "Image processing failed");
    }

    return {
      image: {
        base64: processed.base64,
        mimeType: processed.mimeType,
        width: processed.width,
        height: processed.height
      },
      viewport: { width: viewportWidth, height: viewportHeight },
      text: `Screenshot of [tab ${tab.id}] "${tab.title || ""}" (${processed.width}x${processed.height} image, CSS viewport ${viewportWidth}x${viewportHeight})`
    };
  }

  if (action === "handle_dialog") {
    return await withDebugger(tab.id, async (cdp) => {
      await cdp("Page.enable");
      await cdp("Page.handleJavaScriptDialog", {
        accept: params.accept !== false,
        promptText: params.promptText
      });
      return { text: `Handled JavaScript dialog (accept=${params.accept !== false})` };
    });
  }

  // Drag or explicit trusted OS-level CDP input (for Canvas / WebGL / cross-origin widgets)
  if (action === "drag" || params.trusted) {
    return await withDebugger(tab.id, async (cdp) => {
      const x = Number(params.x ?? params.startX ?? 0);
      const y = Number(params.y ?? params.startY ?? 0);
      if (action === "drag") {
        const endX = Number(params.endX ?? x);
        const endY = Number(params.endY ?? y);
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        const steps = 8;
        for (let i = 1; i <= steps; i++) {
          await cdp("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: Math.round(x + ((endX - x) * i) / steps),
            y: Math.round(y + ((endY - y) * i) / steps),
            button: "left",
            buttons: 1
          });
        }
        await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: endX, y: endY, button: "left", clickCount: 1 });
        return { text: `Dragged (${x},${y}) -> (${endX},${endY})` };
      }

      const btn = action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
      const clicks = action === "double_click" ? 2 : 1;
      await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      if (action !== "hover") {
        for (let c = 1; c <= clicks; c++) {
          await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: btn, clickCount: c });
          await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: btn, clickCount: c });
        }
      }
      return { text: `Trusted ${action} at (${x}, ${y})` };
    });
  }

  // Silent DOM coordinate dispatch (zero debugger banner)
  const mappedAction = action === "left_click" ? "click" : action;
  return await runDomAgent(tab.id, "act", {
    action: mappedAction,
    x: params.x,
    y: params.y,
    direction: params.direction,
    amount: params.amount,
    key: params.key,
    value: params.text ?? params.value
  });
}

async function cmdEvaluate({ expression, args = [], tabId, world = "MAIN" } = {}) {
  if (!expression) throw new Error("expression is required");
  const tab = await resolveTab(tabId);
  if (isRestrictedUrl(tab.url)) {
    throw new Error(`Cannot evaluate JS on restricted URL "${tab.url}"`);
  }

  const execWorld = String(world).toUpperCase() === "ISOLATED" ? "ISOLATED" : "MAIN";
  const injected = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    world: execWorld,
    func: async (code, passedArgs) => {
      try {
        const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
        let fn;
        try {
          fn = new AsyncFn("...args", `return (${code});`);
        } catch {
          fn = new AsyncFn("...args", code);
        }
        const val = await fn(...passedArgs);
        return { ok: true, value: val === undefined ? "undefined" : val };
      } catch (e) {
        return { ok: false, isCspEval: e instanceof EvalError, error: String(e?.stack || e?.message || e) };
      }
    },
    args: [expression, Array.isArray(args) ? args : [args]]
  });

  const res = injected?.[0]?.result;
  if (res?.ok) {
    const formatted = typeof res.value === "string" ? res.value : JSON.stringify(res.value, null, 2);
    return { value: res.value, text: formatted ?? "null" };
  }

  // Automatic fallback for strict-CSP sites (e.g. GitHub) that disallow unsafe-eval in MAIN world
  if (res?.isCspEval && execWorld === "MAIN") {
    return await withDebugger(tab.id, async (cdp) => {
      const serializedArgs = JSON.stringify(Array.isArray(args) ? args : [args]);
      const wrapped = `(async (...args) => { return (${expression}); })(...${serializedArgs})`;
      const evalRes = await cdp("Runtime.evaluate", {
        expression: wrapped,
        awaitPromise: true,
        returnByValue: true
      });
      if (evalRes?.exceptionDetails) {
        throw new Error(evalRes.exceptionDetails.exception?.description || evalRes.exceptionDetails.text || "Evaluation failed");
      }
      const val = evalRes?.result?.value;
      return { value: val, text: typeof val === "string" ? val : JSON.stringify(val, null, 2) ?? String(evalRes?.result?.description || "undefined") };
    });
  }

  throw new Error(res?.error || "Evaluation failed");
}

async function cmdConsoleLogs({ tabId, level, search, clear = false, limit = 100 } = {}) {
  const tab = await resolveTab(tabId);
  if (isRestrictedUrl(tab.url)) return { text: `Restricted tab ${tab.id} (${tab.url}) — no console logs.` };
  await ensureConsoleHook(tab.id);

  const injected = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    func: (shouldClear) => {
      const logs = Array.isArray(window.__cextConsoleBuf) ? [...window.__cextConsoleBuf] : [];
      if (shouldClear && Array.isArray(window.__cextConsoleBuf)) window.__cextConsoleBuf.length = 0;
      return logs;
    },
    args: [Boolean(clear)]
  });

  let logs = injected?.[0]?.result || [];
  if (level) logs = logs.filter((l) => l.level === level);
  if (search) {
    const needle = String(search).toLowerCase();
    logs = logs.filter((l) => l.text.toLowerCase().includes(needle));
  }
  logs = logs.slice(-limit);
  if (!logs.length) return { text: `No captured console messages on [tab ${tab.id}] (note: console hook records from first agent interaction on this tab).` };
  return {
    text: logs.map((l) => `[${new Date(l.ts).toISOString().slice(11, 23)}] [${l.level.toUpperCase()}] ${l.text}`).join("\n")
  };
}

async function cmdNetworkRequests({ tabId, urlFilter, method, status, resourceType, clear = false, limit = 80 } = {}) {
  const tab = await resolveTab(tabId);
  let entries = [...(netLogs.get(tab.id) || [])];
  if (clear) netLogs.set(tab.id, []);

  if (urlFilter) {
    const q = String(urlFilter).toLowerCase();
    entries = entries.filter((e) => e.url.toLowerCase().includes(q));
  }
  if (method) {
    const m = String(method).toUpperCase();
    entries = entries.filter((e) => e.method === m);
  }
  if (status !== undefined) {
    entries = entries.filter((e) => String(e.status) === String(status));
  }
  if (resourceType) {
    const rt = String(resourceType).toLowerCase();
    entries = entries.filter((e) => e.type.toLowerCase() === rt);
  }
  entries = entries.slice(-limit);
  if (!entries.length) return { text: `No matching network requests recorded for [tab ${tab.id}].` };

  const lines = entries.map(
    (e) => `${e.method.padEnd(6)} ${String(e.status).padEnd(4)} [${e.type}] ${e.durationMs !== null ? `${e.durationMs}ms` : "..."} ${e.url}${e.error ? ` (${e.error})` : ""}`
  );
  return { text: `Network requests for [tab ${tab.id}] (${entries.length}):\n${lines.join("\n")}` };
}

async function cmdCookies({ action = "list", url, domain, name, value, path = "/", secure, httpOnly, sameSite, expirationDate, tabId } = {}) {
  let targetUrl = url;
  if (!targetUrl && !domain) {
    const tab = await resolveTab(tabId);
    targetUrl = tab.url;
  }

  switch (action) {
    case "list": {
      const query = {};
      if (targetUrl && targetUrl.startsWith("http")) query.url = targetUrl;
      if (domain) query.domain = domain;
      if (name) query.name = name;
      const list = await chrome.cookies.getAll(query);
      if (!list.length) return { cookies: [], text: "No matching cookies found." };
      const summary = list.map(
        (c) => `${c.name}=${c.value.slice(0, 80)}${c.value.length > 80 ? "…" : ""} (domain=${c.domain}, path=${c.path}, httpOnly=${c.httpOnly}, secure=${c.secure})`
      );
      return { cookies: list, text: `Cookies (${list.length}):\n${summary.join("\n")}` };
    }
    case "get": {
      if (!name || !targetUrl) throw new Error("cookies 'get' requires name and url (or an active http tab)");
      const cookie = await chrome.cookies.get({ url: targetUrl, name });
      return { cookie, text: cookie ? JSON.stringify(cookie, null, 2) : `Cookie "${name}" not found for ${targetUrl}` };
    }
    case "set": {
      if (!name || !targetUrl) throw new Error("cookies 'set' requires name and url");
      const setDetails = { url: targetUrl, name, value: value ?? "", path };
      if (domain) setDetails.domain = domain;
      if (secure !== undefined) setDetails.secure = Boolean(secure);
      if (httpOnly !== undefined) setDetails.httpOnly = Boolean(httpOnly);
      if (sameSite) setDetails.sameSite = sameSite;
      if (expirationDate) setDetails.expirationDate = Number(expirationDate);
      const saved = await chrome.cookies.set(setDetails);
      return { cookie: saved, text: `Set cookie "${name}" on ${targetUrl}` };
    }
    case "delete": {
      if (!name || !targetUrl) throw new Error("cookies 'delete' requires name and url");
      await chrome.cookies.remove({ url: targetUrl, name });
      return { text: `Deleted cookie "${name}" from ${targetUrl}` };
    }
    default:
      throw new Error(`Unsupported cookies action: ${action}`);
  }
}

async function cmdUploadFile({ tabId, ref, selector, files = [], filePaths = [] } = {}) {
  const tab = await resolveTab(tabId);
  if (files.length > 0) {
    const frameId = parseFrameFromRef(ref);
    return await runDomAgent(tab.id, "set_files", { ref, selector, files }, frameId);
  }
  if (filePaths.length > 0) {
    // Large local file fallback via CDP DOM.setFileInputFiles
    return await withDebugger(tab.id, async (cdp) => {
      const { root } = await cdp("DOM.getDocument", { depth: 1 });
      if (!selector) throw new Error("selector is required when uploading large files via CDP path mode");
      const { nodeId } = await cdp("DOM.querySelector", { nodeId: root.nodeId, selector });
      if (!nodeId) throw new Error(`No element matched selector: ${selector}`);
      await cdp("DOM.setFileInputFiles", { nodeId, files: filePaths });
      return { text: `Uploaded ${filePaths.length} file(s) via CDP to ${selector}` };
    });
  }
  throw new Error("No files provided to upload_file");
}

// Startup initialization
(async () => {
  await loadState();
  if (!paused) connectBridge();
})();
