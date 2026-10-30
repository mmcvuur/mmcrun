# mmcRUN — Run Telemetry & Gemini AI Coach

A zero-dependency, local-first **10K running telemetry tracker, analytics dashboard, and Gemini AI running coach** built on Node.js (`node:http` + `node:sqlite`), `uPlot`, and a crisp **Tokyo Night** UI with self-hosted `JetBrains Mono` typography.

---

## Features

### 1. Telemetry Logger & uPlot Analytics (`/`)
- **Run Logging & Editing**: Log individual runs (`date`, `distance_km`, `pace`, `avg_hr`, `run_type`, `notes`) with real-time duration, speed (`km/h`), and Karvonen heart-rate zone previews.
- **Batch Past-Run Importer**: Paste or enter multiple historical runs at once (`+ PAST RUNS`).
- **Interactive `uPlot` Charts**:
  - **Distance & Rolling Volume**: Per-run distance vs. 10K target, 7-day rolling volume, and cumulative build.
  - **Pace Progression**: Per-run pace (`/km`) vs. target pace and rolling average trend.
  - **Heart Rate & Aerobic Efficiency**: Average HR (`BPM`) and aerobic efficiency factor (`meters/beat`).
  - **Pace vs. Heart Rate Scatter**: Correlation across session types and HR zones.
- **Data Portability**: Export/import full JSON backups and CSV tables.

### 2. Full-Viewport Big-Numbers Dashboard (`/dashboard`)
- **8 Hero Telemetry Tiles**:
  1. **Cumulative Distance** (30-day volume, weekly average, active span)
  2. **Total Sessions Logged** (consistency, run frequency, longest streak)
  3. **Overall Weighted Pace** (speed in `km/h`, fastest session, target delta)
  4. **Heart Rate & Aerobic Efficiency** (avg HR, Karvonen zone, `meters/beat` trend)
  5. **Longest Single Run** (progress toward 10.0 km milestone, duration)
  6. **10K Race Readiness & Riegel Projection** (`T2 = T1 × (D2 / D1)^1.06` projected finish time)
  7. **Total Time on Feet** (cumulative duration, avg session time, estimated kcal)
  8. **Rolling Volume & Load** (last 7-day, 14-day, and 30-day kilometer totals vs. weekly target)
- ** physiological Breakdown Strips**:
  - **Karvonen Heart Rate Zone Distribution** (`Z1 Recovery` through `Z5 VO2Max`) calculated from your configured `Max HR` and `Resting HR`.
  - **Session Type Mix** (`Easy`, `Long`, `Tempo`, `Intervals`, `Recovery`, `Race`).
  - **Personal Records & Milestones** (10K progress bar, best efficiency run, peak weekly volume).

### 3. Gemini AI Run Coach (`/coach`)
- **Automatic Telemetry Injection**: Every prompt sent to Gemini automatically includes a live system instruction containing your physiological profile, Karvonen HR zones, rolling 7d/14d/30d volume, Riegel 10K projection, and your complete chronological run log from SQLite.
- **One-Click Coaching Presets**:
  - *01 // Analyze Latest Run*
  - *02 // Next Workout Prescription*
  - *03 // Build 7-Day Training Schedule*
  - *04 // Aerobic Base & HR Zone Audit*
  - *05 // 10K Goal Readiness & Race Plan*
- **Adjustable Composer Height**: Switch between `1X`, `2X (DOUBLE)`, and `3X (TALL)` input heights (or drag-resize vertically) for longer, detailed training questions.
- **Persistent Conversation History**: Chat history and runner persona are stored locally in `mmcruns.db`.

---

## Tech Stack & Architecture

