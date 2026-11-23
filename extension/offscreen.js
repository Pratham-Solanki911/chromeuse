// On-demand Canvas helper for screenshot cropping & compression (zero background timers or network requests).

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "cext_process_image") return false;
  processImage(msg)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
  return true;
});

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode captured tab image"));
    img.src = dataUrl;
  });
}

async function processImage({ dataUrl, crop, maxWidth = 1280, format = "jpeg", quality = 0.82, dpr = 1 }) {
  const img = await loadImage(dataUrl);
  const scaleDpr = dpr > 0 ? dpr : 1;

  let sx = 0;
  let sy = 0;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;

  if (crop && crop.width > 0 && crop.height > 0) {
    sx = Math.max(0, Math.round(crop.x * scaleDpr));
    sy = Math.max(0, Math.round(crop.y * scaleDpr));
    sw = Math.min(img.naturalWidth - sx, Math.max(1, Math.round(crop.width * scaleDpr)));
    sh = Math.min(img.naturalHeight - sy, Math.max(1, Math.round(crop.height * scaleDpr)));
  }

  let outW = Math.round(sw / scaleDpr) || sw;
  let outH = Math.round(sh / scaleDpr) || sh;
  if (maxWidth && outW > maxWidth) {
    const ratio = maxWidth / outW;
    outW = Math.max(1, Math.round(outW * ratio));
    outH = Math.max(1, Math.round(outH * ratio));
  }

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { alpha: format === "png" });
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, outW, outH);

  const mimeType = format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg";
  const outUrl = canvas.toDataURL(mimeType, quality);
  const commaIdx = outUrl.indexOf(",");
  return {
    base64: commaIdx >= 0 ? outUrl.slice(commaIdx + 1) : outUrl,
    mimeType,
    width: outW,
    height: outH,
    rawWidth: img.naturalWidth,
    rawHeight: img.naturalHeight
  };
}
