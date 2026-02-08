// popup.js — Popup UI logic (hacker edition)

import {
  getAuthenticatedUser,
  getUserEmail,
  createPrivateRepo,
  validateToken,
} from "./github-api.js";

// ─── DOM refs ───────────────────────────────────────────────
const setupSection = document.getElementById("setup-section");
const dashboardSection = document.getElementById("dashboard-section");

const tokenInput = document.getElementById("token-input");
const commitsInput = document.getElementById("commits-input");
const decBtn = document.getElementById("dec-btn");
const incBtn = document.getElementById("inc-btn");
const saveBtn = document.getElementById("save-btn");
const saveLabel = document.getElementById("save-label");
const saveSpinner = document.getElementById("save-spinner");
const setupError = document.getElementById("setup-error");

const statusBadge = document.getElementById("status-badge");
const todayCount = document.getElementById("today-count");
const lastCommitEl = document.getElementById("last-commit");
const repoLink = document.getElementById("repo-link");
const editCommits = document.getElementById("edit-commits");
const editDecBtn = document.getElementById("edit-dec-btn");
const editIncBtn = document.getElementById("edit-inc-btn");
const toggleBtn = document.getElementById("toggle-btn");
const disconnectBtn = document.getElementById("disconnect-btn");
const dashboardError = document.getElementById("dashboard-error");

const guideToggle = document.getElementById("guide-toggle");
const guideSteps = document.getElementById("guide-steps");
const scheduleHint = document.getElementById("schedule-hint");
const scheduleInfo = document.getElementById("schedule-info");
const nextCheck = document.getElementById("next-check");

const forceCommitBtn = document.getElementById("force-commit-btn");
const forceLabel = document.getElementById("force-label");
const forceSpinner = document.getElementById("force-spinner");
const forceStatus = document.getElementById("force-status");

// Schedule mode buttons (setup)
const modeRandom = document.getElementById("mode-random");
const modeFixed = document.getElementById("mode-fixed");
const fixedTimesSetup = document.getElementById("fixed-times-setup");
const timeSlotsSetup = document.getElementById("time-slots-setup");

// Schedule mode buttons (dashboard)
const dashModeRandom = document.getElementById("dash-mode-random");
const dashModeFixed = document.getElementById("dash-mode-fixed");
const fixedTimesDash = document.getElementById("fixed-times-dash");
const timeSlotsDash = document.getElementById("time-slots-dash");

// ─── Stepper wiring ────────────────────────────────────────
function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function wireSteppers(input, dec, inc) {
  dec.addEventListener("click", () => {
    input.value = clamp(Number(input.value) - 1, 1, 20);
    input.dispatchEvent(new Event("change"));
  });
  inc.addEventListener("click", () => {
    input.value = clamp(Number(input.value) + 1, 1, 20);
    input.dispatchEvent(new Event("change"));
  });
  input.addEventListener("change", () => {
    input.value = clamp(Number(input.value), 1, 20);
  });
}

wireSteppers(commitsInput, decBtn, incBtn);
wireSteppers(editCommits, editDecBtn, editIncBtn);

// ─── Guide toggle ───────────────────────────────────────────
guideToggle.addEventListener("click", () => {
  guideSteps.classList.toggle("hidden");
  guideToggle.classList.toggle("open");
});

// ─── Schedule hint (setup view) ─────────────────────────────

// Get short local timezone name (e.g. "EST", "PST", "GMT+5")
const localTZ = Intl.DateTimeFormat(undefined, { timeZoneName: "short" })
  .formatToParts(new Date())
  .find((p) => p.type === "timeZoneName")?.value || "local";

function updateScheduleHint(n) {
  const mode = modeFixed.classList.contains("active") ? "fixed" : "random";
  if (scheduleHint) {
    if (mode === "random") {
      scheduleHint.textContent = `> ${n} commit${n > 1 ? "s" : ""} // random // 06:00–22:00 ${localTZ}`;
    } else {
      scheduleHint.textContent = `> ${n} commit${n > 1 ? "s" : ""} // fixed times (${localTZ})`;
    }
  }
}
commitsInput.addEventListener("change", () => {
  const n = Number(commitsInput.value);
  updateScheduleHint(n);
  renderTimeSlots(timeSlotsSetup, n, "setup");
});

