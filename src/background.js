/*
 * Background worker
 * -----------------
 * Downloads the three auto-generated frames YouTube keeps for every video
 * (mq1/mq2/mq3 = ~25% / 50% / 75% of the video), scores each one, and returns
 * the scores to the content script.
 *
 * It runs here instead of in the page because the page can't read pixels from
 * i.ytimg.com (canvas would be "tainted"). With host_permissions, the extension
 * can fetch the image bytes directly.
 */

const CACHE_PREFIX = "f1:";
const TTL_MS = 30 * 24 * 60 * 60 * 1000; // keep scores for 30 days
const MAX_ENTRIES = 20000;
const ID_RE = /^[\w-]{11}$/;

const mem = new Map(); // videoId -> result
const inflight = new Map(); // videoId -> Promise<result>

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === "analyze" && typeof msg.id === "string" && ID_RE.test(msg.id)) {
    analyze(msg.id).then(sendResponse, () => sendResponse(null));
    return true; // async response
  }
  if (msg && msg.type === "image" && typeof msg.id === "string" && ID_RE.test(msg.id) && [0, 1, 2].includes(msg.idx)) {
    hiResImage(msg.id, msg.idx).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg && msg.type === "clearCache") {
    clearCache().then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
  return false;
});

async function analyze(id) {
  if (mem.has(id)) return mem.get(id);
  if (inflight.has(id)) return inflight.get(id);

  const job = (async () => {
    const key = CACHE_PREFIX + id;
    const stored = (await chrome.storage.local.get(key))[key];
    if (stored && Date.now() - stored.t < TTL_MS) {
      mem.set(id, stored);
      return stored;
    }

    const frames = await Promise.all([1, 2, 3].map((n) => scoreFrame(id, n)));

    // undefined = network error (don't cache), null = frame doesn't exist (cache it)
    const hadNetworkError = frames.some((f) => f === undefined);
    if (frames.every((f) => !f)) return hadNetworkError ? null : emptyResult();

    const result = {
      t: Date.now(),
      s: frames.map((f) => (f ? f.score : null)),
      bad: frames.map((f) => (f ? f.bad : true)),
    };

    if (!hadNetworkError) {
      mem.set(id, result);
      await chrome.storage.local.set({ [key]: result });
      if (Math.random() < 0.01) prune().catch(() => {});
    }
    return result;
  })();

  inflight.set(id, job);
  try {
    return await job;
  } finally {
    inflight.delete(id);
  }
}

function emptyResult() {
  return { t: Date.now(), s: [null, null, null], bad: [true, true, true] };
}

/**
 * Scores one frame. Returns:
 *   { score, bad }  on success
 *   null            if the frame doesn't exist (404)
 *   undefined       on network failure
 */
async function scoreFrame(id, n) {
  let res;
  try {
    res = await fetch(`https://i.ytimg.com/vi/${id}/mq${n}.jpg`, { cache: "force-cache" });
  } catch {
    return undefined;
  }
  if (!res.ok) return null;

  let bmp;
  try {
    bmp = await createImageBitmap(await res.blob());
  } catch {
    return null;
  }

  const W = 96;
  const H = 54;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, W, H);
  bmp.close();
  const { data } = ctx.getImageData(0, 0, W, H);

  const N = W * H;
  const gray = new Float32Array(N);
  let sum = 0;
  let dark = 0;
  let bright = 0;

  for (let i = 0; i < N; i++) {
    const y = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    gray[i] = y;
    sum += y;
    if (y < 18) dark++;
    if (y > 240) bright++;
  }

  const mean = sum / N;

  let varSum = 0;
  for (let i = 0; i < N; i++) varSum += (gray[i] - mean) ** 2;
  const std = Math.sqrt(varSum / N);

  // Average neighbour-to-neighbour difference: a cheap sharpness / detail measure.
  let edge = 0;
  let count = 0;
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      edge += Math.abs(gray[i] - gray[i + 1]) + Math.abs(gray[i] - gray[i + W]);
      count += 2;
    }
  }
  edge /= count;

  const fracDark = dark / N;
  const fracBright = bright / N;

  // "Bad" = basically black, basically white, or basically flat/blurry.
  const bad = mean < 22 || mean > 238 || std < 14 || edge < 1.5 || fracDark > 0.85 || fracBright > 0.85;

  const exposure = 1 - Math.min(1, Math.abs(mean - 115) / 115);
  const contrast = Math.min(1, std / 55);
  const detail = Math.min(1, edge / 10);
  const score = 0.3 * exposure + 0.3 * contrast + 0.4 * detail;

  return { score: Math.round(score * 1000) / 1000, bad };
}

