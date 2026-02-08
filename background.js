// background.js — MV3 Service Worker
// Handles alarm scheduling and fires ghost commits throughout the day.
// Supports both random (spread across 06–22) and fixed-time scheduling.

import { createGhostCommit } from "./github-api.js";

const ALARM_NAME = "ghost-tick";
const ALARM_PERIOD_MINUTES = 5; // check every 5 min (needed for fixed-time accuracy)

// ─── Helpers ────────────────────────────────────────────────

function todayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function getConfig() {
  const { config } = await chrome.storage.local.get("config");
  return config || null;
}

async function getDailyState() {
  const { dailyState } = await chrome.storage.local.get("dailyState");
  const today = todayKey();
  if (dailyState && dailyState.date === today) return dailyState;
  const fresh = { date: today, count: 0, firedSlots: [] };
  await chrome.storage.local.set({ dailyState: fresh });
  return fresh;
}

async function incrementDailyCount(slot = null) {
  const state = await getDailyState();
  state.count += 1;
  if (slot) {
    state.firedSlots = state.firedSlots || [];
    state.firedSlots.push(slot);
  }
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
  await chrome.storage.local.set({ errorLog: log.slice(0, 20) });
}

// ─── Commit execution ───────────────────────────────────────

// Mutex: prevent two commits from running at the same time.
let commitLock = false;

async function doCommit(config) {
  if (commitLock) {
    throw new Error("BUSY: a commit is already in progress");
  }
  commitLock = true;
  try {
    const result = await createGhostCommit(
      config.token,
      config.owner,
      config.repo,
      config.email,
      config.authorName
    );
    return result;
  } finally {
    commitLock = false;
  }
}

// ─── Core: Random mode ──────────────────────────────────────

async function maybeCommitRandom(config) {
  const state = await getDailyState();
  const target = config.commitsPerDay || 1;

  if (state.count >= target) return;

  const checksPerDay = (16 * 60) / ALARM_PERIOD_MINUTES;
  const remaining = target - state.count;
  const checksLeft = Math.max(1, checksPerDay - state.count);
  const probability = remaining / checksLeft;

  const hour = new Date().getHours();
  // Outside 6 AM – 10 PM window? Skip (unless forcing)
  if (hour < 6 || hour >= 22) return;

  const forceWindow = hour >= 21;
  if (!forceWindow && Math.random() > probability) return;

  const result = await doCommit(config);
  await incrementDailyCount();
  await setLastCommitInfo(result.sha, result.date);

  console.log(
    `[Ghost Commits] ✅ Random commit ${state.count + 1}/${target} — ${result.sha.slice(0, 7)}`
  );
}

// ─── Core: Fixed-time mode ──────────────────────────────────

async function maybeCommitFixed(config) {
  const state = await getDailyState();
  const times = config.fixedTimes || [];
  const now = nowHHMM();
  const firedSlots = state.firedSlots || [];

  for (const slot of times) {
    if (firedSlots.includes(slot)) continue; // already fired this slot today

    // Check if current time is within the window [slot, slot + ALARM_PERIOD_MINUTES]
    const [sh, sm] = slot.split(":").map(Number);
    const slotMins = sh * 60 + sm;
    const [nh, nm] = now.split(":").map(Number);
    const nowMins = nh * 60 + nm;

    // Fire if we're within the alarm window after the slot
    if (nowMins >= slotMins && nowMins < slotMins + ALARM_PERIOD_MINUTES) {
      const result = await doCommit(config);
      await incrementDailyCount(slot);
      await setLastCommitInfo(result.sha, result.date);

      console.log(
        `[Ghost Commits] ✅ Fixed commit @ ${slot} — ${result.sha.slice(0, 7)}`
      );
    }
  }
}

// ─── Core: Dispatcher ───────────────────────────────────────

async function tick() {
  try {
    const config = await getConfig();
    if (!config || !config.enabled) return;

    const mode = config.scheduleMode || "random";
    if (mode === "fixed") {
      await maybeCommitFixed(config);
    } else {
      await maybeCommitRandom(config);
    }
  } catch (err) {
    console.error("[Ghost Commits] ❌", err);
    await logError(err.message || String(err));
  }
}

// ─── Force commit (always fires, retries once on failure) ───

let lastForceCommitTime = 0;
const FORCE_COOLDOWN_MS = 4000; // 4-second cooldown between force commits

async function forceCommit() {
  const now = Date.now();
  const remaining = FORCE_COOLDOWN_MS - (now - lastForceCommitTime);
  if (remaining > 0) {
    return { ok: false, error: `Cooldown: wait ${Math.ceil(remaining / 1000)}s`, cooldown: Math.ceil(remaining / 1000) };
  }

  try {
    const config = await getConfig();
    if (!config) throw new Error("Not configured");

    let result;
    try {
      result = await doCommit(config);
    } catch (firstErr) {
      // If the lock was busy or a transient git error, wait briefly and retry once
      if (firstErr.message.includes("BUSY")) {
        await new Promise((r) => setTimeout(r, 2000));
        result = await doCommit(config);
      } else {
        throw firstErr;
      }
    }

    await incrementDailyCount("force");
    await setLastCommitInfo(result.sha, result.date);
    lastForceCommitTime = Date.now();

    console.log(`[Ghost Commits] ⚡ Force commit — ${result.sha.slice(0, 7)}`);
    return { ok: true, sha: result.sha };
  } catch (err) {
    console.error("[Ghost Commits] ❌ Force commit failed:", err);
    await logError(err.message || String(err));
    return { ok: false, error: err.message || String(err) };
  }
}

// ─── Alarm management ───────────────────────────────────────

async function ensureAlarm() {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    chrome.alarms.create(ALARM_NAME, {
      delayInMinutes: 1,
      periodInMinutes: ALARM_PERIOD_MINUTES,
    });
    console.log("[Ghost Commits] ⏰ Alarm created (every 5 min)");
  }
}

async function clearAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  console.log("[Ghost Commits] ⏰ Alarm cleared");
}

// ─── Event listeners ────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  const config = await getConfig();
  if (config?.enabled) await ensureAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  const config = await getConfig();
  if (config?.enabled) await ensureAlarm();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  await tick();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "START") {
    ensureAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "STOP") {
    clearAlarm().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "FORCE_COMMIT") {
    forceCommit().then((result) => sendResponse(result));
    return true;
  }
  if (msg.type === "SCHEDULE_UPDATED") {
    // Re-create alarm to pick up new settings immediately
    clearAlarm()
      .then(() => ensureAlarm())
      .then(() => sendResponse({ ok: true }));
    return true;
  }
});