// ─── Mode Toggle Logic ─────────────────────────────────────
function wireModeBtns(btnRandom, btnFixed, fixedSection, slotsContainer, commitsEl, context) {
  btnRandom.addEventListener("click", () => {
    btnRandom.classList.add("active");
    btnFixed.classList.remove("active");
    fixedSection.classList.add("hidden");
    if (context === "setup") updateScheduleHint(Number(commitsEl.value));
    if (context === "dash") saveScheduleMode("random");
  });
  btnFixed.addEventListener("click", () => {
    btnFixed.classList.add("active");
    btnRandom.classList.remove("active");
    fixedSection.classList.remove("hidden");
    const n = Number(commitsEl.value);
    renderTimeSlots(slotsContainer, n, context);
    if (context === "setup") updateScheduleHint(n);
    if (context === "dash") saveScheduleMode("fixed");
  });
}

wireModeBtns(modeRandom, modeFixed, fixedTimesSetup, timeSlotsSetup, commitsInput, "setup");
wireModeBtns(dashModeRandom, dashModeFixed, fixedTimesDash, timeSlotsDash, editCommits, "dash");

async function saveScheduleMode(mode) {
  const { config } = await chrome.storage.local.get("config");
  if (!config) return;
  config.scheduleMode = mode;
  if (mode === "fixed") {
    config.fixedTimes = collectTimes(timeSlotsDash);
  }
  await chrome.storage.local.set({ config });
  chrome.runtime.sendMessage({ type: "SCHEDULE_UPDATED" });
  await showDashboard(config);
}

// ─── Time Slots Rendering ───────────────────────────────────
function defaultTimes(n) {
  // Spread evenly between 08:00 and 20:00
  const times = [];
  const startH = 8;
  const endH = 20;
  const gap = (endH - startH) / Math.max(n, 1);
  for (let i = 0; i < n; i++) {
    const h = Math.floor(startH + gap * i);
    const m = Math.round(((startH + gap * i) - h) * 60);
    times.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  return times;
}

function renderTimeSlots(container, n, context) {
  container.innerHTML = "";
  // Try to load existing times from storage or use defaults
  chrome.storage.local.get("config", ({ config }) => {
    let times = config?.fixedTimes || [];
    // Pad or trim to match n
    while (times.length < n) {
      const defaults = defaultTimes(n);
      times.push(defaults[times.length] || "12:00");
    }
    times = times.slice(0, n);

    times.forEach((t, i) => {
      const slot = document.createElement("div");
      slot.className = "time-slot";

      const label = document.createElement("span");
      label.className = "time-slot-label";
      label.textContent = `EXEC_${String(i + 1).padStart(2, "0")}`;

      const input = document.createElement("input");
      input.type = "time";
      input.value = t;
      input.dataset.index = i;
      input.addEventListener("change", () => {
        if (context === "dash") {
          saveTimes(container);
        }
      });

      slot.appendChild(label);
      slot.appendChild(input);
      container.appendChild(slot);
    });
  });
}

function collectTimes(container) {
  const inputs = container.querySelectorAll('input[type="time"]');
  return Array.from(inputs).map((inp) => inp.value).sort();
}

async function saveTimes(container) {
  const { config } = await chrome.storage.local.get("config");
  if (!config) return;
  config.fixedTimes = collectTimes(container);
  await chrome.storage.local.set({ config });
  chrome.runtime.sendMessage({ type: "SCHEDULE_UPDATED" });
}

// ─── Helpers ────────────────────────────────────────────────
function showError(el, msg) {
  el.innerHTML = msg;
  el.classList.remove("hidden");
}

function hideError(el) {
  el.classList.add("hidden");
}

function showSection(section) {
  setupSection.classList.add("hidden");
  dashboardSection.classList.add("hidden");
  section.classList.remove("hidden");
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Init ───────────────────────────────────────────────────
async function init() {
  const { config } = await chrome.storage.local.get("config");
  if (config && config.token) {
    await showDashboard(config);
  } else {
    showSection(setupSection);
  }
}

// ─── Dashboard View ─────────────────────────────────────────
async function showDashboard(config) {
  showSection(dashboardSection);

  // Status badge
  if (config.enabled) {
    statusBadge.textContent = "ONLINE";
    statusBadge.className = "badge badge-active";
    toggleBtn.textContent = "PAUSE";
  } else {
    statusBadge.textContent = "OFFLINE";
    statusBadge.className = "badge badge-paused";
    toggleBtn.textContent = "RESUME";
  }

  // Commits per day
  editCommits.value = config.commitsPerDay || 3;

  // Repo link
  if (config.html_url) {
    repoLink.href = config.html_url;
    repoLink.textContent = `${config.owner}/${config.repo}`;
  }

  // Today's count
  const { dailyState } = await chrome.storage.local.get("dailyState");
  const today = new Date().toISOString().slice(0, 10);
  const count = dailyState && dailyState.date === today ? dailyState.count : 0;
  todayCount.textContent = `${count} / ${config.commitsPerDay} deployed`;

  // Last commit
  const { lastCommit } = await chrome.storage.local.get("lastCommit");
  lastCommitEl.textContent = lastCommit
    ? `${lastCommit.sha.slice(0, 7)} · ${formatDate(lastCommit.date)}`
    : "—";

  // Schedule info
  const n = config.commitsPerDay || 3;
  const mode = config.scheduleMode || "random";
  if (mode === "fixed" && config.fixedTimes?.length) {
    scheduleInfo.textContent = config.fixedTimes.join(", ") + ` ${localTZ}`;
  } else {
    scheduleInfo.textContent = `${n}x/day // 06–22 ${localTZ}`;
  }

  // Mode buttons
  if (mode === "fixed") {
    dashModeFixed.classList.add("active");
    dashModeRandom.classList.remove("active");
    fixedTimesDash.classList.remove("hidden");
    renderTimeSlots(timeSlotsDash, n, "dash");
  } else {
    dashModeRandom.classList.add("active");
    dashModeFixed.classList.remove("active");
    fixedTimesDash.classList.add("hidden");
  }

  // Next check
  try {
    const alarm = await chrome.alarms.get("ghost-tick");
    if (alarm && config.enabled) {
      const eta = new Date(alarm.scheduledTime);
      const minsLeft = Math.max(0, Math.round((eta - Date.now()) / 60000));
      if (minsLeft < 1) {
        nextCheck.textContent = "IMMINENT";
      } else if (minsLeft === 1) {
        nextCheck.textContent = "T-1 min";
      } else {
        nextCheck.textContent = `T-${minsLeft} min`;
      }
    } else {
      nextCheck.textContent = config.enabled ? "BOOTING…" : "OFFLINE";
    }
  } catch {
    nextCheck.textContent = config.enabled ? "~30 min cycle" : "OFFLINE";
  }
}

// ─── Force Commit ───────────────────────────────────────────
let forceCooldownTimer = null;

function startForceCooldown(seconds) {
  forceCommitBtn.disabled = true;
  let remaining = seconds;
  forceLabel.textContent = `⚡ COOLDOWN ${remaining}s`;
  forceCommitBtn.classList.add("cooldown");

  forceCooldownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(forceCooldownTimer);
      forceCooldownTimer = null;
      forceCommitBtn.disabled = false;
      forceLabel.textContent = "⚡ EXECUTE_NOW";
      forceCommitBtn.classList.remove("cooldown");
    } else {
      forceLabel.textContent = `⚡ COOLDOWN ${remaining}s`;
    }
  }, 1000);
}

