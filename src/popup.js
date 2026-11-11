const DEFAULTS = {
  enabled: true,
  frame: "50",
  skipDull: true,
  hiRes: true,
  hoverReveal: true,
  hoverDelay: 400,
  cleanTitles: true,
};

const $ = (id) => document.getElementById(id);

const HINTS = {
  "25": "Quarter of the way in. Often the setup, before the payoff.",
  "50": "Right in the middle of the video.",
  "75": "Three quarters in. Usually closer to the payoff.",
  auto: "Checks all three frames and picks the sharpest, best-exposed one.",
};

let state = { ...DEFAULTS };
let statusTimer = null;

function flash(msg) {
  const el = $("status");
  el.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (el.textContent = ""), 2200);
}

function save(patch) {
  state = { ...state, ...patch };
  chrome.storage.sync.set(patch);
  render();
}

function render() {
  $("enabled").checked = state.enabled;
  $("panel").classList.toggle("disabled", !state.enabled);

  document.querySelectorAll("#frame button").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.value === state.frame));
    b.tabIndex = b.dataset.value === state.frame ? 0 : -1;
  });

  document.querySelectorAll(".notch").forEach((n) => {
    n.classList.toggle("on", state.frame === "auto" || n.dataset.n === state.frame);
  });

  $("frame-hint").textContent = HINTS[state.frame] || "";

  $("skipDull").checked = state.skipDull;
  $("hiRes").checked = state.hiRes;
  $("hoverReveal").checked = state.hoverReveal;
  $("cleanTitles").checked = state.cleanTitles;

  $("hoverDelay").value = state.hoverDelay;
  $("hoverDelayOut").textContent = state.hoverDelay === 0 ? "instant" : `${state.hoverDelay} ms`;
  $("delayRow").classList.toggle("off", !state.hoverReveal);
}

function bind() {
  $("enabled").addEventListener("change", (e) => save({ enabled: e.target.checked }));
  $("skipDull").addEventListener("change", (e) => save({ skipDull: e.target.checked }));
  $("hiRes").addEventListener("change", (e) => save({ hiRes: e.target.checked }));
  $("hoverReveal").addEventListener("change", (e) => save({ hoverReveal: e.target.checked }));
  $("cleanTitles").addEventListener("change", (e) => save({ cleanTitles: e.target.checked }));
  $("hoverDelay").addEventListener("input", (e) => save({ hoverDelay: Number(e.target.value) }));

  const group = $("frame");
  group.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-value]");
    if (b) save({ frame: b.dataset.value });
  });
  group.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const values = [...group.querySelectorAll("button")].map((b) => b.dataset.value);
    const i = values.indexOf(state.frame);
    const next = values[(i + (e.key === "ArrowRight" ? 1 : values.length - 1)) % values.length];
    save({ frame: next });
    group.querySelector(`[data-value="${next}"]`).focus();
    e.preventDefault();
  });

  $("reset").addEventListener("click", () => {
    save({ ...DEFAULTS });
    flash("Settings reset.");
  });

  $("clearCache").addEventListener("click", async () => {
    try {
      const ok = await chrome.runtime.sendMessage({ type: "clearCache" });
      flash(ok ? "Frame cache cleared." : "Couldn't clear the cache.");
    } catch {
      flash("Couldn't clear the cache.");
    }
  });
}

chrome.storage.sync.get(DEFAULTS, (stored) => {
  state = { ...DEFAULTS, ...stored };
  render();
  bind();
});
