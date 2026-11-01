# mmcRUN — Run Telemetry & Gemini AI Coach

A zero-dependency, local-first **running telemetry tracker, analytics dashboard, and Gemini AI running coach** built on Node.js (`node:http` + `node:sqlite`), `uPlot`, and a crisp **Tokyo Night** UI with self-hosted `JetBrains Mono` typography.

---

## Features

### 1. Telemetry Logger, Personal Records & uPlot Analytics (`/`)
- **Run Logging & Editing**: Log individual runs (`date`, `distance_km`, `pace`, `avg_hr`, `run_type`, `shoe_id`, `notes`) with real-time duration, speed (`km/h`), and Karvonen heart-rate zone previews.
- **Shoe Distance (`km`) Tracker**: Track cumulative mileage, run count, start date, and lifespan wear (`%` of target `km`) across your running shoes (pre-seeded with **ASICS**). Easily add new shoes, set the active default shoe for new runs, or remove retired shoes.
- **Strava-Style Personal Records (`PRs`) & All-Time Podium**:
  - Dedicated **Personal Records** summary card displaying your top **Fastest 5K**, **Best Pace**, and **Best Aerobic Efficiency** records with custom trophy icons.
  - Expandable **All-Time Podium Modal (`ALL-TIME PRs`)** showcasing **1st (Gold)**, **2nd (Silver)**, and **3rd (Bronze)** trophy placements across 7 categories: *Fastest 3K*, *Fastest 5K*, *Fastest 7.5K*, *Fastest 10K*, *Longest Single Run*, *Fastest Session Pace*, and *Peak Aerobic Efficiency*.
  - Automatic **New PR Celebration Toast** whenever a newly logged run claims #1 in any category.
- **Batch Past-Run Importer**: Paste or enter multiple historical runs at once (`+ PAST RUNS`).
- **Interactive `uPlot` Charts** (defaults to `PACE vs HR` over `LAST 7` runs on load):
  - **Pace vs. Heart Rate (`PACE vs HR`)**: Avg Pace (`/km`), Target 10K Pace reference, and Avg Heart Rate (`BPM`).
  - **10K Distance Progression (`10K DISTANCE`)**: Per-run distance, 3-run rolling average, and 10K goal target line.
  - **Aerobic Efficiency (`AEROBIC EF`)**: Meters traveled per heartbeat (`m/beat`) alongside average speed (`km/h`).
  - **All Metrics (`ALL METRICS`)**: Combined multi-axis overlay across `LAST 7`, `LAST 15`, or `ALL RUNS`.
- **Data Portability**: Export full JSON backups of your telemetry and settings.

### 2. Full-Viewport Big-Numbers Dashboard (`/dashboard`)
- **8 Hero Telemetry Tiles**:
  1. **Total Distance** (cumulative km, average distance per session, first/latest run dates)
  2. **10KM Goal Progress** (longest run vs. 10K target, readiness score, next step-up long run)
  3. **Overall Avg Pace** (weighted pace `/km`, average speed `km/h`, fastest vs. easy pace range)
  4. **Average Heart Rate** (dominant Karvonen HR zone, min/max BPM range, aerobic efficiency)
  5. **Total Time on Feet** (cumulative hours/minutes, average session duration, estimated kcal)
  6. **Fastest 5K Record** (best 5.00 km split, pace, date, and qualifying 5K+ run count)
  7. **Estimated 10K Finish** (Riegel `T2 = T1 × (D2 / D1)^1.06` race projection vs. target pace)
  8. **Latest Logged Run** (distance, pace, heart rate, duration, and efficiency snapshot)
- **Physiological & Volume Breakdown Strips**:
  - **Rolling Training Volume** (Last 7-day, 14-day, and 30-day kilometer totals vs. weekly target).
  - **Karvonen Heart Rate Zone Distribution** (`Z1 Recovery` through `Z5 VO2Max`) calculated from your configured `Max HR` and `Resting HR`.
  - **Recent Runs Distance Skyline** (visual bar skyline of your last 10 sessions against the 10K goal).