forceCommitBtn.addEventListener("click", async () => {
  if (forceCommitBtn.disabled) return;

  forceCommitBtn.disabled = true;
  forceLabel.textContent = "⚡ DEPLOYING…";
  forceSpinner.classList.remove("hidden");
  forceStatus.classList.add("hidden");
  forceStatus.classList.remove("error-status");

  try {
    const response = await chrome.runtime.sendMessage({ type: "FORCE_COMMIT" });

    if (response && response.ok) {
      forceStatus.textContent = `> deployed: ${response.sha?.slice(0, 7) || "ok"}`;
      forceStatus.classList.remove("hidden", "error-status");

      // Refresh dashboard
      const { config } = await chrome.storage.local.get("config");
      if (config) await showDashboard(config);

      // 4-second cooldown
      startForceCooldown(4);
    } else if (response && response.cooldown) {
      // Server-side cooldown
      forceStatus.textContent = `> cooldown: wait ${response.cooldown}s`;
      forceStatus.classList.remove("hidden");
      forceStatus.classList.add("error-status");
      startForceCooldown(response.cooldown);
    } else {
      // Commit failed — show the actual error
      const errMsg = response?.error || "unknown error";
      forceStatus.textContent = `> FAILED: ${errMsg}`;
      forceStatus.classList.remove("hidden");
      forceStatus.classList.add("error-status");
      forceCommitBtn.disabled = false;
      forceLabel.textContent = "⚡ EXECUTE_NOW";
    }
  } catch (err) {
    forceStatus.textContent = `> ERROR: ${err.message || "connection failed"}`;
    forceStatus.classList.remove("hidden");
    forceStatus.classList.add("error-status");
    forceCommitBtn.disabled = false;
    forceLabel.textContent = "⚡ EXECUTE_NOW";
  } finally {
    forceSpinner.classList.add("hidden");
  }
});

