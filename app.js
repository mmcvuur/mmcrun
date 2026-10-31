/* ==========================================================================
   STRIDE // 10K — TOKYO NIGHT RUN TELEMETRY APPLICATION (SQLite3 + uPlot)
   ========================================================================== */

(function () {
  'use strict';

  // Application State
  const state = {
    runs: [],
    shoes: [],
    settings: {
      goal_distance_km: '10.0',
      goal_target_pace: '5:20',
      goal_target_date: '2026-12-06',
      weekly_goal_km: '24.0',
      max_hr: '162',
      resting_hr: '56'
    },
    chartMode: 'pace_hr',    // 'combined' | 'distance' | 'pace_hr' | 'efficiency'
    chartRange: '7',         // '7' | '15' | 'all'
    filterType: 'all',
    mobileTab: 'dashboard',
    uplotInstance: null
  };

  // Tokyo Night Palette for Canvas / uPlot
  // Note: uPlot requires an integer px font size (e.g., 11px) for devicePixelRatio scaling
  const COLORS = {
    blue: '#7aa2f7',
    blueFill: 'rgba(122, 162, 247, 0.18)',
    cyan: '#7dcfff',
    cyanFill: 'rgba(125, 207, 255, 0.14)',
    purple: '#bb9af7',
    purpleFill: 'rgba(187, 154, 247, 0.14)',
    red: '#f7768e',
    redFill: 'rgba(247, 118, 142, 0.14)',
    green: '#9ece6a',
    greenFill: 'rgba(158, 206, 106, 0.15)',
    orange: '#ff9e64',
    yellow: '#e0af68',
    grid: 'rgba(59, 66, 97, 0.42)',
    axisText: '#9aa5ce',
    font: '600 11px "JetBrains Mono", monospace'
  };

  // ==========================================================================
  // UTILITY & TELEMETRY MATH HELPERS
  // ==========================================================================

  function parsePaceToSeconds(paceInput) {
    if (typeof paceInput === 'number' && Number.isFinite(paceInput)) {
      return paceInput > 45 ? Math.round(paceInput) : Math.round(paceInput * 60);
    }
    const str = String(paceInput || '').trim();
    if (!str) return 0;
    if (str.includes(':')) {
      const [m, s] = str.split(':');
      const mins = parseInt(m, 10) || 0;
      const secs = parseInt(s, 10) || 0;
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

  function formatPace(secPerKm) {
    if (!Number.isFinite(secPerKm) || secPerKm <= 0) return '--:--';
    const mins = Math.floor(secPerKm / 60);
    const secs = Math.round(secPerKm % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function formatDuration(totalSec) {
    if (!Number.isFinite(totalSec) || totalSec <= 0) return '--:--';
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = Math.round(totalSec % 60);
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }

  function formatTotalHours(totalSec) {
    if (!Number.isFinite(totalSec) || totalSec <= 0) return '0h 00m';
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.round((totalSec % 3600) / 60);
    return `${hrs}h ${String(mins).padStart(2, '0')}m`;
  }

  // Meters traveled per heartbeat: higher = better aerobic fitness
  function calcMetersPerBeat(paceSecPerKm, avgHr) {
    if (!paceSecPerKm || !avgHr || paceSecPerKm <= 0 || avgHr <= 0) return 0;
    const speedMetersPerMin = 1000 / (paceSecPerKm / 60);
    return speedMetersPerMin / avgHr;
  }

  // Riegel race formula: T2 = T1 * (D2 / D1)^1.06
  function predict10kSeconds(distanceKm, durationSec, goalKm = 10.0) {
    if (!distanceKm || !durationSec || distanceKm < 1.5) return 0;
    return Math.round(durationSec * Math.pow(goalKm / distanceKm, 1.06));
  }

  function getHrZoneThresholds(maxHr = 162, restingHr = 56) {
    const mHr = Number.isFinite(maxHr) && maxHr > 100 ? maxHr : 162;
    const rHr = Number.isFinite(restingHr) && restingHr >= 30 && restingHr < mHr - 20 ? restingHr : 56;
    const hrr = mHr - rHr;
    return {
      z1Max: Math.round(rHr + 0.745 * hrr), // 135 bpm @ 162/56
      z2Max: Math.round(rHr + 0.850 * hrr), // 146 bpm @ 162/56
      z3Max: Math.round(rHr + 0.915 * hrr), // 153 bpm @ 162/56
      z4Max: Math.round(rHr + 0.962 * hrr)  // 158 bpm @ 162/56
    };
  }

  function getHrZoneInfo(hr, maxHr = 162, restingHr = 56) {
    const t = getHrZoneThresholds(maxHr, restingHr);
    if (hr <= t.z1Max) return { zone: 1, name: 'Z1 Recovery', color: COLORS.cyan };
    if (hr <= t.z2Max) return { zone: 2, name: 'Z2 Aerobic', color: COLORS.green };
    if (hr <= t.z3Max) return { zone: 3, name: 'Z3 Tempo', color: COLORS.blue };
    if (hr <= t.z4Max) return { zone: 4, name: 'Z4 Threshold', color: COLORS.purple };
    return { zone: 5, name: 'Z5 Anaerobic', color: COLORS.red };
  }

  function formatShortDate(dateStr) {
    if (!dateStr) return '--';
    const parts = dateStr.split('-');
    if (parts.length !== 3) return dateStr;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const m = parseInt(parts[1], 10) - 1;
    return `${months[m] || parts[1]} ${parseInt(parts[2], 10)}`;
  }

  function showToast(msg) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 3200);
  }

  // ==========================================================================
  // API & SQLITE3 PERSISTENCE LAYER
  // ==========================================================================

  async function apiRequest(url, options = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  async function loadInitialState() {
    const statusText = document.getElementById('dbStatusText');
    try {
      const data = await apiRequest('/api/state');
      state.runs = data.runs || [];
      state.shoes = data.shoes || [];
      state.settings = { ...state.settings, ...(data.settings || {}) };
      localStorage.setItem('stride_backup_state', JSON.stringify(data));
      if (statusText) statusText.textContent = 'SQLITE3 SYNCED';
    } catch (err) {
      console.warn('Using local offline backup:', err);
      const cached = localStorage.getItem('stride_backup_state');
      if (cached) {
        const parsed = JSON.parse(cached);
        state.runs = parsed.runs || [];
        state.shoes = parsed.shoes || [];
        state.settings = { ...state.settings, ...(parsed.settings || {}) };
      }
      if (statusText) statusText.textContent = 'OFFLINE CACHE';
    }
    renderAll();
  }

  // ==========================================================================
  // RENDERING ALL UI SECTIONS
  // ==========================================================================

  function renderAll() {
    renderDemoBanner();
    renderStatsAnd10kMission();
    renderHrZonesAndPRs();
    renderShoesTracker();
    renderHistoryTable();
    renderChart();
    updateLiveFormPreview();
  }

  function renderDemoBanner() {
    const hasDemo = state.runs.some(r => Number(r.is_demo) === 1);
    const banner = document.getElementById('demoBanner');
    if (banner) {
      banner.classList.toggle('hidden', !hasDemo);
    }
  }

  function renderStatsAnd10kMission() {
    const runs = state.runs;
    const goalKm = parseFloat(state.settings.goal_distance_km) || 10.0;
    const weeklyGoalKm = parseFloat(state.settings.weekly_goal_km) || 24.0;

    // Header & Mission Goal Labels
    document.getElementById('headerGoalDist').textContent = `${goalKm.toFixed(1)} KM`;
    document.getElementById('missionTargetKm').textContent = goalKm.toFixed(1);
    document.getElementById('missionWeeklyGoal').textContent = weeklyGoalKm.toFixed(1);

    if (runs.length === 0) {
      document.getElementById('headerGoalPct').textContent = '0%';
      document.getElementById('headerGoalRemaining').textContent = `${goalKm.toFixed(2)} km to go`;
      document.getElementById('headerGoalFill').style.width = '0%';

      document.getElementById('kpiTotalKm').innerHTML = `0.00 <small>KM</small>`;
      document.getElementById('kpiTotalRuns').textContent = '0 runs logged';
      document.getElementById('kpiAvgPace').innerHTML = `--:-- <small>/KM</small>`;
      document.getElementById('kpiBestPace').textContent = 'Best: --:-- /km';
      document.getElementById('kpiAvgHr').innerHTML = `--- <small>BPM</small>`;
      document.getElementById('kpiHrRange').textContent = 'Min -- / Max -- bpm';
      document.getElementById('kpiLongestRun').innerHTML = `0.00 <small>KM</small>`;
      document.getElementById('kpiLongestDate').textContent = `Goal: ${goalKm.toFixed(2)} KM`;
      document.getElementById('kpiEfficiency').innerHTML = `-- <small>M/B</small>`;
      document.getElementById('kpiEfficiencyTrend').textContent = 'Meters per heartbeat';
      document.getElementById('kpiTotalTime').textContent = '0h 00m';
      document.getElementById('kpiAvgSpeed').textContent = 'Avg speed: 0.0 km/h';

      document.getElementById('missionLongestKm').textContent = '0.00';
      document.getElementById('missionLongestPctTag').textContent = '0%';
      document.getElementById('missionLongestBar').style.width = '0%';
      document.getElementById('missionDistanceLeft').textContent = `${goalKm.toFixed(2)} KM to go`;
      document.getElementById('missionPred10kTime').textContent = '--:--';
      document.getElementById('missionPredPaceTag').textContent = '10K';
      document.getElementById('missionPredMeta').textContent = 'Pace: --:-- /km';
      document.getElementById('missionPredBar').style.width = '0%';
      document.getElementById('missionPred10kPace').textContent = 'Log a run >= 2km';
      document.getElementById('missionWeeklyKm').textContent = '0.0';
      document.getElementById('missionWeeklyPctTag').textContent = '0%';
      document.getElementById('missionWeeklyBar').style.width = '0%';
      document.getElementById('missionWeeklySub').textContent = `${weeklyGoalKm.toFixed(1)} KM left`;
      document.getElementById('missionNextLongRun').textContent = '3.00';
      document.getElementById('missionNextPctTag').textContent = '30%';
      document.getElementById('missionNextBar').style.width = '30%';
      document.getElementById('readinessBadge').textContent = 'READINESS: 0%';

      document.querySelectorAll('#milestoneLadder .milestone-step').forEach(step => {
        step.classList.remove('achieved');
      });
      return;
    }

    const totalKm = runs.reduce((acc, r) => acc + Number(r.distance_km), 0);
    const totalSec = runs.reduce((acc, r) => acc + Number(r.duration_sec), 0);
    const weightedPaceSec = totalKm > 0 ? totalSec / totalKm : 0;
    const avgHr = Math.round(runs.reduce((acc, r) => acc + Number(r.avg_hr), 0) / runs.length);
    const minHr = Math.min(...runs.map(r => Number(r.avg_hr)));
    const maxHrObs = Math.max(...runs.map(r => Number(r.avg_hr)));

    let longestRun = runs[0];
    let fastestPaceRun = runs[0];
    for (const r of runs) {
      if (Number(r.distance_km) > Number(longestRun.distance_km)) longestRun = r;
      if (Number(r.pace_sec_per_km) < Number(fastestPaceRun.pace_sec_per_km)) fastestPaceRun = r;
    }

    const longestKm = Number(longestRun.distance_km);
    const goalPct = Math.min(100, Math.round((longestKm / goalKm) * 100));
    const remainingKm = Math.max(0, goalKm - longestKm);

    // Header 10K Goal Bar
    document.getElementById('headerGoalPct').textContent = `${goalPct}%`;
    document.getElementById('headerGoalRemaining').textContent =
      remainingKm <= 0 ? '10KM GOAL ACHIEVED!' : `${remainingKm.toFixed(2)} km to 10K goal`;
    document.getElementById('headerGoalFill').style.width = `${goalPct}%`;

    // Aerobic Efficiency & Trend
    const efValues = runs.map(r => calcMetersPerBeat(r.pace_sec_per_km, r.avg_hr));
    const avgEf = efValues.reduce((a, b) => a + b, 0) / efValues.length;
    let efTrendText = 'Meters / beat';
    if (efValues.length >= 4) {
      const half = Math.floor(efValues.length / 2);
      const firstHalf = efValues.slice(0, half).reduce((a, b) => a + b, 0) / half;
      const secondHalf = efValues.slice(half).reduce((a, b) => a + b, 0) / (efValues.length - half);
      const diffPct = ((secondHalf - firstHalf) / firstHalf) * 100;
      const sign = diffPct >= 0 ? '+' : '';
      efTrendText = `${sign}${diffPct.toFixed(1)}% trend`;
    }

    const avgSpeedKmh = totalSec > 0 ? (totalKm / (totalSec / 3600)) : 0;

    // Populate 6 KPI Cards
    document.getElementById('kpiTotalKm').innerHTML = `${totalKm.toFixed(2)} <small>KM</small>`;
    document.getElementById('kpiTotalRuns').textContent = `${runs.length} runs (${(totalKm / runs.length).toFixed(1)}k)`;
    document.getElementById('kpiAvgPace').innerHTML = `${formatPace(weightedPaceSec)} <small>/KM</small>`;
    document.getElementById('kpiBestPace').textContent = `Best ${formatPace(fastestPaceRun.pace_sec_per_km)}/km`;
    document.getElementById('kpiAvgHr').innerHTML = `${avgHr} <small>BPM</small>`;
    document.getElementById('kpiHrRange').textContent = `${minHr}–${maxHrObs} bpm`;
    document.getElementById('kpiLongestRun').innerHTML = `${longestKm.toFixed(2)} <small>KM</small>`;
    document.getElementById('kpiLongestDate').textContent = `${goalPct}% • ${formatShortDate(longestRun.run_date)}`;
    document.getElementById('kpiEfficiency').innerHTML = `${avgEf.toFixed(2)} <small>M/B</small>`;
    document.getElementById('kpiEfficiencyTrend').textContent = efTrendText;
    document.getElementById('kpiTotalTime').textContent = formatTotalHours(totalSec);
    document.getElementById('kpiAvgSpeed').textContent = `Avg ${avgSpeedKmh.toFixed(1)} km/h`;

    // 7-Day Rolling Volume (relative to latest run date or today)
    const latestDateStr = runs[runs.length - 1].run_date;
    const latestMs = new Date(latestDateStr + 'T12:00:00').getTime();
    const sevenDaysMs = 7 * 24 * 3600 * 1000;
    const weeklyKm = runs
      .filter(r => {
        const ms = new Date(r.run_date + 'T12:00:00').getTime();
        return latestMs - ms >= 0 && latestMs - ms <= sevenDaysMs;
      })
      .reduce((acc, r) => acc + Number(r.distance_km), 0);

    const weeklyPct = Math.min(100, Math.round((weeklyKm / weeklyGoalKm) * 100));

    // Best 10K prediction from runs >= 3km
    const qualifyingRuns = runs.filter(r => Number(r.distance_km) >= 3.0);
    const predSource = qualifyingRuns.length > 0 ? qualifyingRuns : runs;
    const bestPredSec = Math.min(
      ...predSource.map(r => predict10kSeconds(Number(r.distance_km), Number(r.duration_sec), goalKm))
    );
    const predPaceSec = bestPredSec / goalKm;

    // Recommended Next Long Run (+10% rule)
    const nextLongKm = longestKm >= goalKm
      ? goalKm
      : Math.min(goalKm, Math.round(longestKm * 1.1 * 10) / 10);

    // Readiness Score (60% longest run ratio + 25% weekly volume + 15% run count)
    const readiness = Math.min(
      100,
      Math.round(
        Math.min(1, longestKm / goalKm) * 60 +
        Math.min(1, weeklyKm / weeklyGoalKm) * 25 +
        Math.min(1, runs.length / 10) * 15
      )
    );

    const nextPct = Math.min(100, Math.round((nextLongKm / goalKm) * 100));
    const targetPaceSec = parsePaceToSeconds(state.settings.goal_target_pace) || 320;
    const paceRatioPct = Math.min(100, Math.max(20, Math.round((targetPaceSec / predPaceSec) * 100)));
    const weeklyLeft = Math.max(0, weeklyGoalKm - weeklyKm);

    document.getElementById('readinessBadge').textContent = `READINESS: ${readiness}%`;
    document.getElementById('missionLongestKm').textContent = longestKm.toFixed(2);
    document.getElementById('missionLongestPctTag').textContent = `${goalPct}%`;
    document.getElementById('missionLongestBar').style.width = `${goalPct}%`;
    document.getElementById('missionDistanceLeft').textContent =
      remainingKm <= 0 ? 'Goal unlocked!' : `${remainingKm.toFixed(2)} KM to go`;

    document.getElementById('missionPred10kTime').textContent = formatDuration(bestPredSec);
    document.getElementById('missionPredPaceTag').textContent = `${goalKm.toFixed(0)}K`;
    document.getElementById('missionPredMeta').textContent = `Pace: ${formatPace(predPaceSec)} /km`;
    document.getElementById('missionPredBar').style.width = `${paceRatioPct}%`;
    document.getElementById('missionPred10kPace').textContent = `Riegel formula`;

    document.getElementById('missionWeeklyKm').textContent = weeklyKm.toFixed(1);
    document.getElementById('missionWeeklyPctTag').textContent = `${weeklyPct}%`;
    document.getElementById('missionWeeklyBar').style.width = `${weeklyPct}%`;
    document.getElementById('missionWeeklySub').textContent =
      weeklyLeft <= 0 ? 'Target reached!' : `${weeklyLeft.toFixed(1)} KM left`;

    document.getElementById('missionNextLongRun').textContent = nextLongKm.toFixed(2);
    document.getElementById('missionNextPctTag').textContent = `${nextPct}%`;
    document.getElementById('missionNextBar').style.width = `${nextPct}%`;
    document.getElementById('missionNextTip').textContent =
      longestKm >= goalKm ? '10K ready' : '+10% safe build';

    // Update Milestone Ladder (scaled to goalKm)
    const steps = document.querySelectorAll('#milestoneLadder .milestone-step');
    const milestones = [0.25, 0.5, 0.75, 1.0].map(f => Math.round(goalKm * f * 10) / 10);
    steps.forEach((step, idx) => {
      const mKm = milestones[idx];
      step.dataset.km = mKm;
      const kmEl = step.querySelector('.ms-km');
      if (kmEl) kmEl.textContent = `${mKm}K`;
      step.classList.toggle('achieved', longestKm >= mKm);
    });
  }

  function renderHrZonesAndPRs() {
    const runs = state.runs;
    const maxHr = parseInt(state.settings.max_hr, 10) || 162;
    const restingHr = parseInt(state.settings.resting_hr, 10) || 56;
    document.getElementById('maxHrLabel').textContent = `MAX HR: ${maxHr}`;

    const t = getHrZoneThresholds(maxHr, restingHr);
    const zonesContainer = document.getElementById('zonesBars');
    const zoneDefs = [
      { zone: 1, label: 'Z1 Recovery', range: `<${t.z1Max + 1}`, color: COLORS.cyan, count: 0 },
      { zone: 2, label: 'Z2 Aerobic', range: `${t.z1Max + 1}-${t.z2Max}`, color: COLORS.green, count: 0 },
      { zone: 3, label: 'Z3 Tempo', range: `${t.z2Max + 1}-${t.z3Max}`, color: COLORS.blue, count: 0 },
      { zone: 4, label: 'Z4 Threshold', range: `${t.z3Max + 1}-${t.z4Max}`, color: COLORS.purple, count: 0 },
      { zone: 5, label: 'Z5 Max/VO2', range: `${t.z4Max + 1}+`, color: COLORS.red, count: 0 }
    ];

    for (const r of runs) {
      const z = getHrZoneInfo(Number(r.avg_hr), maxHr, restingHr).zone;
      zoneDefs[z - 1].count++;
    }

    // Compute exact integer percentages that always sum to 100%
    let pcts = [0, 0, 0, 0, 0];
    if (runs.length > 0) {
      const exact = zoneDefs.map(z => (z.count / runs.length) * 100);
      const floored = exact.map(v => Math.floor(v));
      let remainder = 100 - floored.reduce((a, b) => a + b, 0);
      const order = exact
        .map((v, i) => ({ i, frac: v - floored[i] }))
        .sort((a, b) => b.frac - a.frac);
      for (let k = 0; k < remainder; k++) {
        floored[order[k].i]++;
      }
      pcts = floored;
    }

    zonesContainer.innerHTML = zoneDefs
      .map((z, idx) => {
        const pct = pcts[idx];
        return `
          <div class="zone-row" title="${z.label}: ${z.range} BPM (${z.count} runs)">
            <span class="zone-name">
              <span>${z.label}</span>
              <span class="zone-bpm">${z.range}</span>
            </span>
            <div class="zone-track">
              <div class="zone-fill" style="width: ${pct}%; background-color: ${z.color}"></div>
            </div>
            <span class="zone-pct">${pct}% (${z.count})</span>
          </div>
        `;
      })
      .join('');

    // Personal Records
    const runs5kPlus = runs.filter(r => Number(r.distance_km) >= 5.0);
    let best5kRun = null;
    for (const r of runs5kPlus) {
      if (!best5kRun || Number(r.pace_sec_per_km) < Number(best5kRun.pace_sec_per_km)) {
        best5kRun = r;
      }
    }

    let bestPaceRun = null;
    let bestEfRun = null;
    let bestEfVal = 0;
    for (const r of runs) {
      if (!bestPaceRun || Number(r.pace_sec_per_km) < Number(bestPaceRun.pace_sec_per_km)) {
        bestPaceRun = r;
      }
      const ef = calcMetersPerBeat(r.pace_sec_per_km, r.avg_hr);
      if (ef > bestEfVal) {
        bestEfVal = ef;
        bestEfRun = r;
      }
    }

    const fastest5kEl = document.getElementById('prFastest5k');
    const fastest5kSubEl = document.getElementById('prFastest5kSub');
    const fastest5kPill = document.getElementById('prFastest5kPill');
    if (best5kRun) {
      const fiveKSec = Math.round(5.0 * Number(best5kRun.pace_sec_per_km));
      fastest5kEl.textContent = formatDuration(fiveKSec);
      if (fastest5kSubEl) {
        fastest5kSubEl.textContent = `5K @ ${best5kRun.pace_display}/km`;
      }
      if (fastest5kPill) {
        fastest5kPill.title = `${best5kRun.run_date}: ${Number(best5kRun.distance_km).toFixed(2)} km total time ${formatDuration(best5kRun.duration_sec)} (5.00 km split: ${formatDuration(fiveKSec)} @ ${best5kRun.pace_display}/km)`;
      }
    } else {
      fastest5kEl.textContent = '--:--';
      if (fastest5kSubEl) fastest5kSubEl.textContent = 'Runs >= 5.0 km';
    }

    const bestPaceEl = document.getElementById('prBestPace');
    const bestPaceSubEl = document.getElementById('prBestPaceSub');
    const bestPacePill = document.getElementById('prBestPacePill');
    if (bestPaceRun) {
      bestPaceEl.textContent = `${formatPace(bestPaceRun.pace_sec_per_km)}/km`;
      if (bestPaceSubEl) {
        bestPaceSubEl.textContent = `${Number(bestPaceRun.distance_km).toFixed(2)}k • ${formatShortDate(bestPaceRun.run_date)}`;
      }
      if (bestPacePill) {
        bestPacePill.title = `${bestPaceRun.run_date}: ${Number(bestPaceRun.distance_km).toFixed(2)} km @ ${bestPaceRun.pace_display}/km`;
      }
    } else {
      bestPaceEl.textContent = '--:--/km';
      if (bestPaceSubEl) bestPaceSubEl.textContent = 'All distances';
    }

    const bestEfEl = document.getElementById('prBestEf');
    const bestEfSubEl = document.getElementById('prBestEfSub');
    const bestEfPill = document.getElementById('prBestEfPill');
    if (bestEfRun && bestEfVal > 0) {
      bestEfEl.textContent = `${bestEfVal.toFixed(2)} m/b`;
      if (bestEfSubEl) {
        bestEfSubEl.textContent = `${bestEfRun.avg_hr} bpm • ${formatShortDate(bestEfRun.run_date)}`;
      }
      if (bestEfPill) {
        bestEfPill.title = `${bestEfRun.run_date}: ${bestEfRun.pace_display}/km @ ${bestEfRun.avg_hr} bpm`;
      }
    } else {
      bestEfEl.textContent = '-- m/b';
      if (bestEfSubEl) bestEfSubEl.textContent = 'Meters / beat';
    }
  }

  function syncFormShoeSelect() {
    const shoeSelect = document.getElementById('inputShoe');
    if (!shoeSelect) return;
    const editId = document.getElementById('editRunId').value;
    const prevValue = shoeSelect.value;
    const shoes = state.shoes || [];

    const optionsHtml = [
      `<option value="">None / Unassigned</option>`,
      ...shoes.map(s => {
        const label = `${s.name}${Number(s.is_default) === 1 ? ' (Default)' : ''}`;
        return `<option value="${s.id}">${label.replace(/</g, '&lt;')}</option>`;
      })
    ].join('');
    shoeSelect.innerHTML = optionsHtml;

    if (editId) {
      shoeSelect.value = prevValue;
      return;
    }

    const dateVal = document.getElementById('inputDate').value || new Date().toISOString().slice(0, 10);
    const defaultShoe = shoes.find(s => Number(s.is_default) === 1) || shoes[0];
    if (defaultShoe && dateVal >= (defaultShoe.start_date || '2026-11-01')) {
      shoeSelect.value = String(defaultShoe.id);
    } else if (prevValue && shoes.some(s => String(s.id) === prevValue)) {
      shoeSelect.value = prevValue;
    } else {
      shoeSelect.value = '';
    }
  }

  function renderShoesTracker() {
    const listEl = document.getElementById('shoesTrackerList');
    const countPill = document.getElementById('shoesCountPill');
    if (!listEl) return;

    const shoes = state.shoes || [];
    if (countPill) countPill.textContent = String(shoes.length);

    syncFormShoeSelect();

    if (shoes.length === 0) {
      listEl.innerHTML = `
        <div style="text-align: center; padding: 12px 8px; color: var(--text-muted); font-size: 10.5px;">
          No shoes tracked yet. Click <strong>+ ADD SHOE</strong> above to track shoe mileage.
        </div>
      `;
      return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);

    listEl.innerHTML = shoes
      .map(shoe => {
        const isDefault = Number(shoe.is_default) === 1;
        const startDate = shoe.start_date || '2026-11-01';
        const maxKm = Math.max(50, Number(shoe.max_distance_km) || 650);
        const initKm = Math.max(0, Number(shoe.initial_km) || 0);

        const shoeRuns = state.runs.filter(r => {
          if (r.shoe_id !== null && r.shoe_id !== undefined && String(r.shoe_id) !== '') {
            return Number(r.shoe_id) === Number(shoe.id);
          }
          return isDefault && r.run_date >= startDate;
        });

        const loggedKm = shoeRuns.reduce((sum, r) => sum + (Number(r.distance_km) || 0), 0);
        const totalKm = initKm + loggedKm;
        const wearPct = Math.min(100, Math.round((totalKm / maxKm) * 100));
        const remKm = Math.max(0, maxKm - totalKm);
        const barColor = wearPct >= 90 ? COLORS.red : wearPct >= 75 ? COLORS.orange : COLORS.green;

        const safeName = String(shoe.name || 'Shoe').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const dateStatus =
          shoeRuns.length === 0 && startDate > todayStr
            ? `First run: ${formatShortDate(startDate)}`
            : `Since ${formatShortDate(startDate)}`;

        return `
          <div class="shoe-item ${isDefault ? 'shoe-default' : ''}">
            <div class="shoe-item-top">
              <div class="shoe-name-wrap">
                <span class="shoe-name" title="${safeName}">${safeName}</span>
                ${
                  isDefault
                    ? `<span class="shoe-badge shoe-badge-active" title="Default shoe for new runs">ACTIVE</span>`
                    : `<button type="button" class="shoe-badge shoe-badge-set btn-set-default-shoe" data-id="${shoe.id}" title="Set as default shoe">SET ACTIVE</button>`
                }
              </div>
              <div class="shoe-stats-right">
                <span class="shoe-km-val">${totalKm.toFixed(2)} <small>KM</small></span>
                <button type="button" class="row-btn delete btn-delete-shoe" data-id="${shoe.id}" title="Remove ${safeName}">&times;</button>
              </div>
            </div>
            <div class="shoe-bar-track" title="${wearPct}% of ${maxKm} KM lifespan (${remKm.toFixed(1)} KM remaining)">
              <div class="shoe-bar-fill" style="width: ${wearPct}%; background-color: ${barColor}"></div>
            </div>
            <div class="shoe-item-foot">
              <span>${shoeRuns.length} ${shoeRuns.length === 1 ? 'run' : 'runs'} &bull; ${dateStatus}</span>
              <span>${totalKm.toFixed(1)} / ${maxKm.toFixed(0)} km (${wearPct}%)</span>
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderHistoryTable() {
    const tbody = document.getElementById('historyTableBody');
    const countPill = document.getElementById('historyCountPill');
    const filtered = state.runs
      .filter(r => state.filterType === 'all' || r.run_type === state.filterType)
      .slice()
      .reverse(); // Newest first in log history

    countPill.textContent = String(filtered.length);

    if (filtered.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align:center; padding: 20px; color: var(--text-muted);">
            No runs match the current filter.
          </td>
        </tr>
      `;
      return;
    }

    const maxHr = parseInt(state.settings.max_hr, 10) || 162;
    const restingHr = parseInt(state.settings.resting_hr, 10) || 56;

    tbody.innerHTML = filtered
      .map(r => {
        const zInfo = getHrZoneInfo(Number(r.avg_hr), maxHr, restingHr);
        const safeNotes = (r.notes || '').replace(/"/g, '&quot;');
        return `
          <tr title="${safeNotes}">
            <td>
              <div class="run-date-cell">
                <strong>${formatShortDate(r.run_date)}</strong>
                <span class="run-type-tag type-${r.run_type || 'easy'}">${r.run_type || 'easy'}</span>
              </div>
            </td>
            <td class="text-blue"><strong>${Number(r.distance_km).toFixed(2)}</strong> <small>km</small></td>
            <td class="text-purple"><strong>${r.pace_display}</strong><small>/km</small></td>
            <td>
              <span style="color: ${zInfo.color}; font-weight: 700;">${r.avg_hr}</span>
              <small class="text-muted">Z${zInfo.zone}</small>
            </td>
            <td class="text-cyan">${formatDuration(r.duration_sec)}</td>
            <td class="col-actions">
              <button type="button" class="row-btn edit" data-id="${r.id}" title="Edit run">EDIT</button>
              <button type="button" class="row-btn delete" data-id="${r.id}" title="Delete run">&times;</button>
            </td>
          </tr>
        `;
      })
      .join('');
  }

  // ==========================================================================
  // UPLOT INTERACTIVE GRAPHING ENGINE
  // ==========================================================================

  function getFilteredChartRuns() {
    const runs = state.runs;
    if (state.chartRange === '7') return runs.slice(-7);
    if (state.chartRange === '15') return runs.slice(-15);
    return runs;
  }

  function updateReadoutBar(run) {
    const goalKm = parseFloat(state.settings.goal_distance_km) || 10.0;
    if (!run) {
      document.getElementById('roDate').textContent = '--';
      document.getElementById('roDist').textContent = '-- KM';
      document.getElementById('roPace').textContent = '--:-- /KM';
      document.getElementById('roHr').textContent = '-- BPM';
      document.getElementById('roTime').textContent = '--:--';
      document.getElementById('roGoalPct').textContent = '--%';
      return;
    }
    const pct = Math.min(100, Math.round((Number(run.distance_km) / goalKm) * 100));
    document.getElementById('roDate').textContent = `${run.run_date} (${(run.run_type || 'easy').toUpperCase()})`;
    document.getElementById('roDist').textContent = `${Number(run.distance_km).toFixed(2)} KM`;
    document.getElementById('roPace').textContent = `${run.pace_display} /KM`;
    document.getElementById('roHr').textContent = `${run.avg_hr} BPM`;
    document.getElementById('roTime').textContent = formatDuration(run.duration_sec);
    document.getElementById('roGoalPct').textContent = `${pct}%`;
  }

  function renderChart() {
    const container = document.getElementById('uplotContainer');
    const stage = document.getElementById('uplotStage');
    const emptyState = document.getElementById('chartEmptyState');
    if (!container || !stage || typeof uPlot === 'undefined') return;

    const chartRuns = getFilteredChartRuns();

    if (state.uplotInstance) {
      state.uplotInstance.destroy();
      state.uplotInstance = null;
    }
    container.innerHTML = '';

    if (chartRuns.length === 0) {
      emptyState.classList.remove('hidden');
      updateReadoutBar(null);
      return;
    }
    emptyState.classList.add('hidden');

    // Default readout to latest run
    updateReadoutBar(chartRuns[chartRuns.length - 1]);

    const rect = stage.getBoundingClientRect();
    const width = Math.max(280, Math.floor(rect.width));
    const height = Math.max(210, Math.floor(rect.height));

    const goalKm = parseFloat(state.settings.goal_distance_km) || 10.0;
    const targetPaceSec = parsePaceToSeconds(state.settings.goal_target_pace) || 320;

    // X-axis uses sequential run indices (0..N-1) mapped to formatted dates
    const xVals = chartRuns.map((_, i) => i);
    const distVals = chartRuns.map(r => Number(r.distance_km));
    const goalVals = chartRuns.map(() => goalKm);
    const paceMinsVals = chartRuns.map(r => Number(r.pace_sec_per_km) / 60);
    const hrVals = chartRuns.map(r => Number(r.avg_hr));
    const efVals = chartRuns.map(r => Number(calcMetersPerBeat(r.pace_sec_per_km, r.avg_hr).toFixed(2)));
    const speedVals = chartRuns.map(r => Number((3600 / Number(r.pace_sec_per_km)).toFixed(2)));

    // Rolling 3-run distance average
    const rollingDistVals = distVals.map((_, idx) => {
      const start = Math.max(0, idx - 2);
      const slice = distVals.slice(start, idx + 1);
      return Number((slice.reduce((a, b) => a + b, 0) / slice.length).toFixed(2));
    });

    const commonXAxis = {
      stroke: COLORS.axisText,
      font: COLORS.font,
      size: 28,
      gap: 6,
      grid: { stroke: COLORS.grid, width: 1 },
      ticks: { stroke: COLORS.grid, width: 1, size: 4 },
      splits: () => xVals,
      values: (u, splits) =>
        splits.map(idx => {
          const r = chartRuns[idx];
          if (!r) return '';
          const step = Math.max(1, Math.ceil(chartRuns.length / Math.max(4, Math.floor(width / 90))));
          if (idx % step !== 0 && idx !== chartRuns.length - 1) return '';
          return formatShortDate(r.run_date);
        })
    };

    const cursorHooks = {
      setCursor: [
        u => {
          const idx = u.cursor.idx;
          if (idx !== null && idx !== undefined && chartRuns[idx]) {
            updateReadoutBar(chartRuns[idx]);
          } else {
            updateReadoutBar(chartRuns[chartRuns.length - 1]);
          }
        }
      ]
    };

    let data = [];
    let series = [];
    let axes = [];
    let scales = {
      x: { time: false, range: (u, min, max) => [min - 0.25, max + 0.25] }
    };

    if (state.chartMode === 'combined') {
      data = [xVals, distVals, goalVals, paceMinsVals, hrVals];
      scales.km = { range: [0, Math.max(goalKm + 1.5, ...distVals) * 1.08] };
      scales.hr = {
        range: [
          Math.max(40, Math.min(...hrVals) - 12),
          Math.max(...hrVals) + 12
        ]
      };
      scales.pace = {
        dir: -1,
        range: [
          Math.min(...paceMinsVals) - 0.4,
          Math.max(...paceMinsVals) + 0.5
        ]
      };
      series = [
        {},
        {
          label: 'Distance (KM)',
          scale: 'km',
          stroke: COLORS.blue,
          fill: COLORS.blueFill,
          width: 2.5,
          points: { show: true, size: 6, stroke: COLORS.blue, fill: '#16161e' }
        },
        {
          label: '10K Goal',
          scale: 'km',
          stroke: COLORS.green,
          width: 1.5,
          dash: [6, 4],
          points: { show: false }
        },
        {
          label: 'Avg Pace (/km)',
          scale: 'pace',
          stroke: COLORS.purple,
          width: 2,
          points: { show: true, size: 5, stroke: COLORS.purple, fill: '#16161e' }
        },
        {
          label: 'Avg HR (BPM)',
          scale: 'hr',
          stroke: COLORS.red,
          width: 2,
          points: { show: true, size: 5, stroke: COLORS.red, fill: '#16161e' }
        }
      ];
      axes = [
        commonXAxis,
        {
          scale: 'km',
          stroke: COLORS.blue,
          font: COLORS.font,
          size: 50,
          space: 44,
          grid: { stroke: COLORS.grid, width: 1 },
          values: (u, vals) => vals.map(v => `${v.toFixed(1)}k`)
        },
        {
          scale: 'hr',
          side: 1,
          stroke: COLORS.red,
          font: COLORS.font,
          size: 46,
          space: 44,
          grid: { show: false },
          values: (u, vals) => vals.map(v => `${Math.round(v)}`)
        }
      ];
    } else if (state.chartMode === 'distance') {
      data = [xVals, distVals, rollingDistVals, goalVals];
      scales.km = { range: [0, Math.max(goalKm + 1.5, ...distVals) * 1.1] };
      series = [
        {},
        {
          label: 'Run Distance (KM)',
          scale: 'km',
          stroke: COLORS.blue,
          fill: COLORS.blueFill,
          width: 2.5,
          points: { show: true, size: 6, stroke: COLORS.blue, fill: '#16161e' }
        },
        {
          label: '3-Run Rolling Avg',
          scale: 'km',
          stroke: COLORS.cyan,
          width: 2,
          points: { show: false }
        },
        {
          label: '10KM Goal Target',
          scale: 'km',
          stroke: COLORS.green,
          width: 2,
          dash: [6, 4],
          points: { show: false }
        }
      ];
      axes = [
        commonXAxis,
        {
          scale: 'km',
          stroke: COLORS.blue,
          font: COLORS.font,
          size: 56,
          space: 44,
          grid: { stroke: COLORS.grid, width: 1 },
          values: (u, vals) => vals.map(v => `${v.toFixed(1)} km`)
        }
      ];
    } else if (state.chartMode === 'pace_hr') {
      const targetPaceMins = chartRuns.map(() => targetPaceSec / 60);
      data = [xVals, paceMinsVals, targetPaceMins, hrVals];
      scales.pace = {
        range: [
          Math.min(targetPaceSec / 60, ...paceMinsVals) - 0.35,
          Math.max(targetPaceSec / 60, ...paceMinsVals) + 0.35
        ]
      };
      scales.hr = {
        range: [
          Math.max(40, Math.min(...hrVals) - 10),
          Math.max(...hrVals) + 10
        ]
      };
      series = [
        {},
        {
          label: 'Avg Pace (/km)',
          scale: 'pace',
          stroke: COLORS.purple,
          fill: COLORS.purpleFill,
          width: 2.5,
          points: { show: true, size: 6, stroke: COLORS.purple, fill: '#16161e' }
        },
        {
          label: 'Target 10K Pace',
          scale: 'pace',
          stroke: COLORS.green,
          width: 1.5,
          dash: [5, 5],
          points: { show: false }
        },
        {
          label: 'Avg Heart Rate',
          scale: 'hr',
          stroke: COLORS.red,
          fill: COLORS.redFill,
          width: 2.2,
          points: { show: true, size: 6, stroke: COLORS.red, fill: '#16161e' }
        }
      ];
      axes = [
        commonXAxis,
        {
          scale: 'pace',
          stroke: COLORS.purple,
          font: COLORS.font,
          size: 54,
          space: 44,
          grid: { stroke: COLORS.grid, width: 1 },
          values: (u, vals) => vals.map(v => formatPace(v * 60))
        },
        {
          scale: 'hr',
          side: 1,
          stroke: COLORS.red,
          font: COLORS.font,
          size: 56,
          space: 44,
          grid: { show: false },
          values: (u, vals) => vals.map(v => `${Math.round(v)} bpm`)
        }
      ];
    } else {
      // Aerobic Efficiency (Meters per Beat) & Speed (km/h)
      data = [xVals, efVals, speedVals];
      scales.ef = {
        range: [
          Math.max(0.4, Math.min(...efVals) - 0.1),
          Math.max(...efVals) + 0.1
        ]
      };
      scales.spd = {
        range: [
          Math.max(4, Math.min(...speedVals) - 1),
          Math.max(...speedVals) + 1
        ]
      };
      series = [
        {},
        {
          label: 'Aerobic Efficiency (m/beat)',
          scale: 'ef',
          stroke: COLORS.cyan,
          fill: COLORS.cyanFill,
          width: 2.5,
          points: { show: true, size: 6, stroke: COLORS.cyan, fill: '#16161e' }
        },
        {
          label: 'Avg Speed (km/h)',
          scale: 'spd',
          stroke: COLORS.green,
          width: 2,
          points: { show: true, size: 5, stroke: COLORS.green, fill: '#16161e' }
        }
      ];
      axes = [
        commonXAxis,
        {
          scale: 'ef',
          stroke: COLORS.cyan,
          font: COLORS.font,
          size: 62,
          space: 44,
          grid: { stroke: COLORS.grid, width: 1 },
          values: (u, vals) => vals.map(v => `${v.toFixed(2)} m/b`)
        },
        {
          scale: 'spd',
          side: 1,
          stroke: COLORS.green,
          font: COLORS.font,
          size: 62,
          space: 44,
          grid: { show: false },
          values: (u, vals) => vals.map(v => `${v.toFixed(1)} km/h`)
        }
      ];
    }

    const opts = {
      width,
      height,
      padding: [16, 12, 6, 8],
      cursor: {
        drag: { x: false, y: false },
        points: { size: 9, width: 2 }
      },
      legend: { show: false },
      scales,
      series,
      axes,
      hooks: cursorHooks
    };

    state.uplotInstance = new uPlot(opts, data, container);
  }

  // ==========================================================================
  // LIVE FORM TELEMETRY PREVIEW & FORM SUBMISSION
  // ==========================================================================

  function updateLiveFormPreview() {
    const dist = parseFloat(document.getElementById('inputDistance').value);
    const paceSec = parsePaceToSeconds(document.getElementById('inputPace').value);
    const hr = parseInt(document.getElementById('inputHr').value, 10);
    const goalKm = parseFloat(state.settings.goal_distance_km) || 10.0;
    const maxHr = parseInt(state.settings.max_hr, 10) || 162;
    const restingHr = parseInt(state.settings.resting_hr, 10) || 56;

    // Distance preview
    const distEl = document.getElementById('liveDistPreview');
    if (distEl) {
      if (Number.isFinite(dist) && dist > 0) {
        const pct = Math.min(100, Math.round((dist / goalKm) * 100));
        distEl.textContent = `${pct}% of ${goalKm.toFixed(1)}K`;
        distEl.style.color = COLORS.blue;
      } else {
        distEl.textContent = `Goal: ${goalKm.toFixed(1)} KM`;
        distEl.style.color = '';
      }
    }

    // Speed preview
    const speedEl = document.getElementById('liveSpeedPreview');
    if (paceSec > 0) {
      const kmh = 3600 / paceSec;
      speedEl.textContent = `${kmh.toFixed(1)} km/h`;
      speedEl.style.color = COLORS.purple;
    } else {
      speedEl.textContent = 'MM:SS (e.g. 5:30)';
      speedEl.style.color = '';
    }

    // HR Zone preview
    const hrZoneEl = document.getElementById('liveHrZonePreview');
    if (Number.isFinite(hr) && hr >= 35) {
      const zInfo = getHrZoneInfo(hr, maxHr, restingHr);
      hrZoneEl.textContent = zInfo.name;
      hrZoneEl.style.color = zInfo.color;
    } else {
      hrZoneEl.textContent = 'BPM (e.g. 155)';
      hrZoneEl.style.color = '';
    }

    // Live strip
    const durationSec = dist > 0 && paceSec > 0 ? Math.round(dist * paceSec) : 0;
    document.getElementById('calcDuration').textContent = durationSec ? formatDuration(durationSec) : '--:--';
    document.getElementById('calcGoalPct').textContent =
      dist > 0 ? `${Math.min(100, Math.round((dist / goalKm) * 100))}%` : '--%';

    const ef = paceSec > 0 && hr > 0 ? calcMetersPerBeat(paceSec, hr) : 0;
    document.getElementById('calcEfficiency').textContent = ef > 0 ? `${ef.toFixed(2)} m/b` : '-- m/b';

    const pred10k = dist >= 1.5 && durationSec > 0 ? predict10kSeconds(dist, durationSec, goalKm) : 0;
    document.getElementById('calc10kPredictor').textContent = pred10k > 0 ? formatDuration(pred10k) : '--:--';
  }

  function resetFormToNew() {
    document.getElementById('editRunId').value = '';
    document.getElementById('formTitle').textContent = 'LOG RUN TELEMETRY';
    document.getElementById('btnSubmitText').textContent = 'SAVE RUN';
    document.getElementById('btnCancelEdit').classList.add('hidden');
    document.getElementById('inputDate').value = new Date().toISOString().slice(0, 10);
    document.getElementById('inputDistance').value = '';
    document.getElementById('inputPace').value = '';
    document.getElementById('inputHr').value = '';
    document.getElementById('inputType').value = 'easy';
    document.getElementById('inputNotes').value = '';
    syncFormShoeSelect();
    updateLiveFormPreview();
  }

  function populateFormForEdit(run) {
    document.getElementById('editRunId').value = String(run.id);
    document.getElementById('formTitle').textContent = `EDIT RUN #${run.id}`;
    document.getElementById('btnSubmitText').textContent = 'UPDATE RUN';
    document.getElementById('btnCancelEdit').classList.remove('hidden');
    document.getElementById('inputDate').value = run.run_date;
    document.getElementById('inputDistance').value = Number(run.distance_km).toFixed(2);
    document.getElementById('inputPace').value = run.pace_display;
    document.getElementById('inputHr').value = String(run.avg_hr);
    document.getElementById('inputType').value = run.run_type || 'easy';
    document.getElementById('inputNotes').value = run.notes || '';
    syncFormShoeSelect();
    const shoeSelect = document.getElementById('inputShoe');
    if (shoeSelect) {
      if (run.shoe_id !== null && run.shoe_id !== undefined && String(run.shoe_id) !== '') {
        shoeSelect.value = String(run.shoe_id);
      } else {
        const defaultShoe = (state.shoes || []).find(s => Number(s.is_default) === 1);
        if (defaultShoe && run.run_date >= (defaultShoe.start_date || '2026-11-01')) {
          shoeSelect.value = String(defaultShoe.id);
        } else {
          shoeSelect.value = '';
        }
      }
    }
    updateLiveFormPreview();

    if (window.innerWidth < 960) {
      switchMobileView('log');
    }
  }

  // ==========================================================================
  // MOBILE VIEW NAVIGATION
  // ==========================================================================

  function switchMobileView(targetView) {
    state.mobileTab = targetView;
    document.querySelectorAll('#mobileNav .mobile-nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.target === targetView);
    });

    const panelLeft = document.querySelector('.panel-left');
    const panelCenter = document.querySelector('.panel-center');
    const panelRight = document.querySelector('.panel-right');
    const cardForm = document.querySelector('.card-form');
    const cardGoal = document.querySelector('.card-goal-mission');

    panelLeft.classList.remove('mobile-active');
    panelCenter.classList.remove('mobile-active');
    panelRight.classList.remove('mobile-active');
    cardForm.classList.remove('mobile-hidden-card');
    cardGoal.classList.remove('mobile-active-card');

    if (targetView === 'dashboard') {
      panelCenter.classList.add('mobile-active');
      setTimeout(() => renderChart(), 20);
    } else if (targetView === 'log') {
      panelLeft.classList.add('mobile-active');
    } else if (targetView === 'goal') {
      panelLeft.classList.add('mobile-active');
      cardForm.classList.add('mobile-hidden-card');
      cardGoal.classList.add('mobile-active-card');
    } else if (targetView === 'history') {
      panelRight.classList.add('mobile-active');
    }
  }

  // ==========================================================================
  // EVENT LISTENERS & INITIALIZATION
  // ==========================================================================

  function bindEvents() {
    // Default date to today
    const dateInput = document.getElementById('inputDate');
    if (dateInput) {
      if (!dateInput.value) {
        dateInput.value = new Date().toISOString().slice(0, 10);
      }
      dateInput.addEventListener('change', () => {
        if (!document.getElementById('editRunId').value) {
          syncFormShoeSelect();
        }
      });
    }

    // Live preview inputs
    ['inputDistance', 'inputPace', 'inputHr'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', updateLiveFormPreview);
    });

    // Quick Distance Chips
    document.getElementById('distanceQuickChips').addEventListener('click', e => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      document.getElementById('inputDistance').value = chip.dataset.dist;
      updateLiveFormPreview();
    });

    // Cancel Edit
    document.getElementById('btnCancelEdit').addEventListener('click', resetFormToNew);

    // Submit Run (Create or Update)
    document.getElementById('runForm').addEventListener('submit', async e => {
      e.preventDefault();
      const editId = document.getElementById('editRunId').value;
      const shoeEl = document.getElementById('inputShoe');
      const shoeVal = shoeEl && shoeEl.value ? parseInt(shoeEl.value, 10) : null;
      const payload = {
        run_date: document.getElementById('inputDate').value,
        distance_km: parseFloat(document.getElementById('inputDistance').value),
        pace: document.getElementById('inputPace').value.trim(),
        avg_hr: parseInt(document.getElementById('inputHr').value, 10),
        run_type: document.getElementById('inputType').value,
        notes: document.getElementById('inputNotes').value.trim(),
        shoe_id: shoeVal
      };

      try {
        let data;
        if (editId) {
          data = await apiRequest(`/api/runs/${editId}`, {
            method: 'PUT',
            body: JSON.stringify(payload)
          });
          showToast(`Updated run (${payload.distance_km} KM @ ${payload.pace}/km)`);
        } else {
          data = await apiRequest('/api/runs', {
            method: 'POST',
            body: JSON.stringify(payload)
          });
          showToast(`Saved ${payload.distance_km} KM run to SQLite3!`);
        }
        state.runs = data.runs;
        if (data.shoes) state.shoes = data.shoes;
        state.settings = data.settings;
        resetFormToNew();
        renderAll();
        if (window.innerWidth < 960) {
          switchMobileView('dashboard');
        }
      } catch (err) {
        showToast(`Error: ${err.message}`);
      }
    });

    // Shoe Distance Tracker Add / Set Active / Delete Events
    const addShoeForm = document.getElementById('addShoeForm');
    const btnToggleAddShoe = document.getElementById('btnToggleAddShoe');
    const btnCancelAddShoe = document.getElementById('btnCancelAddShoe');
    const inputShoeStartDate = document.getElementById('inputShoeStartDate');

    if (btnToggleAddShoe && addShoeForm) {
      btnToggleAddShoe.addEventListener('click', () => {
        const isHidden = addShoeForm.classList.contains('hidden');
        if (isHidden) {
          if (inputShoeStartDate && !inputShoeStartDate.value) {
            inputShoeStartDate.value = new Date().toISOString().slice(0, 10);
          }
          addShoeForm.classList.remove('hidden');
          document.getElementById('inputShoeName').focus();
        } else {
          addShoeForm.classList.add('hidden');
        }
      });
    }

    if (btnCancelAddShoe && addShoeForm) {
      btnCancelAddShoe.addEventListener('click', () => {
        addShoeForm.classList.add('hidden');
      });
    }

    if (addShoeForm) {
      addShoeForm.addEventListener('submit', async e => {
        e.preventDefault();
        const name = document.getElementById('inputShoeName').value.trim();
        const start_date = document.getElementById('inputShoeStartDate').value;
        const max_distance_km = parseFloat(document.getElementById('inputShoeMaxKm').value) || 650;
        const initial_km = parseFloat(document.getElementById('inputShoeInitialKm').value) || 0;
        if (!name) return;

        try {
          const data = await apiRequest('/api/shoes', {
            method: 'POST',
            body: JSON.stringify({
              name,
              start_date,
              max_distance_km,
              initial_km,
              is_default: true
            })
          });
          state.shoes = data.shoes || [];
          state.runs = data.runs || state.runs;
          document.getElementById('inputShoeName').value = '';
          document.getElementById('inputShoeInitialKm').value = '0';
          addShoeForm.classList.add('hidden');
          renderAll();
          showToast(`Added shoe "${name}" to tracker`);
        } catch (err) {
          showToast(`Error: ${err.message}`);
        }
      });
    }

    const shoesListEl = document.getElementById('shoesTrackerList');
    if (shoesListEl) {
      shoesListEl.addEventListener('click', async e => {
        const setDefBtn = e.target.closest('.btn-set-default-shoe');
        if (setDefBtn) {
          const id = Number(setDefBtn.dataset.id);
          try {
            const data = await apiRequest(`/api/shoes/${id}/default`, { method: 'PUT' });
            state.shoes = data.shoes || [];
            renderAll();
            showToast('Updated active default shoe');
          } catch (err) {
            showToast(`Error: ${err.message}`);
          }
          return;
        }

        const delShoeBtn = e.target.closest('.btn-delete-shoe');
        if (delShoeBtn) {
          const id = Number(delShoeBtn.dataset.id);
          try {
            const data = await apiRequest(`/api/shoes/${id}`, { method: 'DELETE' });
            state.shoes = data.shoes || [];
            state.runs = data.runs || state.runs;
            renderAll();
            showToast('Shoe removed from tracker');
          } catch (err) {
            showToast(`Error: ${err.message}`);
          }
        }
      });
    }

    // History Table Edit & Delete Actions
    document.getElementById('historyTableBody').addEventListener('click', async e => {
      const editBtn = e.target.closest('.row-btn.edit');
      if (editBtn) {
        const id = Number(editBtn.dataset.id);
        const run = state.runs.find(r => Number(r.id) === id);
        if (run) populateFormForEdit(run);
        return;
      }

      const delBtn = e.target.closest('.row-btn.delete');
      if (delBtn) {
        const id = Number(delBtn.dataset.id);
        try {
          const data = await apiRequest(`/api/runs/${id}`, { method: 'DELETE' });
          state.runs = data.runs;
          renderAll();
          showToast('Run deleted from SQLite3');
        } catch (err) {
          showToast(`Error: ${err.message}`);
        }
      }
    });

    // Chart Mode Tabs
    document.getElementById('chartModeTabs').addEventListener('click', e => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      state.chartMode = btn.dataset.mode;
      document.querySelectorAll('#chartModeTabs .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderChart();
    });

    // Chart Range Tabs
    document.getElementById('chartRangeTabs').addEventListener('click', e => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      state.chartRange = btn.dataset.range;
      document.querySelectorAll('#chartRangeTabs .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderChart();
    });

    // History Filter
    document.getElementById('filterTypeSelect').addEventListener('change', e => {
      state.filterType = e.target.value;
      renderHistoryTable();
    });

    // Export JSON
    document.getElementById('btnExportJson').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ runs: state.runs, settings: state.settings }, null, 2)], {
        type: 'application/json'
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mmcrun-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Exported run telemetry JSON');
    });

    // Demo Data Clear / Seed
    document.getElementById('btnClearDemoRuns').addEventListener('click', async () => {
      try {
        const data = await apiRequest('/api/runs/demo', { method: 'DELETE' });
        state.runs = data.runs;
        renderAll();
        showToast('Cleared demo runs. Ready for your real runs!');
      } catch (err) {
        showToast(`Error: ${err.message}`);
      }
    });

    document.getElementById('btnSeedFromEmpty').addEventListener('click', async () => {
      try {
        const data = await apiRequest('/api/runs/seed', { method: 'POST' });
        state.runs = data.runs;
        renderAll();
        showToast('Loaded sample 10K training runs');
      } catch (err) {
        showToast(`Error: ${err.message}`);
      }
    });

    // Batch Past Runs Modal
    const batchModal = document.getElementById('batchModal');
    document.getElementById('btnOpenBatchModal').addEventListener('click', () => {
      batchModal.classList.remove('hidden');
    });
    document.getElementById('btnCloseBatchModal').addEventListener('click', () => {
      batchModal.classList.add('hidden');
    });

    document.getElementById('btnLoadSampleData').addEventListener('click', async () => {
      try {
        const data = await apiRequest('/api/runs/seed', { method: 'POST' });
        state.runs = data.runs;
        batchModal.classList.add('hidden');
        renderAll();
        showToast('Restored sample 10K training block');
      } catch (err) {
        showToast(`Error: ${err.message}`);
      }
    });

    document.getElementById('btnSaveBatchRuns').addEventListener('click', async () => {
      const raw = document.getElementById('batchTextarea').value.trim();
      if (!raw) {
        showToast('Please enter at least one past run line');
        return;
      }
      const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const parsedRuns = [];

      for (const line of lines) {
        const parts = line.split(',').map(p => p.trim());
        if (parts.length < 4) {
          showToast(`Invalid line format: "${line}"`);
          return;
        }
        parsedRuns.push({
          run_date: parts[0],
          distance_km: parseFloat(parts[1]),
          pace: parts[2],
          avg_hr: parseInt(parts[3], 10),
          run_type: (parts[4] || 'easy').toLowerCase(),
          notes: parts.slice(5).join(', ')
        });
      }

      try {
        const data = await apiRequest('/api/runs', {
          method: 'POST',
          body: JSON.stringify({ runs: parsedRuns })
        });
        state.runs = data.runs;
        document.getElementById('batchTextarea').value = '';
        batchModal.classList.add('hidden');
        renderAll();
        showToast(`Imported ${parsedRuns.length} past runs into SQLite3!`);
      } catch (err) {
        showToast(`Import error: ${err.message}`);
      }
    });

    // 10K Goal Config Modal
    const goalModal = document.getElementById('goalModal');
    const openGoalModal = () => {
      document.getElementById('settingGoalKm').value = state.settings.goal_distance_km || '10.0';
      document.getElementById('settingTargetPace').value = state.settings.goal_target_pace || '5:20';
      document.getElementById('settingWeeklyKm').value = state.settings.weekly_goal_km || '24.0';
      document.getElementById('settingTargetDate').value = state.settings.goal_target_date || '2026-12-06';
      document.getElementById('settingMaxHr').value = state.settings.max_hr || '162';
      document.getElementById('settingRestingHr').value = state.settings.resting_hr || '56';
      goalModal.classList.remove('hidden');
    };

    document.getElementById('btnOpenGoalModal').addEventListener('click', openGoalModal);
    document.getElementById('headerGoalStrip').addEventListener('click', openGoalModal);
    document.getElementById('btnCloseGoalModal').addEventListener('click', () => {
      goalModal.classList.add('hidden');
    });

    document.getElementById('goalSettingsForm').addEventListener('submit', async e => {
      e.preventDefault();
      const newSettings = {
        goal_distance_km: document.getElementById('settingGoalKm').value,
        goal_target_pace: document.getElementById('settingTargetPace').value,
        weekly_goal_km: document.getElementById('settingWeeklyKm').value,
        goal_target_date: document.getElementById('settingTargetDate').value,
        max_hr: document.getElementById('settingMaxHr').value,
        resting_hr: document.getElementById('settingRestingHr').value
      };
      try {
        const data = await apiRequest('/api/settings', {
          method: 'PUT',
          body: JSON.stringify(newSettings)
        });
        state.settings = data.settings;
        goalModal.classList.add('hidden');
        renderAll();
        showToast('Saved 10K training settings to SQLite3');
      } catch (err) {
        showToast(`Error: ${err.message}`);
      }
    });

    document.getElementById('btnClearAllRuns').addEventListener('click', async () => {
      try {
        const data = await apiRequest('/api/runs/all', { method: 'DELETE' });
        state.runs = data.runs;
        goalModal.classList.add('hidden');
        renderAll();
        showToast('Deleted all runs from SQLite3 database');
      } catch (err) {
        showToast(`Error: ${err.message}`);
      }
    });

    // Mobile Bottom Navigation
    document.getElementById('mobileNav').addEventListener('click', e => {
      const btn = e.target.closest('.mobile-nav-btn');
      if (!btn) return;
      switchMobileView(btn.dataset.target);
    });

    // ResizeObserver for dynamic full-window uPlot resizing
    const stage = document.getElementById('uplotStage');
    if (stage && typeof ResizeObserver !== 'undefined') {
      let resizeTimer = null;
      const ro = new ResizeObserver(() => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          renderChart();
        }, 40);
      });
      ro.observe(stage);
    } else {
      window.addEventListener('resize', () => renderChart());
    }
  }

  // Register Service Worker
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => {
          console.warn('ServiceWorker registration failed:', err);
        });
      });
    }
  }

  // Initialize App
  document.addEventListener('DOMContentLoaded', () => {
    switchMobileView('dashboard');
    bindEvents();
    registerServiceWorker();
    loadInitialState();
  });
})();