### 3. Gemini AI Run Coach (`/coach`)
- **Automatic Telemetry Injection**: Every prompt sent to Gemini automatically includes a live system instruction containing your physiological profile, Karvonen HR zones, rolling 7d/14d/30d volume, Riegel 10K projection, and your complete chronological run log from SQLite.
- **One-Click Coaching Presets**:
  - *01 // Analyze Latest Run*
  - *02 // Next Workout Prescription*
  - *03 // Build 7-Day Training Schedule*
  - *04 // Aerobic Base & HR Zone Audit*
  - *05 // 10K Goal Readiness & Race Plan*
- **Adjustable Composer Height**: Switch between `1X`, `2X (DOUBLE)`, and `3X (TALL)` input heights (or drag-resize vertically) for longer, detailed training questions.
- **Persistent Conversation History**: Chat history (with local timezone timestamps) and custom runner persona are stored locally in `mmcruns.db`.

---

## Tech Stack & Architecture

- **Runtime**: Node.js `>= 22.5.0` (uses built-in `node:sqlite`, `node:http`, `node:fs`, and native `fetch` — zero `npm` runtime dependencies).
- **Database**: Local SQLite3 database (`mmcruns.db`) in `WAL` mode with four tables:
  - `runs` — chronological run telemetry records (including optional `shoe_id` attribution)
  - `shoes` — running shoe roster (`name`, `start_date`, `max_distance_km`, `initial_km`, `is_default`)
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
├── index.html         # Main run logger, 10K readiness, shoe tracker, PRs & uPlot workspace
├── app.js             # Frontend state, uPlot chart rendering, PR podium, shoe tracker & modals
├── dashboard.html     # Full-window 8-tile executive running statistics dashboard
├── coach.html         # Dedicated Gemini AI Run Coach workspace & Markdown chat interface
├── styles.css         # Tokyo Night theme tokens, responsive layouts & component styles
├── sw.js              # PWA service worker for offline-capable app shell & font caching
├── manifest.json      # Web App Manifest for desktop/mobile installation
├── mmcruns.db         # Local SQLite3 database (runs, shoes, settings, coach_messages)
├── .env               # Local git-ignored file storing GEMINI_API_KEY
├── fonts/             # Self-hosted JetBrains Mono WOFF2 font files
├── icons/             # App favicons and PWA icons
└── vendor/            # Local uPlot charting library (uPlot.iife.min.js & uPlot.min.css)
```

---

## REST API Reference

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/state` | Returns all logged `runs`, `settings`, and `shoes` |
| `GET` | `/api/runs` | Returns all logged `runs` ordered chronologically |
| `POST` | `/api/runs` | Logs a single run or batch of runs (`{ runs: [...] }`) |
| `PUT` | `/api/runs/:id` | Updates an existing run by ID |
| `DELETE` | `/api/runs/:id` | Deletes a single run by ID |
| `DELETE` | `/api/runs/demo` | Clears demo seed runs (`is_demo = 1`) |
| `DELETE` | `/api/runs/all` | Deletes all runs |
| `POST` | `/api/runs/seed` | Reseeds sample 10K training block runs |
| `GET` | `/api/shoes` | Returns all tracked running shoes |
| `POST` | `/api/shoes` | Adds a new pair of running shoes to the distance tracker |
| `PUT` | `/api/shoes/:id/default` | Sets a shoe as the active default for new runs |
| `DELETE` | `/api/shoes/:id` | Removes a shoe from the distance tracker |
| `PUT` | `/api/settings` | Updates goal distance, target pace/date, weekly volume, or HR profile |
| `GET` | `/api/coach` | Returns runs, settings, coach chat history, and masked key status |
| `PUT` | `/api/coach/config` | Saves `GEMINI_API_KEY` to `.env`, default Gemini model, and runner persona |
| `POST` | `/api/coach/chat` | Sends a prompt + live SQLite telemetry context to Gemini and stores the reply |
| `DELETE` | `/api/coach/messages` | Clears the AI Coach conversation history |
