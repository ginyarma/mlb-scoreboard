"use strict";

// MLB Live Scoreboard — self-contained static page.
// Polls the keyless MLB StatsAPI schedule endpoint and re-renders in place.
// No server or cron needed: the browser refreshes itself on a timer.

const STATSAPI = "https://statsapi.mlb.com/api/v1";
const HYDRATE = "linescore,team,probablePitcher";
const REFRESH_MS = 25000; // poll cadence (~25s)
const LOGO = (id) => `https://www.mlbstatic.com/team-logos/${id}.svg`;

const els = {
  board: document.getElementById("board"),
  statusText: document.getElementById("status-text"),
  refreshState: document.getElementById("refresh-state"),
  datePicker: document.getElementById("date-picker"),
  prevDay: document.getElementById("prev-day"),
  nextDay: document.getElementById("next-day"),
  todayBtn: document.getElementById("today-btn"),
  refreshBtn: document.getElementById("refresh-btn"),
  refreshSecs: document.getElementById("refresh-secs"),
};

let state = {
  date: null,        // "YYYY-MM-DD"
  timer: null,       // poll interval id
  countdown: null,   // 1s countdown interval id
  nextPollAt: 0,
  lastGood: null,    // last successful render time
  inFlight: false,
};

// ---- date helpers -------------------------------------------------

// Today's calendar date in US Eastern time (MLB's scheduling day).
function todayET() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  return parts; // en-CA gives YYYY-MM-DD
}

