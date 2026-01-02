/**
 * MU-TH-UR 6000 // APP CONTROLLER (App C)
 * MSF Field Edition.
 * Hardened. Deterministic. Offline-First.
 *
 * Assumes these IDs exist in index.html:
 * - db-input
 * - status-text
 * - intro-overlay (optional)
 * - processing-indicator (optional)
 * - verified-badge (optional)
 * - file-metadata (optional)
 * - toggle-field-mode (optional)
 * - chart-visits, chart-duration, chart-states, chart-operators, chart-volume
 * - .panel elements
 */

/* ----------------------------- CONFIG ----------------------------- */
const WORKER_PATH = "./telemetry-worker.js";

// Hard stop to prevent browser OOM in field laptops
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100MB

// Worker health / recovery
const WORKER_BOOT_TIMEOUT_MS = 4000; // if no READY in time, surface error
const MAX_WORKER_RESTARTS = 1;

// Status codes are used for data-status attribute on #status-text
const STATUS = {
  IDLE: "IDLE", // demo data shown or empty, waiting for file
  RECEIVED: "RECEIVED",
  PROCESSING: "PROCESSING",
  VALID: "VALID",
  INVALID: "INVALID",
};

// Map technical errors to user-facing guidance
const ERROR_MAP = {
  "FILE EXCEEDS CAPACITY": "File too large. Export a smaller date range.",
  "NO TABLES FOUND": "Not a valid EMR export (no tables detected).",
  "INVALID SCHEMA": "Required visit/workflow data not found in this export.",
  "WORKER BUSY": "System busy. Please wait.",
  "WORKER CRASH": "Analysis engine crashed. Please reload.",
  "WORKER NOT READY": "System initializing. Please try again.",
  "READ FAILED": "Browser could not read the file. Try re-exporting.",
  "D3 MISSING": "Visualization library failed to load (D3).",
};

/* ----------------------------- STATE ------------------------------ */
const state = {
  worker: null,
  workerReady: false,
  workerBootTimer: null,
  workerRestarts: 0,

  status: STATUS.IDLE,
  data: null,

  // file lifecycle
  fileInfo: null,
  isProcessing: false,

  // rendering
  renderScheduled: false,
  resizeTimer: null,

  // layout cache
  dims: new WeakMap(), // Element -> {width, height}

  // UI prefs
  fieldMode: false,
};

/* ------------------------------ UI API ---------------------------- */
const ui = {
  byId(id) {
    return document.getElementById(id);
  },

  setHidden(id, hidden) {
    const el = this.byId(id);
    if (!el) return;
    el.classList.toggle("hidden", !!hidden);
  },

  setText(id, text) {
    const el = this.byId(id);
    if (!el) return;
    el.innerText = text;
  },

  setAttr(id, name, value) {
    const el = this.byId(id);
    if (!el) return;
    el.setAttribute(name, value);
  },

  toggleClass(id, className, on) {
    const el = this.byId(id);
    if (!el) return;
    el.classList.toggle(className, !!on);
  },

  disableUploadButtons(disabled) {
    document.querySelectorAll(".file-upload-btn").forEach((btn) => {
      btn.classList.toggle("disabled", !!disabled);
    });
  },

  setStatus(code, message, tooltip = "") {
    state.status = code;
    const el = this.byId("status-text");
    if (!el) return;
    el.innerText = message;
    el.setAttribute("data-status", code);
    if (tooltip) el.setAttribute("title", tooltip);
    else el.removeAttribute("title");
  },

  showFileMetadata(show) {
    const el = this.byId("file-metadata");
    if (!el) return;
    if (show && state.fileInfo) {
      el.innerText = state.fileInfo;
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  },

  showVerifiedBadge(show) {
    const el = this.byId("verified-badge");
    if (!el) return;
    el.classList.toggle("hidden", !show);
  },

  showProcessing(show) {
    this.setHidden("processing-indicator", !show);
  },

  hideIntroOverlay() {
    // overlay is optional
    this.setHidden("intro-overlay", true);
  },
};

/* --------------------------- BOOTSTRAP ---------------------------- */
function bootstrap() {
  // 1) Dependency check
  if (typeof window.d3 === "undefined") {
    ui.setStatus(STATUS.INVALID, "Visual Core Missing", ERROR_MAP["D3 MISSING"]);
    return;
  }

  // 2) Init worker and UI
  initWorker();
  setupUI();

  // 3) Demo data (kept intentionally) but status is IDLE
  state.data = generateSyntheticData();
  scheduleRender();
  ui.setStatus(STATUS.IDLE, "Waiting for data input", "System ready. Load local EMR export.");
}

function setupUI() {
  // Single source of truth: db-input (avoid duplicate listeners)
  const fileInput = ui.byId("db-input");
  if (fileInput) fileInput.addEventListener("change", handleFileUpload);

  const toggle = ui.byId("toggle-field-mode");
  if (toggle) {
    toggle.addEventListener("click", () => {
      state.fieldMode = !state.fieldMode;
      document.body.classList.toggle("field-mode", state.fieldMode);
      scheduleRender();
    });
  }

  // Cache panel sizes via ResizeObserver to avoid repeated synchronous reflow
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      state.dims.set(entry.target, {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    }
    if (state.resizeTimer) clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(scheduleRender, 150);
  });

  document.querySelectorAll(".panel").forEach((panel) => ro.observe(panel));
}

