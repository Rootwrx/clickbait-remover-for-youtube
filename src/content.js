/*
 * Clickbait Remover for YouTube - content script
 * ----------------------------------------
 *  - Finds every YouTube thumbnail <img> and swaps it for an auto-generated frame
 *    (mq1 / mq2 / mq3 ≈ 25% / 50% / 75% of the video).
 *  - Optionally asks the background worker to score the frames and skip dull ones
 *    (black, white, flat, blurry) or pick the best one automatically.
 *  - Hover a thumbnail for a moment to peek at the original.
 *  - Optionally cleans clickbait titles (emoji, ALL CAPS, hype tags, "!!!").
 */
(() => {
  "use strict";

  // ---------------------------------------------------------------- settings

  const DEFAULTS = {
    enabled: true,
    frame: "50", // "25" | "50" | "75" | "auto"
    skipDull: true,
    hiRes: true, // download sharper frames (letterbox bars cropped)
    hoverReveal: true,
    hoverDelay: 400, // ms
    cleanTitles: true,
  };

  const FRAME_INDEX = { "25": 0, "50": 1, "75": 2 };
  const MAX_CONCURRENT_ANALYSES = 4;

  let settings = { ...DEFAULTS };
  const tokens = new WeakMap(); // img -> latest apply token (avoids expando props on page elements)
  let hiResBlocked = false; // set if the page refuses our data: images

  // ------------------------------------------------------------- thumbnails

  // https://i.ytimg.com/vi/<id>/<name>.jpg   (also vi_webp / .webp)
  const THUMB_RE = /^https:\/\/i\.ytimg\.com\/vi(?:_webp)?\/([\w-]{11})\/([\w]+)\.(?:jpg|webp)/;

  // Live streams and premieres have no real "middle frame", so they keep their original thumbnail.
  const LIVE_NAME_RE = /_(live|upcoming)$/; // e.g. hqdefault_live.jpg
  const THUMB_BOX =
    "ytd-thumbnail, yt-thumbnail-view-model, ytd-rich-grid-media, ytd-video-renderer, " +
    "ytd-compact-video-renderer, ytd-grid-video-renderer, ytd-playlist-video-renderer, yt-lockup-view-model";
  const LIVE_BADGE_SELECTOR = [
    '[overlay-style="LIVE"]',
    '[overlay-style="UPCOMING"]',
    '[class*="thumbnail-live"]',
    '[class*="thumbnail-upcoming"]',
  ].join(",");
  const BADGE_TEXT_SELECTOR =
    '.badge-shape-wiz__text, .yt-badge-shape__text, ytd-thumbnail-overlay-time-status-renderer #text';
  const LIVE_TEXT_RE = /^\s*(live|upcoming|premiere)\s*$/i;

  function isLiveThumb(img) {
    const box = img.closest(THUMB_BOX);
    if (!box) return false;
    if (box.querySelector(LIVE_BADGE_SELECTOR)) return true;
    for (const el of box.querySelectorAll(BADGE_TEXT_SELECTOR)) {
      if (LIVE_TEXT_RE.test(el.textContent)) return true;
    }
    return false;
  }

  function clearImgState(img) {
    ["mfOrig", "mfId", "mfFrameUrl", "mfFrameIdx", "mfQuality", "mfShown"].forEach((k) => delete img.dataset[k]);
  }

  // Put the original back and stop touching this thumbnail until it's reused for another video.
  function skipImg(img) {
    restoreImg(img); // also cancels any pending hi-res swap
    clearImgState(img);
    img.dataset.mfSkip = "1";
  }

  function frameUrl(id, idx, quality) {
    return `https://i.ytimg.com/vi/${id}/${quality}${idx + 1}.jpg`;
  }

  function processImg(img) {
    if (!settings.enabled) return;

    const src = img.src;
    if (!src) return;
    if (img.dataset.mfSrc && src === img.dataset.mfSrc) {
      // Already handled. A LIVE badge can render after the image, so re-check.
      if (!img.dataset.mfSkip && img.dataset.mfOrig && isLiveThumb(img)) skipImg(img);
      return;
    }

    delete img.dataset.mfSkip; // new source = possibly a different video

    const m = THUMB_RE.exec(src);
    if (!m) return;

    const id = m[1];
    const name = m[2];
    if (/^(oar|frame)/.test(name)) return; // Shorts thumbnails
    if (img.closest('a[href^="/shorts/"]')) return;

    if (LIVE_NAME_RE.test(name) || isLiveThumb(img)) {
      clearImgState(img);
      img.dataset.mfSkip = "1";
      img.dataset.mfSrc = src; // treat as handled
      return;
    }

    // A new (or recycled) thumbnail: remember the original and start fresh.
    delete img.dataset.mfShown;
    img.dataset.mfOrig = src;
    img.dataset.mfId = id;

    bindImgEvents(img);
    applyFrame(img, id);
  }

  async function applyFrame(img, id) {
    const token = Symbol("apply");
    tokens.set(img, token);

    const fixedIdx = settings.frame === "auto" ? 1 : FRAME_INDEX[settings.frame];
    const needsAnalysis = settings.frame === "auto" || settings.skipDull;

    // Show a sensible frame right away so the clickbait thumbnail doesn't flash.
    setFrame(img, id, fixedIdx, "mq");
    let idx = fixedIdx;

    if (needsAnalysis) {
      const result = await analyze(id);
      if (tokens.get(img) !== token || img.dataset.mfId !== id || !settings.enabled) return;
      if (result) {
        const picked = pickFrame(result);
        if (picked !== null && picked !== fixedIdx) {
          idx = picked;
          setFrame(img, id, idx, "mq");
        }
      }
    }

    upgradeQuality(img, id, idx, token);
  }

  // Swap the quick low-res frame for a sharp, letterbox-free one from the background worker.
  async function upgradeQuality(img, id, idx, token) {
    if (!settings.hiRes || hiResBlocked) return;
    const url = await enqueue(() => chrome.runtime.sendMessage({ type: "image", id, idx }));
    if (!url) return;
    if (tokens.get(img) !== token || img.dataset.mfId !== id) return;
    if (Number(img.dataset.mfFrameIdx) !== idx || !settings.enabled || !settings.hiRes) return;

    img.dataset.mfQuality = "hi";
    img.dataset.mfFrameUrl = url;
    img.dataset.mfSrc = url;
    if (!img.dataset.mfShown) img.src = url;
  }

  function setFrame(img, id, idx, quality) {
    const url = frameUrl(id, idx, quality);
    img.dataset.mfFrameIdx = String(idx);
    img.dataset.mfQuality = quality;
    img.dataset.mfFrameUrl = url;
    img.dataset.mfSrc = url;
    if (img.dataset.mfShown) return; // user is hovering; the new frame is shown on mouseleave
    img.src = url;
  }

  function pickFrame(res) {
    const s = res.s;
    const bad = res.bad;
    const valid = [0, 1, 2].filter((i) => s[i] != null);
    if (!valid.length) return null;

    const score = (i) => s[i] + (i === 1 ? 0.05 : 0); // slight preference for the middle
    const best = (arr) => arr.reduce((a, b) => (score(b) > score(a) ? b : a));
    const good = valid.filter((i) => !bad[i]);

    if (settings.frame === "auto") return best(good.length ? good : valid);

    const want = FRAME_INDEX[settings.frame];
    if (!settings.skipDull) return want;
    if (s[want] != null && !bad[want]) return want;
    if (good.length) return good.reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
    return want;
  }

  // If an mq frame doesn't exist, try hq; if that fails too, restore the original.
  function onImgError(e) {
    const img = e.currentTarget;
    if (!img.dataset.mfSrc || img.src !== img.dataset.mfSrc) return;
    if (img.dataset.mfShown || img.dataset.mfSkip) return;

    const id = img.dataset.mfId;
    const idx = Number(img.dataset.mfFrameIdx || 1);

    if (img.dataset.mfQuality === "hi") {
      hiResBlocked = true; // page refused the data: image; stay on the plain frames
      setFrame(img, id, idx, "mq");
    } else if (img.dataset.mfQuality === "mq") {
      setFrame(img, id, idx, "hq");
    } else {
      restoreImg(img);
    }
  }

  function restoreImg(img) {
    const orig = img.dataset.mfOrig;
    if (!orig) return;
    tokens.delete(img);
    img.dataset.mfSrc = orig; // so the observer treats this as "already handled"
    delete img.dataset.mfShown;
    img.src = orig;
  }

  // ----------------------------------------------------------- hover reveal

  function bindImgEvents(img) {
    if (img.dataset.mfBound) return;
    img.dataset.mfBound = "1";

    img.addEventListener("error", onImgError);

    const host = img.closest("a") || img.parentElement;
    if (!host) return;

    let timer = null;
    host.addEventListener("mouseenter", () => {
      if (!settings.enabled || !settings.hoverReveal) return;
      clearTimeout(timer);
      timer = setTimeout(() => showOriginal(img), settings.hoverDelay);
    });
    host.addEventListener("mouseleave", () => {
      clearTimeout(timer);
      hideOriginal(img);
    });
  }

  function showOriginal(img) {
    const orig = img.dataset.mfOrig;
    if (img.dataset.mfSkip || !orig || img.dataset.mfShown || !img.dataset.mfFrameUrl) return;
    img.dataset.mfShown = "1";
    img.dataset.mfSrc = orig;
    img.src = orig;
  }

  function hideOriginal(img) {
    if (!img.dataset.mfShown) return;
    delete img.dataset.mfShown;
    const url = img.dataset.mfFrameUrl;
    if (!url) return;
    img.dataset.mfSrc = url;
    img.src = url;
  }

  // ------------------------------------------------------ frame analysis queue

  const analysisCache = new Map(); // id -> Promise<result|null>
  const queue = [];
  let active = 0;

  function analyze(id) {
    if (!analysisCache.has(id)) {
      const p = enqueue(() => chrome.runtime.sendMessage({ type: "analyze", id })).then((r) => {
        if (!r) analysisCache.delete(id); // allow a retry later
        return r;
      });
      analysisCache.set(id, p);
    }
    return analysisCache.get(id);
  }

  function enqueue(task) {
    return new Promise((resolve) => {
      queue.push({ task, resolve });
      pump();
    });
  }

  function pump() {
    while (active < MAX_CONCURRENT_ANALYSES && queue.length) {
      const { task, resolve } = queue.shift();
      active++;
      Promise.resolve()
        .then(task)
        .then(resolve, () => resolve(null))
        .finally(() => {
          active--;
          pump();
        });
    }
  }

  // ----------------------------------------------------------- title cleanup

  const TITLE_SELECTOR = [
    "#video-title", // classic renderers
    'a[class*="lockup-metadata-view-model"][class*="__title"]', // new lockup layout
    'h3[class*="lockup-metadata-view-model"] a',
  ].join(",");

  // Words that are fine to leave in capitals.
  const KEEP_CAPS = new Set([
    "NASA", "FBI", "CIA", "NSA", "USA", "USSR", "UK", "US", "EU", "UN", "NATO", "BBC", "CNN", "NYC", "LA",
    "HTML", "CSS", "HTTP", "HTTPS", "JSON", "API", "SQL", "AWS", "GPU", "CPU", "RAM", "SSD", "USB", "IOS",
    "NBA", "NFL", "NHL", "MLB", "UFC", "WWE", "FIFA", "UEFA", "PGA",
    "AI", "TV", "PC", "PS5", "PS4", "VR", "AR", "DJ", "MV", "OST", "DIY", "ASMR", "FAQ", "COVID", "GTA",
    "RPG", "FPS", "MMO", "OK", "LIVE", "NASCAR", "ELO", "BMW", "AMG", "SUV", "EV", "LED", "OLED", "HDR",
  ]);

  // Bracketed tags that carry real information; never strip these.
  const KEEP_TAG =
    /\b(live|official|4k|8k|hd|full|part|episode|ep|remix|trailer|lyrics?|audio|video|subtitles?|sub|cc|asmr|podcast|clip|reaction|teaser|cover|acoustic|instrumental|remaster(?:ed)?|ft|feat)\b/i;

  // Bracketed tags that are pure hype.
  const HYPE_TAG =
    /(shocking|insane|crazy|unbelievable|you won'?t believe|must (?:see|watch)|not clickbait|gone wrong|gone sexual|emotional|viral|exposed|mind[- ]?blowing|gone too far|police called|not a joke|100%|cringe)/i;

  const HYPE_PREFIX = /^\s*(?:breaking|omg|wow|wtf|shocking|urgent|insane|unbelievable)\s*[:!\-–—|]+\s*/i;

  const HYPE_SUFFIX =
    /\s*[-–—|:]?\s*(?:you won'?t believe[^.?!]*|not clickbait|must (?:see|watch)|will blow your mind)\s*$/i;

  function isHypeTag(inner) {
    if (KEEP_TAG.test(inner)) return false;
    if (HYPE_TAG.test(inner)) return true;
    const letters = inner.replace(/[^\p{L}]/gu, "");
    if (letters.length < 3) return false;
    const upper = letters.replace(/[^\p{Lu}]/gu, "").length;
    return upper / letters.length >= 0.7;
  }

  function cleanTitle(raw) {
    let s = raw.normalize("NFKC"); // turns 𝗳𝗮𝗻𝗰𝘆 unicode letters into plain ones

    // emoji and decorative symbols
    s = s.replace(/[\p{Extended_Pictographic}\uFE0F\u200D\u20E3]/gu, "");
    s = s.replace(/[►▶◀◄▼▲■□●◆◇★☆♥♦♣♠✔✘]/g, "");

    // hype tags like [SHOCKING], (GONE WRONG), 【MUST WATCH】
    s = s.replace(
      /\[([^\]]{2,40})\]|\(([^)]{2,40})\)|【([^】]{2,40})】|\{([^}]{2,40})\}/g,
      (full, a, b, c, d) => (isHypeTag(a || b || c || d || "") ? "" : full)
    );

    s = s.replace(HYPE_PREFIX, "");
    s = s.replace(HYPE_SUFFIX, "");

    // ALL CAPS -> normal case
    const letters = s.replace(/[^\p{L}]/gu, "");
    const upperCount = letters.replace(/[^\p{Lu}]/gu, "").length;
    const mostlyCaps = letters.length >= 8 && upperCount / letters.length > 0.75;
    let changedCase = false;

    s = s.replace(/\p{L}[\p{L}\p{N}'’]*/gu, (w) => {
      const isUpper = w === w.toUpperCase() && w !== w.toLowerCase();
      if (!isUpper || /\d/.test(w) || KEEP_CAPS.has(w)) return w;
      if (w.length === 1) return w; // "I", "A"
      if (!mostlyCaps && w.length < 4) return w; // RTX, NEW, UK... in a normal sentence
      changedCase = true;
      return w.toLowerCase();
    });
    if (changedCase) {
      s = s.replace(/^(\s*)(\p{Ll})/u, (_, sp, c) => sp + c.toUpperCase());
      s = s.replace(/([.?!:]\s+)(\p{Ll})/gu, (_, p, c) => p + c.toUpperCase());
    }

    // punctuation spam
    s = s.replace(/[!?]{2,}/g, (run) => (run.includes("?") ? "?" : "!"));
    s = s.replace(/\.{4,}/g, "...");
    s = s.replace(/\s*!+\s*$/, "");
    s = s.replace(/!+/g, ".");

    // whitespace and stray separators
    s = s.replace(/\s{2,}/g, " ").trim();
    s = s.replace(/^[\s\-–—|:,.]+/, "").replace(/[\s\-–—|:,]+$/, "");

    return s.length >= 2 ? s : raw; // never blank a title
  }

  function textLeaves(el) {
    if (!el.firstElementChild) return el.textContent.trim() ? [el] : [];
    return [...el.querySelectorAll("*")].filter((n) => !n.firstElementChild && n.textContent.trim());
  }

  function processTitle(el) {
    for (const t of textLeaves(el)) {
      const cur = t.textContent;
      if (t.dataset.mfTitleOut !== undefined && cur === t.dataset.mfTitleOut) continue;
      const cleaned = cleanTitle(cur);
      t.dataset.mfTitleOrig = cur;
      t.dataset.mfTitleOut = cleaned;
      if (cleaned !== cur) t.textContent = cleaned;
    }
  }

  function restoreTitles() {
    document.querySelectorAll("[data-mf-title-orig]").forEach((t) => {
      t.textContent = t.dataset.mfTitleOrig;
      delete t.dataset.mfTitleOut;
      delete t.dataset.mfTitleOrig;
    });
  }

  // -------------------------------------------------------------------- scan

  function scan() {
    if (!settings.enabled) return;
    document.querySelectorAll('img[src*="i.ytimg.com/vi"]').forEach(processImg);
    if (settings.cleanTitles) document.querySelectorAll(TITLE_SELECTOR).forEach(processTitle);
  }

  let scanTimer = null;
  function scheduleScan() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 120);
  }

  function restoreAll() {
    document.querySelectorAll("img[data-mf-orig]").forEach((img) => {
      restoreImg(img);
      delete img.dataset.mfSrc; // so they're treated as new if the extension is re-enabled
    });
    document.querySelectorAll("img[data-mf-skip]").forEach((img) => {
      delete img.dataset.mfSkip;
      delete img.dataset.mfSrc;
    });
    restoreTitles();
  }

  function reapplyAll() {
    document.querySelectorAll("img[data-mf-id]").forEach((img) => {
      if (img.dataset.mfFrameUrl && !img.dataset.mfSkip) applyFrame(img, img.dataset.mfId);
    });
  }

  // -------------------------------------------------------------------- boot

  function onSettingsChanged(changes) {
    const before = settings;
    settings = { ...settings };
    for (const [k, { newValue }] of Object.entries(changes)) {
      if (k in DEFAULTS) settings[k] = newValue === undefined ? DEFAULTS[k] : newValue;
    }

    if (!settings.enabled) {
      restoreAll();
      return;
    }
    if (!before.enabled) {
      // re-enabled: images were restored, so they'll be treated as new
      scan();
      return;
    }
    if (
      before.frame !== settings.frame ||
      before.skipDull !== settings.skipDull ||
      before.hiRes !== settings.hiRes
    ) {
      reapplyAll();
    }
    if (before.cleanTitles && !settings.cleanTitles) restoreTitles();
    scan();
  }

  function start() {
    new MutationObserver(scheduleScan).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["src"],
    });
    document.addEventListener("yt-navigate-finish", scheduleScan);
    scan();
  }

  try {
    chrome.storage.sync.get(DEFAULTS, (stored) => {
      settings = { ...DEFAULTS, ...stored };
      start();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "sync") onSettingsChanged(changes);
    });
  } catch {
    // Extension was reloaded while the page was open; a page refresh fixes it.
  }
})();