function shiftDate(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function fmtClock(iso) {
  // Local start time, e.g. "7:05 PM"
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch (e) {
    return "";
  }
}

function fmtDateHeading(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString([], {
    timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric",
  });
}

// ---- fetch --------------------------------------------------------

async function fetchSchedule(date) {
  const url = `${STATSAPI}/schedule?sportId=1&date=${date}&hydrate=${HYDRATE}`;
  const resp = await fetch(url, { cache: "no-store" });
  if (!resp.ok) throw new Error(`StatsAPI HTTP ${resp.status}`);
  const data = await resp.json();
  const dates = data.dates || [];
  return dates.length ? dates[0].games || [] : [];
}

// ---- classification ----------------------------------------------

function bucketOf(game) {
  const s = (game.status && game.status.abstractGameState) || "";
  const detailed = (game.status && game.status.detailedState) || "";
  if (/postpon|cancel|suspend/i.test(detailed)) return "other";
  if (s === "Live") return "live";
  if (s === "Final") return "final";
  return "scheduled"; // Preview / Pre-Game / Warmup / Scheduled / Delayed
}

// ---- rendering ----------------------------------------------------

function teamRow(side, game, opts) {
  const t = game.teams[side];
  const team = t.team || {};
  const score = (typeof t.score === "number") ? t.score : "";
  const rec = t.leagueRecord
    ? `${t.leagueRecord.wins}-${t.leagueRecord.losses}`
    : "";
  const cls = ["team-row"];
  if (opts.decided) cls.push(t.isWinner ? "winner" : "loser");

  return `
    <div class="${cls.join(" ")}">
      <img class="team-logo" src="${LOGO(team.id)}" alt="" loading="lazy"
           onerror="this.style.visibility='hidden'">
      <span class="team-name">
        <span class="team-abbr">${esc(team.abbreviation || team.teamName || "—")}</span>
        ${rec ? `<span class="team-rec">${rec}</span>` : ""}
      </span>
      <span class="team-score">${score}</span>
    </div>`;
}

function basesHtml(ls) {
  const o = ls.offense || {};
  const on1 = !!o.first, on2 = !!o.second, on3 = !!o.third;
  return `
    <span class="bases" title="Runners on base">
      <span class="base second ${on2 ? "on" : ""}"></span>
      <span class="base first ${on1 ? "on" : ""}"></span>
      <span class="base third ${on3 ? "on" : ""}"></span>
    </span>`;
}

function liveFootHtml(game) {
  const ls = game.linescore || {};
  const half = ls.inningState || (ls.isTopInning ? "Top" : "Bottom");
  const ord = ls.currentInningOrdinal || (ls.currentInning ? `${ls.currentInning}` : "");
  const outs = (typeof ls.outs === "number") ? ls.outs : 0;
  const midEnd = /mid|end/i.test(half);
  const arrow = /top|mid/i.test(half) ? "▲" : "▼";

  const outDots = [0, 1, 2]
    .map((i) => `<span class="out-dot ${i < outs ? "on" : ""}"></span>`)
    .join("");

  // Balls/strikes only meaningful mid-inning (not during Middle/End breaks).
  const bs = (!midEnd && typeof ls.balls === "number" && typeof ls.strikes === "number")
    ? `<span class="count-bs">${ls.balls}-${ls.strikes}</span>` : "";

  return `
    <div class="live-state">
      <span class="inning"><span class="arrow">${arrow}</span> ${esc(half)} ${esc(ord)}</span>
      ${midEnd ? "" : basesHtml(ls)}
      ${bs}
      <span class="outs">${outDots}<span style="margin-left:4px">${outs} out${outs === 1 ? "" : "s"}</span></span>
    </div>`;
}

function pitcherLine(game) {
  const a = game.teams.away.probablePitcher;
  const h = game.teams.home.probablePitcher;
  if (!a && !h) return "";
  const name = (p) => p ? `<span class="pname">${esc(p.fullName)}</span>` : "TBD";
  return `<div class="pitchers">SP: ${name(a)} vs ${name(h)}</div>`;
}

function gameCard(game) {
  const bucket = bucketOf(game);
  const status = game.status || {};
  const detailed = status.detailedState || "";
  const decided = bucket === "final";

  let badge, foot;
  if (bucket === "live") {
    badge = `<span class="badge badge-live"><span class="live-dot"></span>LIVE</span>`;
    foot = liveFootHtml(game);
  } else if (bucket === "final") {
    const label = /^final$/i.test(detailed) ? "FINAL" : detailed.toUpperCase();
    badge = `<span class="badge badge-final">${esc(label)}</span>`;
    const ls = game.linescore || {};
    const extra = (ls.currentInning && ls.currentInning !== ls.scheduledInnings)
      ? `<span>F/${ls.currentInning}</span>` : "<span></span>";
    foot = extra + pitcherLine(game) ;
  } else if (bucket === "other") {
    badge = `<span class="badge badge-warn">${esc(detailed.toUpperCase())}</span>`;
    foot = `<span>${esc(fmtClock(game.gameDate))} scheduled</span>` + pitcherLine(game);
  } else {
    badge = `<span class="badge badge-sched">${esc(fmtClock(game.gameDate))}</span>`;
    foot = pitcherLine(game) || "<span>Scheduled</span>";
  }

  const venue = (game.venue && game.venue.name) || "";

  return `
    <article class="card ${bucket === "live" ? "is-live" : ""}">
      <div class="card-head">
        ${badge}
        <span class="venue" title="${esc(venue)}">${esc(venue)}</span>
      </div>
      <div class="teams">
        ${teamRow("away", game, { decided })}
        ${teamRow("home", game, { decided })}
      </div>
      <div class="card-foot">${foot}</div>
    </article>`;
}

function groupSection(title, cls, games) {
  if (!games.length) return "";
  const cards = games.map(gameCard).join("");
  return `
    <section class="group ${cls}">
      <h2 class="group-head"><span class="dot"></span>${title}
        <span class="count">(${games.length})</span></h2>
      <div class="cards">${cards}</div>
    </section>`;
}

function sortByTime(a, b) {
  return new Date(a.gameDate) - new Date(b.gameDate);
}

function render(games) {
  if (!games.length) {
    els.board.innerHTML =
      `<p class="empty">No MLB games scheduled for ${esc(fmtDateHeading(state.date))}.</p>`;
    return;
  }

  const live = [], scheduled = [], final = [], other = [];
  for (const g of games) {
    const b = bucketOf(g);
    if (b === "live") live.push(g);
    else if (b === "final") final.push(g);
    else if (b === "other") other.push(g);
    else scheduled.push(g);
  }
  live.sort(sortByTime);
  scheduled.sort(sortByTime);
  final.sort(sortByTime);
  other.sort(sortByTime);

  els.board.innerHTML =
    groupSection("Live", "group-live", live) +
    groupSection("Scheduled", "group-sched", scheduled) +
    groupSection("Final", "group-final", final) +
    groupSection("Postponed / Other", "group-final", other);
}

// ---- polling / lifecycle -----------------------------------------

async function poll() {
  if (state.inFlight) return;
  state.inFlight = true;
  try {
    const games = await fetchSchedule(state.date);
    render(games);
    state.lastGood = new Date();
    const liveCount = games.filter((g) => bucketOf(g) === "live").length;
    els.statusText.textContent =
      `${fmtDateHeading(state.date)} · ${games.length} game${games.length === 1 ? "" : "s"}` +
      (liveCount ? ` · ${liveCount} live` : "") +
      ` · updated ${state.lastGood.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
    clearError();
  } catch (err) {
    showError(err);
  } finally {
    state.inFlight = false;
    state.nextPollAt = Date.now() + REFRESH_MS;
  }
}

function showError(err) {
  const msg = (err && err.message) || "Network error";
  const note = state.lastGood
    ? `Showing data from ${state.lastGood.toLocaleTimeString()}. Will retry.`
    : "Could not load the scoreboard. Will retry.";
  // Prepend a banner without wiping the board (so last-good data stays visible).
  const existing = document.getElementById("err-banner");
  const html = `<div id="err-banner" class="error-banner">⚠ ${esc(msg)}. ${note}</div>`;
  if (existing) existing.outerHTML = html;
  else els.board.insertAdjacentHTML("afterbegin", html);
  els.statusText.textContent = `Connection problem — ${esc(msg)}`;
}

function clearError() {
  const existing = document.getElementById("err-banner");
  if (existing) existing.remove();
}

function tickCountdown() {
  const secs = Math.max(0, Math.ceil((state.nextPollAt - Date.now()) / 1000));
  els.refreshState.textContent = state.inFlight ? "refreshing…" : `next refresh in ${secs}s`;
}

function startTimers() {
  if (state.timer) clearInterval(state.timer);
  if (state.countdown) clearInterval(state.countdown);
  state.nextPollAt = Date.now() + REFRESH_MS;
  state.timer = setInterval(poll, REFRESH_MS);
  state.countdown = setInterval(tickCountdown, 1000);
}

function setDate(date, { resetTimers = true } = {}) {
  state.date = date;
  els.datePicker.value = date;
  els.board.innerHTML = `<p class="placeholder">Loading games for ${esc(date)}…</p>`;
  els.statusText.textContent = "Loading…";
  poll();
  if (resetTimers) startTimers();
}

// Pause polling when the tab is hidden; refresh immediately when it returns.
function handleVisibility() {
  if (document.hidden) {
    if (state.timer) clearInterval(state.timer);
    if (state.countdown) clearInterval(state.countdown);
    state.timer = null;
    els.refreshState.textContent = "paused (tab hidden)";
  } else {
    poll();
    startTimers();
  }
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function init() {
  els.refreshSecs.textContent = Math.round(REFRESH_MS / 1000);

  // Allow ?date=YYYY-MM-DD deep links; otherwise today (ET).
  const param = new URLSearchParams(location.search).get("date");
  const initial = /^\d{4}-\d{2}-\d{2}$/.test(param || "") ? param : todayET();

  els.datePicker.addEventListener("change", (e) => {
    if (e.target.value) setDate(e.target.value);
  });
  els.prevDay.addEventListener("click", () => setDate(shiftDate(state.date, -1)));
  els.nextDay.addEventListener("click", () => setDate(shiftDate(state.date, 1)));
  els.todayBtn.addEventListener("click", () => setDate(todayET()));
  els.refreshBtn.addEventListener("click", () => { poll(); startTimers(); });
  document.addEventListener("visibilitychange", handleVisibility);

  setDate(initial);
}

init();