/* ----------------------------- WORKER ----------------------------- */
function initWorker() {
  teardownWorker();

  state.workerReady = false;

  try {
    const w = new Worker(WORKER_PATH);
    state.worker = w;

    w.onmessage = handleWorkerMessage;

    w.onerror = () => {
      // Don’t dump detailed errors; keep field-safe
      onWorkerCrash("WORKER CRASH");
    };

    // Boot timeout: if READY doesn’t arrive, surface it as invalid
    if (state.workerBootTimer) clearTimeout(state.workerBootTimer);
    state.workerBootTimer = setTimeout(() => {
      if (!state.workerReady) {
        ui.setStatus(STATUS.INVALID, "System Failure", "Worker did not come online.");
        // Optional: one restart attempt
        maybeRestartWorker();
      }
    }, WORKER_BOOT_TIMEOUT_MS);
  } catch {
    ui.setStatus(STATUS.INVALID, "Browser Incompatible", "Web Worker support missing.");
  }
}

function teardownWorker() {
  if (state.workerBootTimer) clearTimeout(state.workerBootTimer);
  state.workerBootTimer = null;

  if (state.worker) {
    try {
      state.worker.terminate();
    } catch {
      // ignore
    }
  }
  state.worker = null;
  state.workerReady = false;
}

function onWorkerCrash(reasonKey) {
  ui.showProcessing(false);
  state.isProcessing = false;
  ui.disableUploadButtons(false);

  ui.showVerifiedBadge(false);
  ui.setStatus(STATUS.INVALID, ERROR_MAP[reasonKey] || "Worker failure", "Reload or retry.");

  maybeRestartWorker();
}

function maybeRestartWorker() {
  if (state.workerRestarts >= MAX_WORKER_RESTARTS) return;
  state.workerRestarts += 1;
  initWorker();
}

/* ----------------------------- FILE IO ---------------------------- */
function handleFileUpload(e) {
  const input = e.target;
  const file = input?.files?.[0];
  if (!file) return;

  // prevent overlapping jobs
  if (state.isProcessing) return;

  // basic guardrail: file size
  if (file.size > MAX_FILE_BYTES) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    ui.setStatus(
      STATUS.INVALID,
      "File too large",
      `Selected ${sizeMB} MB. Max supported is ${(MAX_FILE_BYTES / (1024 * 1024)).toFixed(0)} MB.`
    );
    input.value = "";
    return;
  }

  // show file received immediately
  const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
  state.fileInfo = `${file.name} (${sizeMB} MB)`;
  ui.showFileMetadata(true);
  ui.showVerifiedBadge(false);

  ui.setStatus(STATUS.RECEIVED, "File received", "Preparing local analysis…");
  ui.disableUploadButtons(true);

  // if worker not ready, try restart and block
  if (!state.worker || !state.workerReady) {
    ui.setStatus(STATUS.INVALID, "System initializing", ERROR_MAP["WORKER NOT READY"]);
    ui.disableUploadButtons(false);
    maybeRestartWorker();
    input.value = "";
    return;
  }

  // process
  state.isProcessing = true;
  ui.hideIntroOverlay();
  ui.showProcessing(true);
  ui.setStatus(STATUS.PROCESSING, "Analyzing EMR database…", "Local processing active. Data stays on this device.");

  const reader = new FileReader();

  reader.onerror = () => {
    state.isProcessing = false;
    ui.showProcessing(false);
    ui.disableUploadButtons(false);
    ui.setStatus(STATUS.INVALID, "Read Failed", ERROR_MAP["READ FAILED"]);
    input.value = "";
  };

  reader.onload = () => {
    try {
      // Transfer ownership to worker (no copy)
      state.worker.postMessage({ type: "ANALYZE", buffer: reader.result }, [reader.result]);
    } catch {
      state.isProcessing = false;
      ui.showProcessing(false);
      ui.disableUploadButtons(false);
      ui.setStatus(STATUS.INVALID, "Transfer Failed", "Could not hand file to analysis engine.");
      input.value = "";
    }
  };

  reader.readAsArrayBuffer(file);
}

