// Injected on-demand into Chrome's ISOLATED world (never touches page's MAIN window globals or mutates DOM attributes on read).
(() => {
  if (globalThis.__cext && globalThis.__cext.version === 1) return;

  const refMap = new Map(); // key -> { weak: WeakRef<Element>, selector, tag, role, name, bbox }
  const elemToRef = new WeakMap();
  let nextId = 1;

  const INTERACTIVE_TAGS = new Set(["a", "button", "input", "textarea", "select", "summary", "details", "option"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "combobox", "listbox", "option", "checkbox",
    "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "slider", "spinbutton", "treeitem"
  ]);
  const LANDMARK_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "main", "nav", "header", "footer", "form", "dialog", "section", "article", "table", "th", "label"]);
  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "meta", "link", "head", "svg", "path"]);

  function normRef(raw) {
    if (raw === undefined || raw === null) return "";
    const s = String(raw).trim();
    return s.startsWith("ref_") ? s.slice(4) : s;
  }

  function cssPath(el) {
    // mytail: capped at 5 ancestor hops for O(1) selector generation; falls back to role+name scan if layout shifts deeply.
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 5; depth++) {
      const tag = cur.tagName.toLowerCase();
      if (cur.id && /^[a-zA-Z][\w:-]*$/.test(cur.id)) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      let nth = 1;
      let sib = cur.previousElementSibling;
      while (sib) {
        if (sib.tagName === cur.tagName) nth++;
        sib = sib.previousElementSibling;
      }
      parts.unshift(`${tag}:nth-of-type(${nth})`);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function getRole(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit.trim().split(/\s+/)[0].toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && el.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "summary") return "button";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "search") return "searchbox";
      if (t === "range") return "slider";
      return `input[${t}]`;
    }
    if (el.isContentEditable) return "textbox";
    return tag;
  }

  function cleanText(s, max = 120) {
    if (!s) return "";
    const compact = String(s).replace(/\s+/g, " ").trim();
    return compact.length > max ? compact.slice(0, max - 1) + "…" : compact;
  }

  function getAccessibleName(el) {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel) return cleanText(ariaLabel);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const doc = el.ownerDocument || document;
      const joined = labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.innerText || "")
        .filter(Boolean)
        .join(" ");
      if (joined) return cleanText(joined);
    }
    if (el.id) {
      const doc = el.ownerDocument || document;
      const lbl = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return cleanText(lbl.innerText || lbl.textContent);
    }
    const parentLabel = el.closest("label");
    if (parentLabel) {
      const clone = parentLabel.cloneNode(true);
      clone.querySelectorAll("input,select,textarea,button").forEach((n) => n.remove());
      const t = cleanText(clone.textContent);
      if (t) return t;
    }
    const placeholder = el.getAttribute("placeholder");
    const title = el.getAttribute("title");
    const alt = el.getAttribute("alt");
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      return cleanText(placeholder || title || el.getAttribute("name") || "");
    }
    const text = cleanText(el.innerText || el.textContent || "");
    return text || cleanText(title || alt || placeholder || el.getAttribute("name") || "");
  }

  function isVisible(el, rect) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return false;
    const style = (el.ownerDocument.defaultView || window).getComputedStyle(el);
    if (!style || style.display === "none" || style.visibility === "hidden" || parseFloat(style.opacity) === 0) {
      return false;
    }
    const r = rect || el.getBoundingClientRect();
    if (r.width < 1 && r.height < 1) return false;
    return true;
  }

  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "hidden") return false;
    if (INTERACTIVE_TAGS.has(tag)) return true;
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable && el.getAttribute("contenteditable") !== "inherit") return true;
    const tabIdx = el.getAttribute("tabindex");
    if (tabIdx !== null && parseInt(tabIdx, 10) >= 0) return true;
    if (el.hasAttribute("onclick")) return true;
    if (el.childElementCount <= 3) {
      const style = (el.ownerDocument.defaultView || window).getComputedStyle(el);
      if (style && style.cursor === "pointer") {
        const pStyle = el.parentElement ? (el.ownerDocument.defaultView || window).getComputedStyle(el.parentElement) : null;
        if (!pStyle || pStyle.cursor !== "pointer") return true;
      }
    }
    return false;
  }

  function registerRef(el, framePrefix = "", rect = null) {
    const existing = elemToRef.get(el);
    const r = rect || el.getBoundingClientRect();
    const bbox = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    if (existing && (!framePrefix || existing.startsWith(framePrefix))) {
      const entry = refMap.get(existing);
      if (entry) entry.bbox = bbox;
      return existing;
    }
    const id = `${framePrefix}${nextId++}`;
    elemToRef.set(el, id);
    refMap.set(id, {
      weak: new WeakRef(el),
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      role: getRole(el),
      name: getAccessibleName(el),
      bbox
    });
    return id;
  }

  function deepQueryAll(root, out = [], visited = new Set()) {
    if (!root || visited.has(root)) return out;
    visited.add(root);
    const children = root.children || root.childNodes || [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child || child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      out.push(child);
      if (child.shadowRoot) deepQueryAll(child.shadowRoot, out, visited);
      if (tag === "iframe") {
        try {
          if (child.contentDocument?.body) deepQueryAll(child.contentDocument.body, out, visited);
        } catch { /* cross-origin iframe handled via background frameIds */ }
      } else {
        deepQueryAll(child, out, visited);
      }
    }
    return out;
  }

  function resolveTarget({ ref, selector, text, x, y } = {}) {
    if (ref !== undefined && ref !== null && String(ref).trim() !== "") {
      const key = normRef(ref);
      const entry = refMap.get(key);
      if (entry) {
        const live = entry.weak.deref();
        if (live && live.isConnected) return live;
        if (entry.selector) {
          try {
            const bySel = document.querySelector(entry.selector);
            if (bySel && isVisible(bySel)) return bySel;
          } catch { /* ignore */ }
        }
        if (entry.name) {
          const all = deepQueryAll(document.body || document.documentElement);
          const recovered = all.find(
            (el) => el.tagName.toLowerCase() === entry.tag && getAccessibleName(el) === entry.name && isVisible(el)
          );
          if (recovered) return recovered;
        }
      }
      throw new Error(`Element ref_${key} not found or no longer on page. Call read_page or find to refresh refs.`);
    }

    if (selector) {
      let el = null;
      try { el = document.querySelector(selector); } catch { /* fall through */ }
      if (!el) {
        const all = deepQueryAll(document.body || document.documentElement);
        el = all.find((n) => {
          try { return n.matches(selector); } catch { return false; }
        });
      }
      if (!el) throw new Error(`No element matched selector: ${selector}`);
      return el;
    }

    if (text) {
      const needle = String(text).toLowerCase().trim();
      const all = deepQueryAll(document.body || document.documentElement);
      let best = null;
      let bestScore = -1;
      for (const el of all) {
        if (!isVisible(el)) continue;
        const name = getAccessibleName(el).toLowerCase();
        if (!name || !name.includes(needle)) continue;
        let score = name === needle ? 100 : name.startsWith(needle) ? 70 : 40;
        if (isInteractive(el)) score += 50;
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      if (!best) throw new Error(`No visible element matched text: "${text}"`);
      return best;
    }

    if (typeof x === "number" && typeof y === "number") {
      let el = document.elementFromPoint(x, y);
      while (el && el.shadowRoot && el.shadowRoot.elementFromPoint) {
        const inner = el.shadowRoot.elementFromPoint(x, y);
        if (!inner || inner === el) break;
        el = inner;
      }
      if (!el) throw new Error(`No element at viewport coordinates (${x}, ${y})`);
      return el;
    }

    throw new Error("Target required: provide ref, selector, text, or x/y coordinates.");
  }

  function describeInteractive(el, id, rect) {
    const role = getRole(el);
    const name = getAccessibleName(el);
    const parts = [`[ref_${id}] ${role}`];
    if (name) parts.push(`"${name.replace(/"/g, "'")}"`);

    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        parts.push(el.checked ? "checked" : "unchecked");
      } else if (type !== "password") {
        const val = cleanText(el.value, 60);
        if (val) parts.push(`value="${val.replace(/"/g, "'")}"`);
      } else if (el.value) {
        parts.push(`value="••••"`);
      }
      const ph = el.getAttribute("placeholder");
      if (ph && ph !== name) parts.push(`placeholder="${cleanText(ph, 50).replace(/"/g, "'")}"`);
    } else if (tag === "select") {
      const selected = el.selectedOptions?.[0]?.text || el.value || "";
      parts.push(`value="${cleanText(selected, 50).replace(/"/g, "'")}"`);
      const opts = Array.from(el.options || []).slice(0, 8).map((o) => cleanText(o.text || o.value, 25));
      if (opts.length) parts.push(`options=[${opts.map((o) => `"${o}"`).join(",")}${el.options.length > 8 ? ",…" : ""}]`);
    } else if (tag === "a") {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:")) parts.push(`-> ${cleanText(href, 80)}`);
    } else if (el.isContentEditable) {
      const val = cleanText(el.innerText || el.textContent, 60);
      if (val && val !== name) parts.push(`value="${val.replace(/"/g, "'")}"`);
    }

    if (el.disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    if (el.getAttribute("aria-expanded") === "true") parts.push("expanded");
    if (el.getAttribute("aria-selected") === "true") parts.push("selected");
    if (el.required) parts.push("required");
    parts.push(`(${Math.round(rect.left)},${Math.round(rect.top)})`);
    return parts.join(" ");
  }

  function extractMarkdown(root) {
    const lines = [];
    function walkMd(node) {
      if (!node) return;
      if (node.nodeType === 3) {
        const t = node.nodeValue.replace(/\s+/g, " ");
        if (t.trim()) lines.push(t);
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;
      if (!isVisible(node)) return;

      if (/^h[1-6]$/.test(tag)) {
        const lvl = Number(tag[1]);
        const txt = cleanText(node.innerText || node.textContent, 300);
        if (txt) lines.push(`\n${"#".repeat(lvl)} ${txt}\n`);
        return;
      }
      if (tag === "a" && node.hasAttribute("href")) {
        const txt = cleanText(node.innerText || node.textContent, 150);
        const href = node.getAttribute("href");
        if (txt && href && !href.startsWith("javascript:")) {
          lines.push(`[${txt}](${href})`);
          return;
        }
      }
      if (tag === "li") {
        lines.push(`\n- `);
      } else if (tag === "p" || tag === "div" || tag === "section" || tag === "article" || tag === "tr" || tag === "br") {
        lines.push("\n");
      } else if (tag === "pre" || tag === "code") {
        const code = (node.innerText || node.textContent || "").trim();
        if (code) {
          lines.push(tag === "pre" ? `\n\`\`\`\n${code}\n\`\`\`\n` : `\`${code}\``);
          return;
        }
      } else if (tag === "td" || tag === "th") {
        lines.push(" | ");
      }

      const kids = node.shadowRoot ? node.shadowRoot.childNodes : node.childNodes;
      for (let i = 0; i < kids.length; i++) walkMd(kids[i]);
      if (tag === "p" || tag === "li" || tag === "tr") lines.push("\n");
    }
    walkMd(root);
    return lines.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function readPage({
    mode = "interactive",
    rootRef,
    selector,
    maxDepth = 14,
    maxChars = 30000,
    includeViewportOnly = false,
    framePrefix = ""
  } = {}) {
    let root = document.body || document.documentElement;
    if (rootRef || selector) {
      root = resolveTarget({ ref: rootRef, selector });
    }

    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    const scrollEl = document.scrollingElement || document.documentElement;
    const activeEl = document.activeElement;
    let activeRef = "";
    if (activeEl && activeEl !== document.body && activeEl !== document.documentElement) {
      activeRef = `ref_${registerRef(activeEl, framePrefix)}`;
    }

    const header = framePrefix
      ? `--- Subframe [${framePrefix.replace(/_$/, "")}] URL: ${location.href} ---`
      : [
          `Title: ${document.title || "(untitled)"}`,
          `URL: ${location.href}`,
          `Viewport: ${vw}x${vh} | Scroll: y=${Math.round(scrollEl?.scrollTop || 0)}/${Math.round(scrollEl?.scrollHeight || vh)}` +
            (activeRef ? ` | Focused: ${activeRef}` : "")
        ].join("\n");

    if (mode === "markdown") {
      const md = extractMarkdown(root);
      const out = `${header}\n\n${md}`;
      return {
        text: out.length > maxChars ? out.slice(0, maxChars) + "\n…[truncated]" : out,
        crossOriginFrames: []
      };
    }

    const lines = [header, ""];
    const crossOriginFrames = [];
    let charCount = header.length + 2;
    let truncated = false;

    function inViewport(r) {
      return r.bottom >= 0 && r.right >= 0 && r.top <= vh && r.left <= vw;
    }

    function pushLine(depth, str) {
      if (truncated) return;
      const indent = "  ".repeat(Math.min(depth, 8));
      const line = `${indent}${str}`;
      if (charCount + line.length + 1 > maxChars) {
        lines.push("…[snapshot truncated; use rootRef, selector, includeViewportOnly:true, or find]");
        truncated = true;
        return;
      }
      lines.push(line);
      charCount += line.length + 1;
    }

    function walk(node, depth) {
      if (!node || truncated || depth > maxDepth) return;
      if (node.nodeType === 3) {
        if (mode === "full") {
          const txt = cleanText(node.nodeValue, 180);
          if (txt.length > 1) pushLine(depth, `"${txt}"`);
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;

      const rect = node.getBoundingClientRect();
      if (!isVisible(node, rect)) return;
      if (includeViewportOnly && !inViewport(rect) && node.childElementCount === 0) return;

      if (tag === "iframe") {
        try {
          const subDoc = node.contentDocument;
          if (subDoc?.body) {
            pushLine(depth, `iframe "${cleanText(node.title || node.getAttribute("src") || "frame", 60)}"`);
            walk(subDoc.body, depth + 1);
            return;
          }
        } catch { /* cross-origin */ }
        if (rect.width >= 20 && rect.height >= 20) {
          const src = node.getAttribute("src") || "";
          crossOriginFrames.push({ src, x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) });
          pushLine(depth, `iframe[cross-origin] src="${cleanText(src, 80)}" (${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)})`);
        }
        return;
      }

      const interactive = isInteractive(node);
      if (interactive) {
        if (!includeViewportOnly || inViewport(rect)) {
          const id = registerRef(node, framePrefix, rect);
          pushLine(depth, describeInteractive(node, id, rect));
        }
        // Still descend if container holds nested controls (e.g. clickable card with inner buttons)
        if (tag === "input" || tag === "select" || tag === "textarea" || tag === "a" || tag === "button") return;
      }

      const isHeading = /^h[1-6]$/.test(tag);
      const role = node.getAttribute("role") || "";
      const isDialog = tag === "dialog" || role === "dialog" || role === "alertdialog";
      let nextDepth = depth;

      if (isDialog) {
        pushLine(depth, `[dialog] "${getAccessibleName(node)}"`);
        nextDepth = depth + 1;
      } else if (isHeading) {
        const hTxt = cleanText(node.innerText || node.textContent, 140);
        if (hTxt) pushLine(depth, `${tag} "${hTxt}"`);
        return;
      } else if (LANDMARK_TAGS.has(tag) && tag !== "label") {
        const lbl = cleanText(node.getAttribute("aria-label") || "", 60);
        pushLine(depth, lbl ? `${tag} "${lbl}"` : tag);
        nextDepth = depth + 1;
      } else if (mode === "interactive" && node.childElementCount === 0) {
        const leafTxt = cleanText(node.textContent, 110);
        if (leafTxt.length >= 2) pushLine(depth, `text "${leafTxt}"`);
        return;
      }

      if (node.shadowRoot) {
        for (const c of node.shadowRoot.childNodes) walk(c, nextDepth);
      }
      for (const c of node.childNodes) walk(c, nextDepth);
    }

    walk(root, 0);
    return { text: lines.join("\n"), crossOriginFrames };
  }

  function findElements({ query = "", role = "", limit = 25, framePrefix = "" } = {}) {
    const q = String(query).trim();
    const qLower = q.toLowerCase();
    const tokens = qLower.split(/\s+/).filter(Boolean);
    const roleFilter = String(role || "").toLowerCase().trim();
    const all = deepQueryAll(document.body || document.documentElement);
    const scored = [];
    const seen = new Set();

    // Direct CSS selector fast path
    if (q) {
      for (const el of all) {
        try {
          if (el.matches(q) && isVisible(el)) {
            seen.add(el);
            scored.push({ el, score: 200 });
          }
        } catch { break; }
      }
    }

    for (const el of all) {
      if (seen.has(el) || !isVisible(el)) continue;
      const elRole = getRole(el);
      if (roleFilter && !elRole.includes(roleFilter)) continue;

      const name = getAccessibleName(el);
      const hay = `${elRole} ${el.tagName.toLowerCase()} ${name} ${el.id || ""} ${el.getAttribute("name") || ""} ${el.getAttribute("href") || ""} ${cleanText(el.textContent, 140)}`.toLowerCase();

      if (tokens.length > 0 && !tokens.every((t) => hay.includes(t))) continue;

      let score = 10;
      const nameLower = name.toLowerCase();
      if (qLower && nameLower === qLower) score += 120;
      else if (qLower && nameLower.startsWith(qLower)) score += 80;
      else if (qLower && nameLower.includes(qLower)) score += 50;
      if (isInteractive(el)) score += 40;
      scored.push({ el, score });
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit).map(({ el }) => {
      const rect = el.getBoundingClientRect();
      const id = registerRef(el, framePrefix, rect);
      return describeInteractive(el, id, rect);
    });

    return {
      count: top.length,
      totalMatched: scored.length,
      text: top.length
        ? `Found ${top.length}${scored.length > top.length ? ` (of ${scored.length})` : ""} matching element(s):\n` + top.join("\n")
        : `No visible elements matched query="${query}"${role ? ` role="${role}"` : ""}.`
    };
  }

  function ensureInView(el) {
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (r.top < 0 || r.bottom > vh || r.left < 0 || r.right > vw) {
      el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    }
    return el.getBoundingClientRect();
  }

  function dispatchMouseSequence(el, kind, coords) {
    const win = el.ownerDocument.defaultView || window;
    const rect = ensureInView(el);
    const clientX = coords?.x ?? Math.round(rect.left + rect.width / 2);
    const clientY = coords?.y ?? Math.round(rect.top + rect.height / 2);
    const button = kind === "right_click" ? 2 : 0;
    const buttons = kind === "right_click" ? 2 : 1;
    const base = { bubbles: true, cancelable: true, composed: true, view: win, clientX, clientY, button };

    el.dispatchEvent(new win.PointerEvent("pointerover", { ...base, buttons: 0 }));
    el.dispatchEvent(new win.MouseEvent("mouseover", { ...base, buttons: 0 }));
    el.dispatchEvent(new win.PointerEvent("pointermove", { ...base, buttons: 0 }));
    el.dispatchEvent(new win.MouseEvent("mousemove", { ...base, buttons: 0 }));
    if (kind === "hover") return;

    const fireClick = (detail) => {
      el.dispatchEvent(new win.PointerEvent("pointerdown", { ...base, buttons, detail }));
      const downOk = el.dispatchEvent(new win.MouseEvent("mousedown", { ...base, buttons, detail }));
      if (downOk && typeof el.focus === "function") el.focus({ preventScroll: true });
      el.dispatchEvent(new win.PointerEvent("pointerup", { ...base, buttons: 0, detail }));
      el.dispatchEvent(new win.MouseEvent("mouseup", { ...base, buttons: 0, detail }));
      if (kind === "right_click") {
        el.dispatchEvent(new win.MouseEvent("contextmenu", { ...base, buttons: 0, detail }));
      } else {
        el.dispatchEvent(new win.MouseEvent("click", { ...base, buttons: 0, detail }));
      }
    };

    fireClick(1);
    if (kind === "double_click") {
      fireClick(2);
      el.dispatchEvent(new win.MouseEvent("dblclick", { ...base, buttons: 0, detail: 2 }));
    }
  }

  function setNativeValue(el, value) {
    const win = el.ownerDocument.defaultView || window;
    const proto =
      el instanceof win.HTMLInputElement
        ? win.HTMLInputElement.prototype
        : el instanceof win.HTMLTextAreaElement
          ? win.HTMLTextAreaElement.prototype
          : win.HTMLSelectElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fillElement(el, rawValue) {
    const win = el.ownerDocument.defaultView || window;
    ensureInView(el);
    if (typeof el.focus === "function") el.focus({ preventScroll: true });

    const tag = el.tagName.toLowerCase();
    if (tag === "select") {
      const strVal = String(rawValue);
      const opts = Array.from(el.options || []);
      const match =
        opts.find((o) => o.value === strVal) ||
        opts.find((o) => o.text.trim().toLowerCase() === strVal.trim().toLowerCase()) ||
        opts.find((o) => o.text.toLowerCase().includes(strVal.trim().toLowerCase()));
      if (!match) throw new Error(`No <select> option matched "${strVal}"`);
      setNativeValue(el, match.value);
      el.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true, composed: true }));
      return `Selected "${match.text.trim()}" (${match.value})`;
    }

    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox" || t === "radio") {
        const want = typeof rawValue === "boolean" ? rawValue : !["false", "0", "off", "no", "unchecked"].includes(String(rawValue).toLowerCase());
        if (el.checked !== want) dispatchMouseSequence(el, "click");
        return `${t} set to ${el.checked}`;
      }
    }

    if (el.isContentEditable) {
      const doc = el.ownerDocument || document;
      const sel = doc.getSelection();
      const range = doc.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      const str = String(rawValue ?? "");
      const usedExec = doc.execCommand && doc.execCommand("insertText", false, str);
      if (!usedExec) {
        el.textContent = str;
        el.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: str }));
      }
      return `Filled contenteditable (${str.length} chars)`;
    }

    const str = String(rawValue ?? "");
    setNativeValue(el, str);
    el.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: str }));
    el.dispatchEvent(new win.Event("change", { bubbles: true, composed: true }));
    return `Filled ${getRole(el)} (${str.length} chars)`;
  }

  const KEY_CODES = {
    Enter: { code: "Enter", keyCode: 13 },
    Tab: { code: "Tab", keyCode: 9 },
    Escape: { code: "Escape", keyCode: 27 },
    Backspace: { code: "Backspace", keyCode: 8 },
    Delete: { code: "Delete", keyCode: 46 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    Home: { code: "Home", keyCode: 36 },
    End: { code: "End", keyCode: 35 },
    PageUp: { code: "PageUp", keyCode: 33 },
    PageDown: { code: "PageDown", keyCode: 34 },
    " ": { code: "Space", keyCode: 32 }
  };

  function pressKeyOn(targetEl, combo) {
    const el = targetEl || document.activeElement || document.body;
    const win = el.ownerDocument.defaultView || window;
    const parts = String(combo).split("+").filter(Boolean);
    let ctrlKey = false, shiftKey = false, altKey = false, metaKey = false;
    let mainKey = parts[parts.length - 1] || "Enter";
    for (let i = 0; i < parts.length - 1; i++) {
      const m = parts[i].toLowerCase();
      if (m === "ctrl" || m === "control") ctrlKey = true;
      else if (m === "shift") shiftKey = true;
      else if (m === "alt" || m === "option") altKey = true;
      else if (m === "meta" || m === "cmd" || m === "command") metaKey = true;
    }
    if (mainKey === "Space") mainKey = " ";
    const meta = KEY_CODES[mainKey] || {
      code: mainKey.length === 1 ? `Key${mainKey.toUpperCase()}` : mainKey,
      keyCode: mainKey.length === 1 ? mainKey.toUpperCase().charCodeAt(0) : 0
    };
    const init = {
      key: mainKey,
      code: meta.code,
      keyCode: meta.keyCode,
      which: meta.keyCode,
      ctrlKey, shiftKey, altKey, metaKey,
      bubbles: true, cancelable: true, composed: true, view: win
    };
    const notCancelled = el.dispatchEvent(new win.KeyboardEvent("keydown", init));
    el.dispatchEvent(new win.KeyboardEvent("keypress", init));
    if (notCancelled && mainKey === "Enter" && !ctrlKey && !metaKey && !shiftKey) {
      const form = el.closest?.("form");
      if (form && el.tagName?.toLowerCase() === "input") {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
      }
    }
    el.dispatchEvent(new win.KeyboardEvent("keyup", init));
  }

  async function typeText(el, text, { clear = false, submit = false, delayMs = 0 } = {}) {
    const win = el.ownerDocument.defaultView || window;
    ensureInView(el);
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    if (clear) fillElement(el, "");

    const str = String(text ?? "");
    const isStdInput = el instanceof win.HTMLInputElement || el instanceof win.HTMLTextAreaElement;
    for (const ch of str) {
      const kc = ch.toUpperCase().charCodeAt(0);
      el.dispatchEvent(new win.KeyboardEvent("keydown", { key: ch, keyCode: kc, bubbles: true, cancelable: true, composed: true }));
      if (el.isContentEditable) {
        const doc = el.ownerDocument || document;
        if (!doc.execCommand?.("insertText", false, ch)) {
          el.textContent = (el.textContent || "") + ch;
        }
      } else if (isStdInput) {
        setNativeValue(el, (el.value || "") + ch);
      }
      el.dispatchEvent(new win.InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: ch }));
      el.dispatchEvent(new win.KeyboardEvent("keyup", { key: ch, keyCode: kc, bubbles: true, cancelable: true, composed: true }));
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }
    if (isStdInput) el.dispatchEvent(new win.Event("change", { bubbles: true, composed: true }));
    if (submit) pressKeyOn(el, "Enter");
    return `Typed ${str.length} chars${submit ? " + Enter" : ""}`;
  }

  function findScrollableContainer(startEl) {
    let cur = startEl;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const st = getComputedStyle(cur);
      if ((st.overflowY === "auto" || st.overflowY === "scroll" || st.overflowX === "auto" || st.overflowX === "scroll") &&
          (cur.scrollHeight > cur.clientHeight + 10 || cur.scrollWidth > cur.clientWidth + 10)) {
        return cur;
      }
      cur = cur.parentElement || cur.getRootNode()?.host || null;
    }
    const docScroll = document.scrollingElement || document.documentElement;
    if (docScroll.scrollHeight > window.innerHeight + 10 || docScroll.scrollWidth > window.innerWidth + 10) {
      return docScroll;
    }
    // Inner-pane SPA fallback (e.g. Gmail, Slack, Notion, Linear)
    let best = docScroll;
    let bestArea = 0;
    for (const el of deepQueryAll(document.body || document.documentElement)) {
      if (el.scrollHeight <= el.clientHeight + 20) continue;
      const st = getComputedStyle(el);
      if (st.overflowY !== "auto" && st.overflowY !== "scroll") continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }

  function waitForCondition({ selector, selectorHidden, text, textGone, urlContains, ms, timeoutMs = 10000 } = {}) {
    if (typeof ms === "number" && ms > 0 && !selector && !selectorHidden && !text && !textGone && !urlContains) {
      return new Promise((r) => setTimeout(() => r(`Waited ${ms}ms`), Math.min(ms, 30000)));
    }

    const check = () => {
      if (urlContains && !location.href.includes(urlContains)) return false;
      if (selector) {
        const el = document.querySelector(selector);
        if (!el || !isVisible(el)) return false;
      }
      if (selectorHidden) {
        const el = document.querySelector(selectorHidden);
        if (el && isVisible(el)) return false;
      }
      if (text) {
        const bodyTxt = (document.body?.innerText || "").toLowerCase();
        if (!bodyTxt.includes(String(text).toLowerCase())) return false;
      }
      if (textGone) {
        const bodyTxt = (document.body?.innerText || "").toLowerCase();
        if (bodyTxt.includes(String(textGone).toLowerCase())) return false;
      }
      return true;
    };

    if (check()) return Promise.resolve("Condition already satisfied");

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, msg) => {
        if (settled) return;
        settled = true;
        obs.disconnect();
        clearInterval(poll);
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(msg);
      };
      const obs = new MutationObserver(() => {
        if (check()) finish(null, "Condition satisfied");
      });
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
      const poll = setInterval(() => {
        if (check()) finish(null, "Condition satisfied");
      }, 150);
      const timer = setTimeout(() => {
        finish(new Error(`Timed out after ${timeoutMs}ms waiting for condition`));
      }, timeoutMs);
    });
  }

  async function runSingleAction(step) {
    const action = step.action;
    if (action === "wait") return await waitForCondition(step);

    if (action === "press_key") {
      const el = (step.ref || step.selector || step.text) ? resolveTarget(step) : null;
      pressKeyOn(el, step.key || step.value || "Enter");
      return `Pressed ${step.key || step.value || "Enter"}`;
    }

    if (action === "scroll") {
      if ((step.ref || step.selector || step.text) && !step.direction) {
        const el = resolveTarget(step);
        el.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        return `Scrolled target into view`;
      }
      const startEl = (step.ref || step.selector || step.text || typeof step.x === "number")
        ? resolveTarget(step)
        : document.elementFromPoint(Math.round(window.innerWidth / 2), Math.round(window.innerHeight / 2));
      const container = findScrollableContainer(startEl);
      const amt = Number(step.amount) || 600;
      const dir = (step.direction || "down").toLowerCase();
      const dx = dir === "right" ? amt : dir === "left" ? -amt : 0;
      const dy = dir === "down" ? amt : dir === "up" ? -amt : 0;
      container.scrollBy({ left: dx, top: dy, behavior: "instant" });
      return `Scrolled ${dir} by ${amt}px (scrollTop=${Math.round(container.scrollTop)})`;
    }

    const el = resolveTarget(step);
    const coords = typeof step.x === "number" && typeof step.y === "number" ? { x: step.x, y: step.y } : null;

    switch (action) {
      case "click":
      case "double_click":
      case "right_click":
      case "hover":
        dispatchMouseSequence(el, action, coords);
        return `${action} on ${getRole(el)} "${getAccessibleName(el)}"`;
      case "fill":
      case "select":
        return fillElement(el, step.value ?? step.text ?? "");
      case "check":
        return fillElement(el, true);
      case "uncheck":
        return fillElement(el, false);
      case "clear":
        return fillElement(el, "");
      case "focus":
        ensureInView(el);
        el.focus?.({ preventScroll: true });
        return `Focused ${getRole(el)} "${getAccessibleName(el)}"`;
      case "type":
        return await typeText(el, step.value ?? step.text ?? "", {
          clear: Boolean(step.clear),
          submit: Boolean(step.submit),
          delayMs: Number(step.delayMs) || 0
        });
      default:
        throw new Error(`Unsupported action: "${action}"`);
    }
  }

  async function act(params = {}) {
    const steps = Array.isArray(params.steps) && params.steps.length > 0 ? params.steps : [params];
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      try {
        const msg = await runSingleAction(steps[i]);
        results.push(steps.length > 1 ? `Step ${i + 1}: ${msg}` : msg);
      } catch (err) {
        throw new Error(
          steps.length > 1
            ? `Failed at step ${i + 1}/${steps.length} (${steps[i].action}): ${err.message || err}` +
              (results.length ? `\nCompleted prior steps:\n${results.join("\n")}` : "")
            : String(err.message || err)
        );
      }
    }
    let snapshotText = "";
    if (params.returnSnapshot) {
      // Allow microtasks + one animation frame for React/Vue DOM commits before snapshotting
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
      snapshotText = "\n\n" + readPage({ mode: params.snapshotMode || "interactive" }).text;
    }
    return { text: results.join("\n") + snapshotText };
  }

  async function formInput({ fields = [], submit = false } = {}) {
    const log = [];
    let lastEl = null;
    for (const f of fields) {
      const el = resolveTarget({ ref: f.ref, selector: f.selector, text: f.label });
      lastEl = el;
      const res = fillElement(el, f.value);
      log.push(`${f.label || f.ref || f.selector}: ${res}`);
    }
    if (submit && lastEl) {
      const form = lastEl.closest?.("form");
      if (form && typeof form.requestSubmit === "function") form.requestSubmit();
      else pressKeyOn(lastEl, "Enter");
      log.push("Submitted form");
    }
    return { text: log.join("\n") };
  }

  function getBbox(params = {}) {
    const el = resolveTarget(params);
    const r = ensureInView(el);
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
      centerX: Math.round(r.left + r.width / 2),
      centerY: Math.round(r.top + r.height / 2),
      dpr: window.devicePixelRatio || 1,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight
    };
  }

  function setFiles({ ref, selector, files = [] } = {}) {
    const el = resolveTarget({ ref, selector });
    if (el.tagName.toLowerCase() !== "input" || (el.getAttribute("type") || "").toLowerCase() !== "file") {
      throw new Error(`Target element is not an <input type="file">`);
    }
    const win = el.ownerDocument.defaultView || window;
    const dt = new win.DataTransfer();
    for (const f of files) {
      const bin = atob(f.base64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new win.File([bytes], f.name, { type: f.mimeType || "application/octet-stream" }));
    }
    el.files = dt.files;
    el.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new win.Event("change", { bubbles: true, composed: true }));
    return { text: `Attached ${files.length} file(s) to <input type="file">: ${files.map((f) => f.name).join(", ")}` };
  }

  globalThis.__cext = {
    version: 1,
    async dispatch(method, params = {}) {
      switch (method) {
        case "read_page": return readPage(params);
        case "find": return findElements(params);
        case "act": return await act(params);
        case "form_input": return await formInput(params);
        case "wait_for": return { text: await waitForCondition(params) };
        case "get_bbox": return getBbox(params);
        case "set_files": return setFiles(params);
        default: throw new Error(`Unknown dom-agent method: ${method}`);
      }
    }
  };
})();
