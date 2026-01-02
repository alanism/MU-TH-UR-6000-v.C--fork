/**
 * MU-TH-UR 6000 // TELEMETRY WORKER (App C)
 * Offline-first. CSP-safe. Deterministic. Memory-conscious.
 */

importScripts('./lib/sql-wasm.js');

/* ------------------------ CONSTANTS ------------------------ */

const MAX_DB_BYTES = 100 * 1024 * 1024; // 100 MB hard cap
const MAX_ROWS_SCAN = 5000;
const MAX_GROUP_ROWS = 50;

/* ------------------------ STATE ------------------------ */

let SQL = null;
let db = null;
let busy = false;

/* ------------------------ UTILITIES ------------------------ */

/**
 * Escape SQLite identifiers (table / column names)
 * Prevents metadata-based SQL injection.
 */
function escapeId(id) {
  return `"${String(id).replace(/"/g, '""')}"`;
}

/**
 * Close DB safely
 */
function closeDb() {
  if (db) {
    try { db.close(); } catch (_) {}
    db = null;
  }
}

/* ------------------------ INIT SQL.JS ------------------------ */

(async function init() {
  try {
    SQL = await initSqlJs({
      locateFile: file => `./lib/${file}`
    });
    postMessage({ type: 'READY' });
  } catch (err) {
    postMessage({ type: 'ERROR', error: 'INIT_FAILED: ' + err.message });
  }
})();

/* ------------------------ MESSAGE HANDLER ------------------------ */

onmessage = async (e) => {
  const { type, buffer } = e.data || {};

  if (type !== 'ANALYZE') return;

  if (busy) {
    postMessage({ type: 'ERROR', error: 'WORKER_BUSY' });
    return;
  }

  busy = true;

  try {
    const result = await analyzeDatabase(buffer);
    postMessage({ type: 'ANALYSIS_COMPLETE', payload: result });
  } catch (err) {
    postMessage({ type: 'ERROR', error: err.message });
  } finally {
    busy = false;
  }
};

/* ------------------------ CORE LOGIC ------------------------ */

async function analyzeDatabase(buffer) {
  if (!SQL) throw new Error('WORKER_NOT_READY');
  if (!buffer || !buffer.byteLength) throw new Error('EMPTY_FILE');
  if (buffer.byteLength > MAX_DB_BYTES) throw new Error('FILE_EXCEEDS_CAPACITY');

  closeDb();
  db = new SQL.Database(new Uint8Array(buffer));

  const tables = listTables();
  if (!tables.length) throw new Error('NO_TABLES_FOUND');

  const mainTable = tables.find(t =>
    /event|visit|patient|log|telemetry/i.test(t)
  );
  if (!mainTable) throw new Error('INVALID_SCHEMA');

  return aggregateTable(mainTable);
}

/* ------------------------ SCHEMA DISCOVERY ------------------------ */

function listTables() {
  const stmt = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  );

  const names = [];
  while (stmt.step()) {
    names.push(stmt.get()[0]);
  }
  stmt.free();
  return names;
}

function listColumns(table) {
  const stmt = db.prepare(`PRAGMA table_info(${escapeId(table)})`);
  const cols = [];
  while (stmt.step()) {
    cols.push(stmt.get()[1]);
  }
  stmt.free();
  return cols;
}

/* ------------------------ AGGREGATIONS ------------------------ */

function aggregateTable(table) {
  const columns = listColumns(table);

  const colTime = columns.find(c => /time|date|created|timestamp/i.test(c));
  const colDur  = columns.find(c => /duration|min|ms|length/i.test(c));
  const colOp   = columns.find(c => /staff|user|operator|agent|doctor|nurse/i.test(c));
  const colStat = columns.find(c => /status|state|type|category/i.test(c));

  const visits   = colTime ? buildVisits(table, colTime) : [];
  const duration = colDur  ? buildDuration(table, colDur) : [];
  const states   = colStat ? buildStates(table, colStat) : [];
  const operators= colOp   ? buildOperators(table, colOp) : [];

  return {
    visits,
    duration,
    states,
    operators,
    volume: [] // intentionally empty (no synthetic data)
  };
}

/* ------------------------ METRICS ------------------------ */

function buildVisits(table, col) {
  const stmt = db.prepare(
    `SELECT ${escapeId(col)} FROM ${escapeId(table)} ORDER BY ${escapeId(col)} ASC LIMIT ?`
  );
  stmt.bind([MAX_ROWS_SCAN]);

  const buckets = Object.create(null);

  while (stmt.step()) {
    const raw = stmt.get()[0];
    const date = normalizeDate(raw);
    if (!date) continue;

    date.setMinutes(0, 0, 0);
    const key = date.toISOString();
    buckets[key] = (buckets[key] || 0) + 1;
  }
  stmt.free();

  return Object.keys(buckets)
    .sort()
    .slice(-24)
    .map(k => ({ date: k, value: buckets[k] }));
}

function buildDuration(table, col) {
  const stmt = db.prepare(
    `SELECT ${escapeId(col)} FROM ${escapeId(table)} WHERE typeof(${escapeId(col)}) IN ('integer','real') LIMIT 100`
  );

  const out = [];
  let i = 0;
  while (stmt.step()) {
    out.push({ index: i++, value: stmt.get()[0] });
  }
  stmt.free();
  return out;
}

function buildStates(table, col) {
  const stmt = db.prepare(
    `SELECT ${escapeId(col)}, COUNT(*) FROM ${escapeId(table)}
     GROUP BY ${escapeId(col)} ORDER BY COUNT(*) DESC LIMIT ?`
  );
  stmt.bind([MAX_GROUP_ROWS]);

  const out = [];
  while (stmt.step()) {
    const [k, v] = stmt.get();
    out.push({ category: String(k ?? 'UNKNOWN'), value: v });
  }
  stmt.free();
  return out;
}

function buildOperators(table, col) {
  const stmt = db.prepare(
    `SELECT ${escapeId(col)}, COUNT(*) FROM ${escapeId(table)}
     GROUP BY ${escapeId(col)} ORDER BY COUNT(*) DESC LIMIT ?`
  );
  stmt.bind([MAX_GROUP_ROWS]);

  const out = [];
  while (stmt.step()) {
    const [k, v] = stmt.get();
    out.push({ name: String(k ?? 'SYSTEM'), value: v });
  }
  stmt.free();
  return out;
}

/* ------------------------ DATE NORMALIZATION ------------------------ */

function normalizeDate(value) {
  if (value == null) return null;

  if (typeof value === 'number') {
    if (value > 1e12) return new Date(value);          // ms
    if (value > 1e9)  return new Date(value * 1000);   // seconds
  }

  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}