/* ------------------------ WORKER MESSAGES ------------------------- */
function handleWorkerMessage(e) {
  const msg = e?.data || {};
  const { type, payload, error } = msg;

  if (type === "READY") {
    state.workerReady = true;
    if (state.workerBootTimer) clearTimeout(state.workerBootTimer);
    state.workerBootTimer = null;
    return;
  }

  if (type === "ANALYSIS_COMPLETE") {
    state.isProcessing = false;
    ui.showProcessing(false);
    ui.disableUploadButtons(false);

    // Strict payload checks (avoid NaN / silent D3 failures)
    const validated = validatePayload(payload);
    if (!validated.ok) {
      ui.showVerifiedBadge(false);
      ui.setStatus(STATUS.INVALID, "Invalid export format", validated.reason);
      clearFileInput();
      return;
    }

    // Prefer worker to send render-ready dates, but accept either:
    // - date: ISO string
    // - date: epoch ms
    // - date: Date-like string
    // Convert safely here, bounded (fast enough for typical 24h buckets)
    const visits = payload.visits.map((d) => ({
      date: toSafeDate(d.date),
      value: Number(d.value) || 0,
    }));

    state.data = {
      ...payload,
      visits,
    };

    ui.showVerifiedBadge(true);
    ui.setStatus(STATUS.VALID, "Data loaded", "Analysis complete. Verified locally.");
    scheduleRender();
    clearFileInput();
    return;
  }

  if (type === "ERROR") {
    state.isProcessing = false;
    ui.showProcessing(false);
    ui.disableUploadButtons(false);

    // Don’t console.log raw errors in a medical context.
    // Use user-safe mapped error + allow tooltip to show the technical string if needed.
    const technical = typeof error === "string" ? error : "Unknown error";
    const userMsg = mapErrorToUser(technical);

    ui.showVerifiedBadge(false);
    ui.setStatus(STATUS.INVALID, userMsg, technical);
    clearFileInput();
    return;
  }
}

function clearFileInput() {
  const input = ui.byId("db-input");
  if (input) input.value = "";
}

/* --------------------------- VALIDATION --------------------------- */
function mapErrorToUser(technical) {
  for (const [key, msg] of Object.entries(ERROR_MAP)) {
    if (technical.includes(key)) return msg;
  }
  return "Processing error. Please try a different export.";
}

function validatePayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "No data returned from analysis engine." };
  }

  // Minimal contract: visits is required for the main dashboard
  if (!Array.isArray(payload.visits)) {
    return { ok: false, reason: "Visit series missing. Export may be incomplete." };
  }

  // Optional datasets: if missing, we’ll render empty (but avoid crashes)
  if (!Array.isArray(payload.duration)) payload.duration = [];
  if (!Array.isArray(payload.states)) payload.states = [];
  if (!Array.isArray(payload.operators)) payload.operators = [];
  if (!Array.isArray(payload.volume)) payload.volume = [];

  return { ok: true };
}

