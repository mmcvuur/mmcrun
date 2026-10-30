const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'mmcruns.db');
const ENV_PATH = path.join(__dirname, '.env');

function parseEnvFileContent(content) {
  const result = {};
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const k = line.slice(0, eqIdx).trim();
    let v = line.slice(eqIdx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    result[k] = v;
  }
  return result;
}

function getEnvApiKey() {
  try {
    if (fs.existsSync(ENV_PATH)) {
      const parsed = parseEnvFileContent(fs.readFileSync(ENV_PATH, 'utf8'));
      if (parsed.GEMINI_API_KEY) {
        return parsed.GEMINI_API_KEY.trim();
      }
    }
  } catch (_) {}
  return (process.env.GEMINI_API_KEY || '').trim();
}

function setEnvApiKey(newKey) {
  const trimmed = String(newKey || '').trim();
  let lines = [];
  if (fs.existsSync(ENV_PATH)) {
    lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/);
  }
  let found = false;
  const updated = [];
  for (const line of lines) {
    if (/^\s*GEMINI_API_KEY\s*=/.test(line)) {
      found = true;
      if (trimmed) {
        updated.push(`GEMINI_API_KEY=${trimmed}`);
      }
    } else {
      updated.push(line);
    }
  }
  if (!found && trimmed) {
    if (updated.length > 0 && updated[updated.length - 1] === '') {
      updated.pop();
    }
    updated.push(`GEMINI_API_KEY=${trimmed}`);
  }
  const finalContent = updated.filter((l, i, arr) => !(i === arr.length - 1 && l === '')).join('\n') + '\n';
  fs.writeFileSync(ENV_PATH, finalContent, { encoding: 'utf8', mode: 0o600 });
  process.env.GEMINI_API_KEY = trimmed;
}

// Initialize SQLite3 database
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date TEXT NOT NULL,
    distance_km REAL NOT NULL,
    pace_sec_per_km INTEGER NOT NULL,
    pace_display TEXT NOT NULL,
    avg_hr INTEGER NOT NULL,
    duration_sec INTEGER NOT NULL,
    run_type TEXT DEFAULT 'easy',
    notes TEXT DEFAULT '',
    is_demo INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_runs_date ON runs(run_date ASC, id ASC);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS coach_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    model TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS shoes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_date TEXT NOT NULL DEFAULT '2026-11-01',
    max_distance_km REAL NOT NULL DEFAULT 650,
    initial_km REAL NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

try {
  db.exec('ALTER TABLE runs ADD COLUMN shoe_id INTEGER DEFAULT NULL');
} catch (_) {
  // shoe_id column already exists
}

const defaultSettings = {
  goal_distance_km: '10.0',
  goal_target_pace: '5:20',
  goal_target_date: '2026-12-06',
  weekly_goal_km: '24.0',
  max_hr: '162',
  resting_hr: '56',
  gemini_model: 'gemini-3-flash-preview',
  coach_persona: ''
};

const insertSettingStmt = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
for (const [k, v] of Object.entries(defaultSettings)) {
  insertSettingStmt.run(k, v);
}