// ─── Save / Connect ─────────────────────────────────────────
saveBtn.addEventListener("click", async () => {
  hideError(setupError);
  const token = tokenInput.value.trim();
  const commitsPerDay = clamp(Number(commitsInput.value), 1, 20);

  if (!token) {
    showError(setupError, "> ERROR: token required");
    return;
  }

  saveBtn.disabled = true;
  saveLabel.textContent = "> CONNECTING…";
  saveSpinner.classList.remove("hidden");

  try {
    // 1. Validate token & check scopes
    const { user, scopes } = await validateToken(token);

    if (scopes !== null && !scopes.includes("repo")) {
      showError(
        setupError,
        `> ERROR: missing <strong>repo</strong> scope. ` +
          `<a href="https://github.com/settings/tokens/new?scopes=repo&description=Ghost+Commits" ` +
          `target="_blank">create new token →</a>`
      );
      return;
    }

    const email = await getUserEmail(token);

    if (!email) {
      showError(
        setupError,
        "> ERROR: no verified email found. Ghost commits need a verified email for your contribution graph."
      );
      return;
    }

    // 2. Create (or find) the private repo
    const repo = await createPrivateRepo(token);

    // 3. Determine schedule mode & times
    const scheduleMode = modeFixed.classList.contains("active") ? "fixed" : "random";
    const fixedTimes = scheduleMode === "fixed" ? collectTimes(timeSlotsSetup) : [];

    // 4. Save config
    const config = {
      token,
      owner: repo.owner,
      repo: repo.repo,
      html_url: repo.html_url,
      email,
      authorName: user.name || user.login,
      commitsPerDay,
      scheduleMode,
      fixedTimes,
      enabled: true,
    };
    await chrome.storage.local.set({ config });

    // 5. Tell background to start
    chrome.runtime.sendMessage({ type: "START" });

    // 6. Show dashboard
    await showDashboard(config);
  } catch (err) {
    console.error(err);
    if (err.status === 403) {
      showError(
        setupError,
        `> ACCESS_DENIED: insufficient permissions. ` +
          `<a href="https://github.com/settings/tokens/new?scopes=repo&description=Ghost+Commits" ` +
          `target="_blank">create token with repo scope →</a>`
      );
    } else if (err.status === 401) {
      showError(setupError, "> AUTH_FAILED: invalid token");
    } else {
      showError(setupError, `> ERROR: ${err.message}`);
    }
  } finally {
    saveBtn.disabled = false;
    saveLabel.textContent = "> INITIALIZE";
    saveSpinner.classList.add("hidden");
  }
});

// ─── Toggle enable/disable ──────────────────────────────────
toggleBtn.addEventListener("click", async () => {
  const { config } = await chrome.storage.local.get("config");
  if (!config) return;

  config.enabled = !config.enabled;
  await chrome.storage.local.set({ config });

  if (config.enabled) {
    chrome.runtime.sendMessage({ type: "START" });
  } else {
    chrome.runtime.sendMessage({ type: "STOP" });
  }

  await showDashboard(config);
});

// ─── Edit commits per day ───────────────────────────────────
editCommits.addEventListener("change", async () => {
  const { config } = await chrome.storage.local.get("config");
  if (!config) return;
  config.commitsPerDay = clamp(Number(editCommits.value), 1, 20);
  // If in fixed mode, re-render slots
  if (config.scheduleMode === "fixed") {
    renderTimeSlots(timeSlotsDash, config.commitsPerDay, "dash");
  }
  await chrome.storage.local.set({ config });
  chrome.runtime.sendMessage({ type: "SCHEDULE_UPDATED" });
  await showDashboard(config);
});

// ─── Disconnect ─────────────────────────────────────────────
disconnectBtn.addEventListener("click", async () => {
  if (!confirm("TERMINATE? Ghost commits will stop. Repo remains on GitHub.")) {
    return;
  }
  chrome.runtime.sendMessage({ type: "STOP" });
  await chrome.storage.local.clear();
  tokenInput.value = "";
  commitsInput.value = 3;
  hideError(dashboardError);
  showSection(setupSection);
});

// ─── Boot ───────────────────────────────────────────────────
init();
