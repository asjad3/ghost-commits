// background.js — MV3 Service Worker
// Handles alarm scheduling and fires ghost commits throughout the day.

import { createGhostCommit } from "./github-api.js";

const ALARM_NAME = "ghost-tick";
const ALARM_PERIOD_MINUTES = 30; // check every 30 min

// ─── Helpers ────────────────────────────────────────────────

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

async function getConfig() {
  const { config } = await chrome.storage.local.get("config");
  return config || null;
}

async function getDailyState() {
  const { dailyState } = await chrome.storage.local.get("dailyState");
  const today = todayKey();
  if (dailyState && dailyState.date === today) return dailyState;
  // New day — reset counter
  const fresh = { date: today, count: 0 };
  await chrome.storage.local.set({ dailyState: fresh });
  return fresh;
}

async function incrementDailyCount() {
  const state = await getDailyState();
  state.count += 1;
  await chrome.storage.local.set({ dailyState: state });
  return state;
}

async function setLastCommitInfo(sha, date) {
  await chrome.storage.local.set({ lastCommit: { sha, date } });
}

async function logError(message) {
  const { errorLog } = await chrome.storage.local.get("errorLog");
  const log = errorLog || [];
  log.unshift({ message, time: new Date().toISOString() });
  // Keep only last 20 errors
  await chrome.storage.local.set({ errorLog: log.slice(0, 20) });
}

// ─── Core Logic ─────────────────────────────────────────────

async function maybeCommit() {
  let config;
  try {
    config = await getConfig();
    if (!config || !config.enabled) return;

    const state = await getDailyState();
    const target = config.commitsPerDay || 1;

    if (state.count >= target) return; // done for today

    // Spread commits across ~16 waking hours (06:00–22:00).
    // Decide probabilistically whether to commit now so they don't all
    // cluster at the start of the day.
    const checksPerDay = (16 * 60) / ALARM_PERIOD_MINUTES; // ~32
    const remaining = target - state.count;
    const checksLeft = Math.max(1, checksPerDay - state.count);
    const probability = remaining / checksLeft;

    // Always commit if this is one of the last few checks of the day
    const hour = new Date().getHours();
    const forceWindow = hour >= 21; // force if near end of day
    if (!forceWindow && Math.random() > probability) return;

    // Do the commit
    const result = await createGhostCommit(
      config.token,
      config.owner,
      config.repo,
      config.email,
      config.authorName
    );

    await incrementDailyCount();
    await setLastCommitInfo(result.sha, result.date);

    console.log(
      `[Ghost Commits] ✅ Commit ${state.count + 1}/${target} — ${result.sha.slice(0, 7)}`
    );
  } catch (err) {
    console.error("[Ghost Commits] ❌", err);
    await logError(err.message || String(err));
  }
}

// ─── Alarm management ───────────────────────────────────────

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 1, // first fire in 1 min
      periodInMinutes: ALARM_PERIOD_MINUTES,
    });
    console.log("[Ghost Commits] ⏰ Alarm created");
  }
}

async function clearAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  console.log("[Ghost Commits] ⏰ Alarm cleared");
}

// ─── Event listeners ────────────────────────────────────────

// Service worker starts → ensure alarm is running if enabled
chrome.runtime.onInstalled.addListener(async () => {
  const config = await getConfig();
  if (config?.enabled) await ensureAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  const config = await getConfig();
  if (config?.enabled) await ensureAlarm();
});

// Alarm fires → try to commit
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await maybeCommit();
});

// Listen for messages from the popup to start/stop
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "START") {
    ensureAlarm().then(() => sendResponse({ ok: true }));
    return true; // async
  }
  if (msg.type === "STOP") {
    clearAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "FORCE_COMMIT") {
    maybeCommit().then(() => sendResponse({ ok: true }));
    return true;
  }
});