/* ------------------------------------------------------------------
 * High-resolution frames
 * ------------------------------------------------------------------
 * sd{n}.jpg is 640x480 and hq{n}.jpg is 480x360, but both are 4:3 with black
 * letterbox bars baked in for widescreen videos. We download one, crop the bars
 * off, and hand the page a clean JPEG as a data: URL.
 */

const imgCache = new Map(); // "id:idx" -> data URL (small LRU)
const IMG_CACHE_MAX = 300;

async function hiResImage(id, idx) {
  const key = `${id}:${idx}`;
  if (imgCache.has(key)) {
    const v = imgCache.get(key);
    imgCache.delete(key); // refresh LRU position
    imgCache.set(key, v);
    return v;
  }

  for (const quality of ["sd", "hq"]) {
    let res;
    try {
      res = await fetch(`https://i.ytimg.com/vi/${id}/${quality}${idx + 1}.jpg`, { cache: "force-cache" });
    } catch {
      continue;
    }
    if (!res.ok) continue;

    try {
      const bmp = await createImageBitmap(await res.blob());
      if (bmp.width < 320) { bmp.close(); continue; }
      const url = await cropToDataUrl(bmp);
      bmp.close();
      if (!url) continue;

      imgCache.set(key, url);
      if (imgCache.size > IMG_CACHE_MAX) imgCache.delete(imgCache.keys().next().value);
      return url;
    } catch {
      continue;
    }
  }
  return null;
}

/** Counts near-uniform black rows/columns from each edge. Pure function (easy to test). */
function detectBars(data, W, H) {
  const lineIsBlack = (start, step, n) => {
    let sum = 0;
    let mx = 0;
    for (let k = 0; k < n; k++) {
      const i = start + k * step;
      const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += y;
      if (y > mx) mx = y;
    }
    return sum / n < 14 && mx < 40;
  };
  const row = (y) => lineIsBlack(y * W * 4, 4, W);
  const col = (x) => lineIsBlack(x * 4, W * 4, H);

  const maxV = Math.floor(H * 0.3);
  const maxH = Math.floor(W * 0.3);

  let top = 0;
  while (top < maxV && row(top)) top++;
  let bottom = 0;
  while (bottom < maxV && row(H - 1 - bottom)) bottom++;
  let left = 0;
  while (left < maxH && col(left)) left++;
  let right = 0;
  while (right < maxH && col(W - 1 - right)) right++;

  // Letterbox bars are symmetric. If they aren't, it's probably just a dark scene.
  if (Math.abs(top - bottom) > 8) top = bottom = Math.min(top, bottom);
  if (Math.abs(left - right) > 8) left = right = Math.min(left, right);

  const fix = (n) => (n < 4 ? 0 : n + 1); // ignore tiny edges; trim 1px of antialiasing
  return { top: fix(top), bottom: fix(bottom), left: fix(left), right: fix(right) };
}

async function cropToDataUrl(bmp) {
  const W = bmp.width;
  const H = bmp.height;

  const probe = new OffscreenCanvas(W, H);
  const pctx = probe.getContext("2d", { willReadFrequently: true });
  pctx.drawImage(bmp, 0, 0);
  const { data } = pctx.getImageData(0, 0, W, H);

  const b = detectBars(data, W, H);
  const cw = W - b.left - b.right;
  const ch = H - b.top - b.bottom;
  if (cw < W * 0.5 || ch < H * 0.4) return null; // something's off; don't use it

  const out = new OffscreenCanvas(cw, ch);
  out.getContext("2d").drawImage(bmp, b.left, b.top, cw, ch, 0, 0, cw, ch);
  const blob = await out.convertToBlob({ type: "image/jpeg", quality: 0.92 });

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return "data:image/jpeg;base64," + btoa(bin);
}

async function prune() {
  const all = await chrome.storage.local.get(null);
  const now = Date.now();
  const entries = Object.entries(all).filter(([k]) => k.startsWith(CACHE_PREFIX));
  const remove = entries.filter(([, v]) => !v || now - v.t > TTL_MS).map(([k]) => k);

  const fresh = entries.filter(([, v]) => v && now - v.t <= TTL_MS);
  if (fresh.length > MAX_ENTRIES) {
    fresh.sort((a, b) => a[1].t - b[1].t);
    remove.push(...fresh.slice(0, fresh.length - MAX_ENTRIES).map(([k]) => k));
  }
  if (remove.length) await chrome.storage.local.remove(remove);
}

async function clearCache() {
  mem.clear();
  imgCache.clear();
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(CACHE_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}