- **Runtime**: Node.js `>= 22.5.0` (uses built-in `node:sqlite`, `node:http`, `node:fs`, and native `fetch` — zero `npm` runtime dependencies).
- **Database**: Local SQLite3 database (`mmcruns.db`) in `WAL` mode with three tables:
  - `runs` — chronological run telemetry records
  - `settings` — training goals (`goal_distance_km`, `goal_target_pace`, `goal_target_date`, `weekly_goal_km`), physiological parameters (`max_hr`, `resting_hr`), default Gemini model, and custom runner persona
  - `coach_messages` — persistent AI coach conversation log
- **Frontend**: Vanilla ES6+, CSS custom properties (`Tokyo Night` palette), [`uPlot`](https://github.com/leeoniya/uPlot) canvas charting, and PWA Service Worker (`sw.js`) for offline asset caching.

---

## Getting Started

### 1. Prerequisites
Ensure you have **Node.js v22.5.0 or newer** installed (required for the built-in `node:sqlite` module):
```bash
node -v
```

### 2. Configure Your Gemini API Key (`.env`)
Create a `.env` file in the project root (or set the key directly inside the `/coach` UI via **API KEY & PROFILE**):
```ini
GEMINI_API_KEY=your_google_ai_studio_api_key
```
> `.env` is git-ignored so your API key is never committed to version control or stored inside `mmcruns.db`.

### 3. Start the Server
```bash
npm start
# or directly:
node server.js
```
Then open:
- **Telemetry & Charts**: [http://localhost:3000/](http://localhost:3000/)
- **Big-Stats Dashboard**: [http://localhost:3000/dashboard](http://localhost:3000/dashboard)
- **Gemini AI Run Coach**: [http://localhost:3000/coach](http://localhost:3000/coach)

*(Override the default port at any time with `PORT=8080 node server.js`.)*

---

## Project Structure

```text
.
├── server.js          # Node.js HTTP server, REST API, SQLite3 schema & Gemini API integration
├── index.html         # Main run logger, 10K readiness card & uPlot telemetry workspace
├── app.js             # Frontend state, uPlot chart rendering, Karvonen/Riegel math & modals
├── dashboard.html     # Full-window 8-tile executive running statistics dashboard
├── coach.html         # Dedicated Gemini AI Run Coach workspace & Markdown chat interface
├── styles.css         # Tokyo Night theme tokens, responsive layouts & component styles
├── sw.js              # PWA service worker for offline-capable app shell & font caching
├── manifest.json      # Web App Manifest for desktop/mobile installation
├── mmcruns.db         # Local SQLite3 database (runs, settings, coach_messages)
├── .env               # Local git-ignored file storing GEMINI_API_KEY
├── fonts/             # Self-hosted JetBrains Mono WOFF2 font files
├── icons/             # App favicons and PWA icons
└── vendor/            # Local uPlot charting library (uPlot.iife.min.js & uPlot.min.css)
```

---

## REST API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/state` | Returns all logged `runs` and `settings` |
| `GET` | `/api/runs` | Returns all logged `runs` ordered chronologically |
| `POST` | `/api/runs` | Logs a single run or batch of runs (`{ runs: [...] }`) |
| `PUT` | `/api/runs/:id` | Updates an existing run by ID |
| `DELETE` | `/api/runs/:id` | Deletes a single run by ID |
| `DELETE` | `/api/runs/demo` | Clears demo seed runs (`is_demo = 1`) |
| `DELETE` | `/api/runs/all` | Deletes all runs |
| `POST` | `/api/runs/seed` | Reseeds sample 10K training block runs |
| `PUT` | `/api/settings` | Updates goal distance, target pace/date, weekly volume, or HR profile |
| `GET` | `/api/coach` | Returns runs, settings, coach chat history, and masked key status |
| `PUT` | `/api/coach/config` | Saves `GEMINI_API_KEY` to `.env`, default Gemini model, and runner persona |
| `POST` | `/api/coach/chat` | Sends a prompt + live SQLite telemetry context to Gemini and stores the reply |
| `DELETE` | `/api/coach/messages` | Clears the AI Coach conversation history |