function toSafeDate(v) {
  // Accept: Date object
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v;

  // Accept: epoch (ms or seconds)
  if (typeof v === "number") {
    const ms = v < 10_000_000_000 ? v * 1000 : v; // seconds -> ms heuristic
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? new Date() : d;
  }

  // Accept: string
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/* --------------------------- RENDER LOOP -------------------------- */
function scheduleRender() {
  if (state.renderScheduled) return;
  state.renderScheduled = true;

  requestAnimationFrame(() => {
    try {
      renderAllCharts();
    } finally {
      state.renderScheduled = false;
    }
  });
}

function renderAllCharts() {
  if (!state.data) return;

  renderVisits("#chart-visits", state.data.visits);
  renderDuration("#chart-duration", state.data.duration);
  renderStates("#chart-states", state.data.states);
  renderOperators("#chart-operators", state.data.operators);
  renderVolume("#chart-volume", state.data.volume);
}

/* --------------------- D3 HELPERS + CHARTS ------------------------ */
function getChartContext(selector, margin) {
  const container = document.querySelector(selector);
  if (!container) return null;

  // Prefer ResizeObserver cached dims to avoid forced reflow
  let width = 0;
  let height = 0;

  // If container is inside a panel, use cached size
  const panel = container.closest(".panel") || container;
  const cached = state.dims.get(panel);

  if (cached) {
    // container has padding; measure container rect once if needed
    const rect = container.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
  } else {
    const rect = container.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
  }

  if (!width || !height) return null;

  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;

  const svg = d3
    .select(container)
    .selectAll("svg")
    .data([1])
    .join("svg")
    .attr("width", width)
    .attr("height", height);

  const g = svg
    .selectAll("g.chart-area")
    .data([1])
    .join("g")
    .attr("class", "chart-area")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  return { container, svg, g, width: innerWidth, height: innerHeight, fullWidth: width, fullHeight: height };
}

// Pull colors from CSS variables so Field Mode automatically updates charts
function cssVar(name, fallback) {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}

function renderVisits(selector, data) {
  const ctx = getChartContext(selector, { top: 10, right: 10, bottom: 20, left: 35 });
  if (!ctx) return;

  const { g, width, height, fullWidth } = ctx;
  const lineColor = cssVar("--success", "#33ff00");

  const x = d3.scaleTime().domain(d3.extent(data, (d) => d.date)).range([0, width]);
  const y = d3
    .scaleLinear()
    .domain([0, (d3.max(data, (d) => d.value) || 1) * 1.1])
    .range([height, 0]);

  g.selectAll(".x-axis")
    .data([1])
    .join("g")
    .attr("class", "x-axis chart-axis")
    .attr("transform", `translate(0,${height})`)
    .call(d3.axisBottom(x).ticks(5).tickSize(0).tickPadding(8))
    .call((sel) => sel.select(".domain").attr("stroke", cssVar("--border-color", "#333")));

  g.selectAll(".y-axis")
    .data([1])
    .join("g")
    .attr("class", "y-axis chart-axis")
    .call(d3.axisLeft(y).ticks(4).tickSize(-fullWidth))
    .call((sel) => sel.select(".domain").remove())
    .call((sel) => sel.selectAll("line").attr("stroke", cssVar("--grid-color", "#222")));

  const area = d3
    .area()
    .x((d) => x(d.date))
    .y0(height)
    .y1((d) => y(d.value))
    .curve(d3.curveMonotoneX);

  g.selectAll(".area-path")
    .data([data])
    .join("path")
    .attr("class", "area-path")
    .attr("d", area)
    .attr("fill", cssVar("--panel-bg", "#1a1a1a"));

  const line = d3
    .line()
    .x((d) => x(d.date))
    .y((d) => y(d.value))
    .curve(d3.curveMonotoneX);

  g.selectAll(".line-path")
    .data([data])
    .join("path")
    .attr("class", "line-path")
    .attr("d", line)
    .attr("fill", "none")
    .attr("stroke", lineColor)
    .attr("stroke-width", 2);
}

function renderDuration(selector, data) {
  const ctx = getChartContext(selector, { top: 10, right: 10, bottom: 10, left: 10 });
  if (!ctx) return;

  const { g, width, height } = ctx;
  const accent = cssVar("--accent", "#d4d4d4");

  if (!data.length) {
    g.selectAll("*").remove();
    return;
  }

  const x = d3.scaleLinear().domain([0, data.length - 1]).range([0, width]);
  const y = d3
    .scaleLinear()
    .domain([0, d3.max(data, (d) => d.value) || 1])
    .range([height, 0]);

  const line = d3
    .line()
    .x((d, i) => x(i))
    .y((d) => y(d.value))
    .curve(d3.curveStep);

  g.selectAll(".dur-line")
    .data([data])
    .join("path")
    .attr("class", "dur-line")
    .attr("d", line)
    .attr("fill", "none")
    .attr("stroke", accent)
    .attr("stroke-width", 1.5);
}

function renderStates(selector, data) {
  const ctx = getChartContext(selector, { top: 20, right: 20, bottom: 20, left: 40 });
  if (!ctx) return;

  const { g, width, height } = ctx;
  const success = cssVar("--success", "#33ff00");
  const warn = cssVar("--synthetic", "#f59e0b");
  const neutral = cssVar("--border-color", "#333");

  if (!data.length) {
    g.selectAll("*").remove();
    return;
  }

  const x = d3.scaleBand().domain(data.map((d) => d.category)).range([0, width]).padding(0.4);
  const y = d3
    .scaleLinear()
    .domain([0, d3.max(data, (d) => d.value) || 1])
    .range([height, 0]);

  g.selectAll("rect")
    .data(data, (d) => d.category)
    .join("rect")
    .attr("x", (d) => x(d.category))
    .attr("y", (d) => y(d.value))
    .attr("width", x.bandwidth())
    .attr("height", (d) => height - y(d.value))
    .attr("fill", (d) => {
      if (d.category === "ADMIT") return success;
      if (d.category === "DISCHARGE") return warn;
      return neutral;
    });

  g.selectAll(".x-axis")
    .data([1])
    .join("g")
    .attr("class", "x-axis chart-axis")
    .attr("transform", `translate(0,${height})`)
    .call(d3.axisBottom(x).tickSize(0))
    .call((sel) => sel.select(".domain").remove());
}

function renderOperators(selector, data) {
  const ctx = getChartContext(selector, { top: 10, right: 10, bottom: 10, left: 5 });
  if (!ctx) return;

  const { container, svg, g, width } = ctx;

  if (!data.length) {
    g.selectAll("*").remove();
    return;
  }

  const barHeight = 24;
  const requiredHeight = Math.max(150, data.length * barHeight + 20);

  // keep container scrollable; only svg grows
  svg.attr("height", requiredHeight);

  const neutral = cssVar("--border-color", "#333");
  const textMain = cssVar("--text-main", "#a8a8a8");
  const textDim = cssVar("--text-dim", "#666");

  const x = d3.scaleLinear().domain([0, d3.max(data, (d) => d.value) || 1]).range([0, Math.max(10, width - 60)]);
  const y = d3
    .scaleBand()
    .domain(data.map((d) => d.name))
    .range([0, data.length * barHeight])
    .padding(0.2);

  g.selectAll("rect")
    .data(data, (d) => d.name)
    .join("rect")
    .attr("x", 5)
    .attr("y", (d) => y(d.name))
    .attr("width", (d) => x(d.value))
    .attr("height", y.bandwidth())
    .attr("fill", neutral);

  g.selectAll(".lbl-name")
    .data(data, (d) => d.name)
    .join("text")
    .attr("class", "lbl-name")
    .attr("x", 8)
    .attr("y", (d) => y(d.name) + y.bandwidth() / 2 + 4)
    .text((d) => d.name)
    .attr("fill", textMain)
    .style("font-size", "10px")
    .style("pointer-events", "none");

  g.selectAll(".lbl-val")
    .data(data, (d) => d.name)
    .join("text")
    .attr("class", "lbl-val")
    .attr("x", (d) => x(d.value) + 12)
    .attr("y", (d) => y(d.name) + y.bandwidth() / 2 + 4)
    .text((d) => d.value)
    .attr("fill", textDim)
    .style("font-size", "10px");
}

function renderVolume(selector, data) {
  const ctx = getChartContext(selector, { top: 10, right: 0, bottom: 20, left: 0 });
  if (!ctx) return;

  const { g, width, height } = ctx;
  const neutral = cssVar("--border-color", "#333");

  if (!data.length) {
    g.selectAll("*").remove();
    return;
  }

  const x = d3.scaleBand().domain(data.map((_, i) => i)).range([0, width]).padding(0.1);
  const y = d3.scaleLinear().domain([0, 100]).range([height, 0]);

  g.selectAll("rect")
    .data(data)
    .join("rect")
    .attr("x", (d, i) => x(i))
    .attr("y", (d) => y(d.value))
    .attr("width", x.bandwidth())
    .attr("height", (d) => height - y(d.value))
    .attr("fill", (d, i) => (i % 2 === 0 ? neutral : "#444"));
}

/* ---------------------- SYNTHETIC DATA (DEMO) --------------------- */
function generateSyntheticData() {
  const now = Date.now();
  const HOUR = 3600 * 1000;

  // Keep demo visuals stable-ish (but not truly random)
  const seed = Math.floor(now / (10 * 60 * 1000)); // changes every 10 minutes
  const rand = mulberry32(seed);

  return {
    visits: Array.from({ length: 24 }, (_, i) => ({
      date: new Date(now - (23 - i) * HOUR),
      value: 20 + Math.floor(Math.sin(i / 3) * 10 + rand() * 5),
    })),
    duration: Array.from({ length: 50 }, (_, i) => ({
      index: i,
      value: 15 + rand() * 30,
    })),
    states: [
      { category: "ADMIT", value: 120 },
      { category: "TRIAGE", value: 45 },
      { category: "DISCHARGE", value: 80 },
      { category: "TRANSFER", value: 12 },
    ],
    operators: [
      { name: "Dr. A", value: 450 },
      { name: "Dr. B", value: 320 },
      { name: "Nurse C", value: 510 },
      { name: "Nurse D", value: 480 },
      { name: "Tech E", value: 150 },
    ].sort((a, b) => b.value - a.value),
    volume: Array.from({ length: 40 }, () => ({ value: rand() * 80 })),
  };
}

// deterministic PRNG
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------ START ----------------------------- */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap);
} else {
  bootstrap();
}