// One-time migration: move any legacy gemini_api_key out of SQLite into git-ignored .env
(() => {
  const legacyRow = db.prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").get();
  if (legacyRow) {
    const legacyKey = (legacyRow.value || '').trim();
    if (legacyKey && !getEnvApiKey()) {
      setEnvApiKey(legacyKey);
    }
    db.prepare("DELETE FROM settings WHERE key = 'gemini_api_key'").run();
  }

  // One-time initial seed for the new ASICS shoes starting Sunday (2026-11-01)
  const shoesSeededRow = db.prepare("SELECT value FROM settings WHERE key = 'shoes_seeded'").get();
  if (!shoesSeededRow) {
    const countShoes = db.prepare('SELECT COUNT(*) as count FROM shoes').get();
    if (countShoes.count === 0) {
      db.prepare(`
        INSERT INTO shoes (name, start_date, max_distance_km, initial_km, is_default)
        VALUES ('ASICS', '2026-11-01', 650, 0, 1)
      `).run();
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('shoes_seeded', '1')").run();
  }
})();

function formatPaceDisplay(secPerKm) {
  const mins = Math.floor(secPerKm / 60);
  const secs = Math.round(secPerKm % 60);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function parsePaceToSeconds(paceInput) {
  if (typeof paceInput === 'number' && Number.isFinite(paceInput)) {
    // If given e.g. 5.5, treat as 5m30s; if > 60, treat as seconds
    if (paceInput > 45) return Math.round(paceInput);
    return Math.round(paceInput * 60);
  }
  const str = String(paceInput || '').trim();
  if (str.includes(':')) {
    const parts = str.split(':');
    const mins = parseInt(parts[0], 10) || 0;
    const secs = parseInt(parts[1], 10) || 0;
    return mins * 60 + secs;
  }
  if (str.includes('.')) {
    const [m, dec] = str.split('.');
    const mins = parseInt(m, 10) || 0;
    const secs = Math.round(parseFloat('0.' + dec) * 60);
    return mins * 60 + secs;
  }
  const num = parseFloat(str);
  if (!Number.isFinite(num)) return 0;
  return num > 45 ? Math.round(num) : Math.round(num * 60);
}

function seedDemoRunsIfNeeded(force = false) {
  const countRow = db.prepare('SELECT COUNT(*) as count FROM runs').get();
  if (countRow.count > 0 && !force) return false;

  if (force) {
    db.exec('DELETE FROM runs WHERE is_demo = 1');
  }

  // Realistic 10K training block leading up to today (2026-10-25)
  const demoRuns = [
    { date: '2026-09-22', dist: 3.20, pace: '6:05', hr: 158, type: 'easy', notes: 'First week of 10K build - easy legs' },
    { date: '2026-09-25', dist: 4.00, pace: '5:52', hr: 162, type: 'easy', notes: 'Evening loop around the park' },
    { date: '2026-09-28', dist: 5.00, pace: '5:58', hr: 164, type: 'long', notes: 'First 5K milestone in training block!' },
    { date: '2026-10-01', dist: 3.80, pace: '5:35', hr: 168, type: 'tempo', notes: 'Crisp autumn air, pushed middle 2km' },
    { date: '2026-10-04', dist: 5.60, pace: '5:50', hr: 160, type: 'long', notes: 'Sunday endurance run, felt controlled' },
    { date: '2026-10-07', dist: 4.20, pace: '5:44', hr: 155, type: 'easy', notes: 'Zone 2 aerobic focus' },
    { date: '2026-10-10', dist: 5.00, pace: '5:18', hr: 173, type: 'tempo', notes: '5K tempo test - new 5K training PR!' },
    { date: '2026-10-13', dist: 6.50, pace: '5:46', hr: 161, type: 'long', notes: 'Stepping up distance toward 10K' },
    { date: '2026-10-16', dist: 4.50, pace: '5:48', hr: 152, type: 'recovery', notes: 'Low heart rate recovery run' },
    { date: '2026-10-19', dist: 7.20, pace: '5:38', hr: 163, type: 'long', notes: 'Strong negative split on final 2km' },
    { date: '2026-10-22', dist: 5.20, pace: '5:22', hr: 166, type: 'intervals', notes: '4x1km @ 10K goal pace (5:15/km)' },
    { date: '2026-10-24', dist: 8.10, pace: '5:34', hr: 162, type: 'long', notes: 'Longest run yet! 81% of 10KM goal reached' }
  ];

  const insertRun = db.prepare(`
    INSERT INTO runs (run_date, distance_km, pace_sec_per_km, pace_display, avg_hr, duration_sec, run_type, notes, is_demo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  db.exec('BEGIN TRANSACTION');
  try {
    for (const r of demoRuns) {
      const paceSec = parsePaceToSeconds(r.pace);
      const durationSec = Math.round(r.dist * paceSec);
      insertRun.run(
        r.date,
        r.dist,
        paceSec,
        formatPaceDisplay(paceSec),
        r.hr,
        durationSec,
        r.type,
        r.notes
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return true;
}

seedDemoRunsIfNeeded(false);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function getRawSettings() {
  const settingsRows = db.prepare('SELECT key, value FROM settings').all();
  const settings = { ...defaultSettings };
  for (const row of settingsRows) {
    settings[row.key] = row.value;
  }
  return settings;
}

function getShoes() {
  return db.prepare(`
    SELECT id, name, start_date, max_distance_km, initial_km, is_default, created_at
    FROM shoes
    ORDER BY is_default DESC, id ASC
  `).all();
}

function getAllRunsAndSettings() {
  const runs = db.prepare(`
    SELECT id, run_date, distance_km, pace_sec_per_km, pace_display, avg_hr, duration_sec, run_type, notes, shoe_id, is_demo, created_at
    FROM runs
    ORDER BY run_date ASC, id ASC
  `).all();

  const rawSettings = getRawSettings();
  const { gemini_api_key, shoes_seeded, ...publicSettings } = rawSettings;
  const shoes = getShoes();

  return { runs, settings: publicSettings, shoes };
}

function maskApiKey(key) {
  if (!key || key.length < 8) return '';
  return `${key.slice(0, 4)}••••••••${key.slice(-4)}`;
}

function getCoachMessages() {
  return db.prepare(`
    SELECT id, role, content, model, created_at
    FROM coach_messages
    ORDER BY id ASC
  `).all();
}

function formatDurationText(totalSec) {
  const s = Math.max(0, Math.round(totalSec));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (hrs > 0) {
    return `${hrs}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
  }
  return `${mins}m ${String(secs).padStart(2, '0')}s`;
}

function buildCoachSystemInstruction(runs, settings) {
  const goalKm = parseFloat(settings.goal_distance_km) || 10.0;
  const targetPace = settings.goal_target_pace || '5:20';
  const targetDate = settings.goal_target_date || '2026-12-06';
  const weeklyGoalKm = parseFloat(settings.weekly_goal_km) || 24.0;
  const maxHr = parseInt(settings.max_hr, 10) || 162;
  const restingHr = parseInt(settings.resting_hr, 10) || 56;
  const hrr = Math.max(20, maxHr - restingHr);

  const z1Max = Math.round(restingHr + 0.745 * hrr);
  const z2Max = Math.round(restingHr + 0.850 * hrr);
  const z3Max = Math.round(restingHr + 0.915 * hrr);
  const z4Max = Math.round(restingHr + 0.962 * hrr);

  const getZoneLabel = hr => {
    if (hr <= z1Max) return 'Z1 Recovery';
    if (hr <= z2Max) return 'Z2 Aerobic';
    if (hr <= z3Max) return 'Z3 Tempo';
    if (hr <= z4Max) return 'Z4 Threshold';
    return 'Z5 Max/VO2';
  };

  const todayStr = new Date().toISOString().slice(0, 10);

  let telemetrySummary = 'No runs logged yet.';
  let runsTable = 'None';

  if (runs.length > 0) {
    const totalKm = runs.reduce((a, r) => a + Number(r.distance_km), 0);
    const totalSec = runs.reduce((a, r) => a + Number(r.duration_sec), 0);
    const weightedPaceSec = totalKm > 0 ? totalSec / totalKm : 0;
    const avgHr = Math.round(runs.reduce((a, r) => a + Number(r.avg_hr), 0) / runs.length);

    let longestRun = runs[0];
    let fastestRun = runs[0];
    for (const r of runs) {
      if (Number(r.distance_km) > Number(longestRun.distance_km)) longestRun = r;
      if (Number(r.pace_sec_per_km) < Number(fastestRun.pace_sec_per_km)) fastestRun = r;
    }

    const latestRun = runs[runs.length - 1];
    const latestMs = new Date(latestRun.run_date + 'T12:00:00').getTime();
    const dayMs = 24 * 3600 * 1000;
    const km7 = runs
      .filter(r => (latestMs - new Date(r.run_date + 'T12:00:00').getTime()) <= 7 * dayMs)
      .reduce((a, r) => a + Number(r.distance_km), 0);
    const km14 = runs
      .filter(r => (latestMs - new Date(r.run_date + 'T12:00:00').getTime()) <= 14 * dayMs)
      .reduce((a, r) => a + Number(r.distance_km), 0);
    const km30 = runs
      .filter(r => (latestMs - new Date(r.run_date + 'T12:00:00').getTime()) <= 30 * dayMs)
      .reduce((a, r) => a + Number(r.distance_km), 0);

    const qualRuns = runs.filter(r => Number(r.distance_km) >= 3.0);
    const predPool = qualRuns.length > 0 ? qualRuns : runs;
    const bestPredSec = Math.min(
      ...predPool.map(r => Number(r.duration_sec) * Math.pow(goalKm / Math.max(0.5, Number(r.distance_km)), 1.06))
    );

    telemetrySummary = [
      `- Total Runs Logged: ${runs.length}`,
      `- Total Distance: ${totalKm.toFixed(2)} km`,
      `- Overall Weighted Avg Pace: ${formatPaceDisplay(weightedPaceSec)}/km`,
      `- Overall Avg Heart Rate: ${avgHr} BPM (${getZoneLabel(avgHr)})`,
      `- Longest Run: ${Number(longestRun.distance_km).toFixed(2)} km on ${longestRun.run_date} @ ${longestRun.pace_display}/km (${longestRun.avg_hr} BPM)`,
      `- Fastest Session Pace: ${fastestRun.pace_display}/km (${Number(fastestRun.distance_km).toFixed(2)} km on ${fastestRun.run_date}, ${fastestRun.avg_hr} BPM)`,
      `- Latest Run: ${latestRun.run_date} — ${Number(latestRun.distance_km).toFixed(2)} km @ ${latestRun.pace_display}/km, Avg HR ${latestRun.avg_hr} BPM (${getZoneLabel(Number(latestRun.avg_hr))}), Type: ${latestRun.run_type}${latestRun.notes ? `, Notes: "${latestRun.notes}"` : ''}`,
      `- Rolling Volume (relative to latest run ${latestRun.run_date}): Last 7d = ${km7.toFixed(2)} km (Weekly Goal: ${weeklyGoalKm.toFixed(1)} km), Last 14d = ${km14.toFixed(2)} km, Last 30d = ${km30.toFixed(2)} km`,
      `- Riegel Projected ${goalKm.toFixed(1)}K Finish: ${formatDurationText(bestPredSec)} (${formatPaceDisplay(bestPredSec / goalKm)}/km)`
    ].join('\n');

    runsTable = [
      'Date | Dist (km) | Pace (/km) | Duration | Avg HR (BPM) | HR Zone | Efficiency (m/beat) | Type | Notes',
      '--- | --- | --- | --- | --- | --- | --- | --- | ---',
      ...runs.map(r => {
        const ef = r.pace_sec_per_km > 0 && r.avg_hr > 0 ? (60000 / (r.pace_sec_per_km * r.avg_hr)).toFixed(2) : '--';
        return `${r.run_date} | ${Number(r.distance_km).toFixed(2)} | ${r.pace_display} | ${formatDurationText(r.duration_sec)} | ${r.avg_hr} | ${getZoneLabel(Number(r.avg_hr))} | ${ef} | ${r.run_type} | ${r.notes || '-'}`;
      })
    ].join('\n');
  }

  return [
    `You are the built-in AI Running Coach inside "mmcRUN", a local running telemetry and 10K training tracker.`,
    `Today's Date: ${todayStr}`,
    ``,
    `## Runner's Goal & Physiological Profile`,
    `- Primary Goal Distance: ${goalKm.toFixed(1)} km`,
    `- Goal Target Pace: ${targetPace}/km`,
    `- Goal Target Date: ${targetDate}`,
    `- Weekly Volume Target: ${weeklyGoalKm.toFixed(1)} km/week`,
    `- Max Heart Rate: ${maxHr} BPM | Resting Heart Rate: ${restingHr} BPM (Heart Rate Reserve: ${hrr} BPM)`,
    `- Karvonen HR Zones:`,
    `  * Z1 Recovery: <= ${z1Max} BPM`,
    `  * Z2 Aerobic Base: ${z1Max + 1}–${z2Max} BPM`,
    `  * Z3 Tempo: ${z2Max + 1}–${z3Max} BPM`,
    `  * Z4 Threshold: ${z3Max + 1}–${z4Max} BPM`,
    `  * Z5 VO2Max / Anaerobic: >= ${z4Max + 1} BPM`,
    settings.coach_persona ? `- Runner's Custom Context / Notes: ${settings.coach_persona}` : '',
    ``,
    `## Current Telemetry Summary`,
    telemetrySummary,
    ``,
    `## Complete Chronological Run Log (${runs.length} runs)`,
    runsTable,
    ``,
    `## Coaching Guidelines`,
    `- Ground every piece of advice in the runner's actual logged telemetry above (specific dates, distances, paces, heart rates, HR zones, and aerobic efficiency in meters/beat).`,
    `- Be encouraging, direct, analytical, and practical.`,
    `- Format responses cleanly using Markdown (clear headings, bullet points, bold key metrics, and tables when prescribing workouts or comparing splits).`
  ].filter(Boolean).join('\n');
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    // API Routes
    if (pathname === '/api/state' && req.method === 'GET') {
      return sendJson(res, 200, getAllRunsAndSettings());
    }

    if (pathname === '/api/runs' && req.method === 'GET') {
      const { runs } = getAllRunsAndSettings();
      return sendJson(res, 200, { runs });
    }

    if (pathname === '/api/runs' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const items = Array.isArray(body.runs) ? body.runs : [body];

      const defaultShoe = db.prepare('SELECT id, start_date FROM shoes WHERE is_default = 1 LIMIT 1').get();

      const insertStmt = db.prepare(`
        INSERT INTO runs (run_date, distance_km, pace_sec_per_km, pace_display, avg_hr, duration_sec, run_type, notes, shoe_id, is_demo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `);

      const insertedIds = [];
      db.exec('BEGIN TRANSACTION');
      try {
        for (const item of items) {
          const distanceKm = parseFloat(item.distance_km);
          const paceSec = item.pace_sec_per_km
            ? parseInt(item.pace_sec_per_km, 10)
            : parsePaceToSeconds(item.pace);
          const avgHr = parseInt(item.avg_hr, 10);
          const runDate = (item.run_date || new Date().toISOString().slice(0, 10)).trim();
          const runType = (item.run_type || 'easy').trim();
          const notes = (item.notes || '').trim();

          let shoeId = null;
          if (item.shoe_id !== undefined) {
            const parsedShoe = parseInt(item.shoe_id, 10);
            shoeId = Number.isFinite(parsedShoe) && parsedShoe > 0 ? parsedShoe : null;
          } else if (defaultShoe && runDate >= defaultShoe.start_date) {
            shoeId = Number(defaultShoe.id);
          }

          if (!Number.isFinite(distanceKm) || distanceKm <= 0 || distanceKm > 250) {
            throw new Error('Distance must be between 0.01 and 250 KM.');
          }
          if (!Number.isFinite(paceSec) || paceSec < 90 || paceSec > 1800) {
            throw new Error('Pace must be between 1:30/km and 30:00/km.');
          }
          if (!Number.isFinite(avgHr) || avgHr < 35 || avgHr > 240) {
            throw new Error('Average Heart Rate must be between 35 and 240 BPM.');
          }

          const durationSec = Math.round(distanceKm * paceSec);
          const result = insertStmt.run(
            runDate,
            Math.round(distanceKm * 100) / 100,
            paceSec,
            formatPaceDisplay(paceSec),
            avgHr,
            durationSec,
            runType,
            notes,
            shoeId
          );
          insertedIds.push(Number(result.lastInsertRowid));
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        return sendJson(res, 400, { error: err.message });
      }

      return sendJson(res, 201, {
        ok: true,
        insertedIds,
        ...getAllRunsAndSettings()
      });
    }

    if (pathname.startsWith('/api/runs/') && req.method === 'PUT') {
      const id = parseInt(pathname.split('/')[3], 10);
      if (!Number.isFinite(id)) {
        return sendJson(res, 400, { error: 'Invalid run ID' });
      }
      const item = await readJsonBody(req);
      const distanceKm = parseFloat(item.distance_km);
      const paceSec = item.pace_sec_per_km
        ? parseInt(item.pace_sec_per_km, 10)
        : parsePaceToSeconds(item.pace);
      const avgHr = parseInt(item.avg_hr, 10);
      const runDate = (item.run_date || new Date().toISOString().slice(0, 10)).trim();
      const runType = (item.run_type || 'easy').trim();
      const notes = (item.notes || '').trim();
      const parsedShoe = item.shoe_id !== undefined ? parseInt(item.shoe_id, 10) : NaN;
      const shoeId = Number.isFinite(parsedShoe) && parsedShoe > 0 ? parsedShoe : null;

      if (!Number.isFinite(distanceKm) || distanceKm <= 0 || distanceKm > 250) {
        return sendJson(res, 400, { error: 'Distance must be between 0.01 and 250 KM.' });
      }
      if (!Number.isFinite(paceSec) || paceSec < 90 || paceSec > 1800) {
        return sendJson(res, 400, { error: 'Pace must be between 1:30/km and 30:00/km.' });
      }
      if (!Number.isFinite(avgHr) || avgHr < 35 || avgHr > 240) {
        return sendJson(res, 400, { error: 'Average Heart Rate must be between 35 and 240 BPM.' });
      }

      const durationSec = Math.round(distanceKm * paceSec);
      db.prepare(`
        UPDATE runs
        SET run_date = ?, distance_km = ?, pace_sec_per_km = ?, pace_display = ?,
            avg_hr = ?, duration_sec = ?, run_type = ?, notes = ?, shoe_id = ?, is_demo = 0
        WHERE id = ?
      `).run(
        runDate,
        Math.round(distanceKm * 100) / 100,
        paceSec,
        formatPaceDisplay(paceSec),
        avgHr,
        durationSec,
        runType,
        notes,
        shoeId,
        id
      );

      return sendJson(res, 200, { ok: true, ...getAllRunsAndSettings() });
    }

    if (pathname === '/api/shoes' && req.method === 'GET') {
      return sendJson(res, 200, { shoes: getShoes() });
    }

    if (pathname === '/api/shoes' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim();
      if (!name) {
        return sendJson(res, 400, { error: 'Shoe name is required.' });
      }
      const startDate = String(body.start_date || new Date().toISOString().slice(0, 10)).trim();
      const maxDistKm = Math.max(50, Math.min(5000, parseFloat(body.max_distance_km) || 650));
      const initialKm = Math.max(0, Math.min(5000, parseFloat(body.initial_km) || 0));
      const existingCount = db.prepare('SELECT COUNT(*) as count FROM shoes').get().count;
      const isDefault = body.is_default === true || body.is_default === 1 || existingCount === 0 ? 1 : 0;

      db.exec('BEGIN TRANSACTION');
      try {
        if (isDefault) {
          db.exec('UPDATE shoes SET is_default = 0');
        }
        db.prepare(`
          INSERT INTO shoes (name, start_date, max_distance_km, initial_km, is_default)
          VALUES (?, ?, ?, ?, ?)
        `).run(name, startDate, maxDistKm, initialKm, isDefault);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        return sendJson(res, 400, { error: err.message });
      }

      return sendJson(res, 201, { ok: true, ...getAllRunsAndSettings() });
    }

    if (pathname.startsWith('/api/shoes/') && pathname.endsWith('/default') && req.method === 'PUT') {
      const id = parseInt(pathname.split('/')[3], 10);
      if (!Number.isFinite(id)) {
        return sendJson(res, 400, { error: 'Invalid shoe ID' });
      }
      db.exec('BEGIN TRANSACTION');
      try {
        db.exec('UPDATE shoes SET is_default = 0');
        db.prepare('UPDATE shoes SET is_default = 1 WHERE id = ?').run(id);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        return sendJson(res, 400, { error: err.message });
      }
      return sendJson(res, 200, { ok: true, ...getAllRunsAndSettings() });
    }

    if (pathname.startsWith('/api/shoes/') && req.method === 'DELETE') {
      const id = parseInt(pathname.split('/')[3], 10);
      if (!Number.isFinite(id)) {
        return sendJson(res, 400, { error: 'Invalid shoe ID' });
      }
      db.exec('BEGIN TRANSACTION');
      try {
        const target = db.prepare('SELECT is_default FROM shoes WHERE id = ?').get(id);
        db.prepare('UPDATE runs SET shoe_id = NULL WHERE shoe_id = ?').run(id);
        db.prepare('DELETE FROM shoes WHERE id = ?').run(id);
        if (target && target.is_default === 1) {
          const nextShoe = db.prepare('SELECT id FROM shoes ORDER BY id DESC LIMIT 1').get();
          if (nextShoe) {
            db.prepare('UPDATE shoes SET is_default = 1 WHERE id = ?').run(nextShoe.id);
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        return sendJson(res, 400, { error: err.message });
      }
      return sendJson(res, 200, { ok: true, ...getAllRunsAndSettings() });
    }

    if (pathname === '/api/runs/demo' && req.method === 'DELETE') {
      db.exec('DELETE FROM runs WHERE is_demo = 1');
      return sendJson(res, 200, { ok: true, ...getAllRunsAndSettings() });
    }

    if (pathname === '/api/runs/all' && req.method === 'DELETE') {
      db.exec('DELETE FROM runs');
      return sendJson(res, 200, { ok: true, ...getAllRunsAndSettings() });
    }

    if (pathname === '/api/runs/seed' && req.method === 'POST') {
      seedDemoRunsIfNeeded(true);
      return sendJson(res, 200, { ok: true, ...getAllRunsAndSettings() });
    }

    if (pathname.startsWith('/api/runs/') && req.method === 'DELETE') {
      const id = parseInt(pathname.split('/')[3], 10);
      if (!Number.isFinite(id)) {
        return sendJson(res, 400, { error: 'Invalid run ID' });
      }
      db.prepare('DELETE FROM runs WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true, ...getAllRunsAndSettings() });
    }

    if (pathname === '/api/settings' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const upsert = db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      db.exec('BEGIN TRANSACTION');
      try {
        for (const [k, v] of Object.entries(body)) {
          if (k in defaultSettings && v !== undefined && v !== null) {
            upsert.run(k, String(v).trim());
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        return sendJson(res, 400, { error: err.message });
      }
      return sendJson(res, 200, { ok: true, ...getAllRunsAndSettings() });
    }

    if (pathname === '/api/coach' && req.method === 'GET') {
      const { runs, settings } = getAllRunsAndSettings();
      const rawSettings = getRawSettings();
      const activeKey = getEnvApiKey();
      const savedModel = (rawSettings.gemini_model === 'gemini-2.5-flash' || !rawSettings.gemini_model)
        ? 'gemini-3-flash-preview'
        : rawSettings.gemini_model;
      return sendJson(res, 200, {
        runs,
        settings,
        messages: getCoachMessages(),
        coachConfig: {
          hasApiKey: Boolean(activeKey),
          maskedKey: maskApiKey(activeKey),
          keySource: activeKey ? 'env' : 'none',
          model: savedModel,
          coachPersona: rawSettings.coach_persona || ''
        }
      });
    }

    if (pathname === '/api/coach/config' && req.method === 'PUT') {
      const body = await readJsonBody(req);
      const upsert = db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      db.exec('BEGIN TRANSACTION');
      try {
        if (typeof body.apiKey === 'string') {
          const trimmedKey = body.apiKey.trim();
          // Allow clearing if explicitly requested or updating when not masked
          if (body.clearKey === true) {
            setEnvApiKey('');
          } else if (trimmedKey && !trimmedKey.includes('••••')) {
            setEnvApiKey(trimmedKey);
          }
        }
        if (typeof body.model === 'string' && body.model.trim()) {
          upsert.run('gemini_model', body.model.trim());
        }
        if (typeof body.coachPersona === 'string') {
          upsert.run('coach_persona', body.coachPersona.trim());
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        return sendJson(res, 400, { error: err.message });
      }

      const rawSettings = getRawSettings();
      const activeKey = getEnvApiKey();
      return sendJson(res, 200, {
        ok: true,
        coachConfig: {
          hasApiKey: Boolean(activeKey),
          maskedKey: maskApiKey(activeKey),
          keySource: activeKey ? 'env' : 'none',
          model: rawSettings.gemini_model || 'gemini-3-flash-preview',
          coachPersona: rawSettings.coach_persona || ''
        }
      });
    }

    if (pathname === '/api/coach/messages' && req.method === 'DELETE') {
      db.exec('DELETE FROM coach_messages');
      return sendJson(res, 200, { ok: true, messages: [] });
    }

    if (pathname === '/api/coach/chat' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const userPrompt = String(body.message || '').trim();
      if (!userPrompt) {
        return sendJson(res, 400, { error: 'Message cannot be empty.' });
      }

      const rawSettings = getRawSettings();
      const apiKey = getEnvApiKey();
      if (!apiKey) {
        return sendJson(res, 400, {
          error: 'Gemini API Key is not configured. Click "API KEY & PROFILE" to add your key.'
        });
      }

      let selectedModel = (body.model || rawSettings.gemini_model || 'gemini-3-flash-preview').trim();
      if (selectedModel === 'gemini-2.5-flash') {
        selectedModel = 'gemini-3-flash-preview';
      }
      if (selectedModel !== rawSettings.gemini_model) {
        db.prepare(`
          INSERT INTO settings (key, value) VALUES ('gemini_model', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(selectedModel);
      }

      const { runs } = getAllRunsAndSettings();
      const systemInstruction = buildCoachSystemInstruction(runs, rawSettings);
      const priorMessages = getCoachMessages().slice(-24);

      const contents = [
        ...priorMessages.map(m => ({
          role: m.role === 'model' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
        {
          role: 'user',
          parts: [{ text: userPrompt }]
        }
      ];

      async function callGeminiModel(modelName) {
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const res = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: systemInstruction }]
            },
            contents,
            generationConfig: {
              temperature: 0.65,
              maxOutputTokens: 4096
            }
          })
        });
        const data = await res.json().catch(() => ({}));
        return { res, data, modelName };
      }

      let { res: geminiRes, data: geminiData, modelName: usedModel } = await callGeminiModel(selectedModel);
      if (!geminiRes.ok && (geminiRes.status === 404 || geminiRes.status === 503) && selectedModel !== 'gemini-3-flash-preview') {
        ({ res: geminiRes, data: geminiData, modelName: usedModel } = await callGeminiModel('gemini-3-flash-preview'));
      }
      selectedModel = usedModel;
      if (!geminiRes.ok) {
        const apiErrMsg =
          geminiData?.error?.message ||
          `Gemini API returned HTTP ${geminiRes.status}`;
        return sendJson(res, 502, {
          error: apiErrMsg
        });
      }

      const replyParts = geminiData?.candidates?.[0]?.content?.parts || [];
      const replyText = replyParts
        .map(p => p.text || '')
        .join('')
        .trim();

      if (!replyText) {
        return sendJson(res, 502, {
          error: 'Gemini returned an empty response. Please try again.'
        });
      }

      const insertMsg = db.prepare(`
        INSERT INTO coach_messages (role, content, model)
        VALUES (?, ?, ?)
      `);
      db.exec('BEGIN TRANSACTION');
      try {
        insertMsg.run('user', userPrompt, selectedModel);
        insertMsg.run('model', replyText, selectedModel);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      return sendJson(res, 200, {
        ok: true,
        messages: getCoachMessages()
      });
    }

    // Static file serving
    let safePath = path.normalize(decodeURIComponent(pathname)).replace(/^(\.\.(\/|\\|$))+/, '');
    if (safePath === '/' || safePath === '') {
      safePath = '/index.html';
    } else if (safePath === '/dashboard' || safePath === '/dashboard/') {
      safePath = '/dashboard.html';
    } else if (safePath === '/coach' || safePath === '/coach/') {
      safePath = '/coach.html';
    }
    const filePath = path.join(__dirname, safePath);

    // Ensure file is inside project directory and block dotfiles / database files
    const relSegments = path.relative(__dirname, filePath).split(path.sep);
    if (
      !filePath.startsWith(__dirname) ||
      relSegments.some(seg => seg.startsWith('.')) ||
      /\.(db|db-shm|db-wal)$/i.test(filePath)
    ) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Forbidden');
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const cacheHeader = ext === '.woff2' || ext === '.png' || ext === '.ico'
      ? 'public, max-age=31536000, immutable'
      : 'no-cache';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheHeader
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error('Server error:', err);
    sendJson(res, 500, { error: err.message || 'Internal Server Error' });
  }
});

server.listen(PORT, () => {
  console.log(`mmcRUN loaded at http://localhost:${PORT}`);
  console.log(`SQLite3 database persisted at: ${DB_PATH}`);
});
