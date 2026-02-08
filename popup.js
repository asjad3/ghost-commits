// popup.js — Popup UI logic

import {
  getAuthenticatedUser,
  getUserEmail,
  createPrivateRepo,
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

// ─── Helpers ────────────────────────────────────────────────
function showError(el, msg) {
  el.textContent = msg;
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

// ─── Init: decide which view to show ────────────────────────
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
    statusBadge.textContent = "Active";
    statusBadge.className = "badge badge-active";
    toggleBtn.textContent = "Pause";
  } else {
    statusBadge.textContent = "Paused";
    statusBadge.className = "badge badge-paused";
    toggleBtn.textContent = "Resume";
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
  const count =
    dailyState && dailyState.date === today ? dailyState.count : 0;
  todayCount.textContent = `${count} / ${config.commitsPerDay} commits`;

  // Last commit
  const { lastCommit } = await chrome.storage.local.get("lastCommit");
  lastCommitEl.textContent = lastCommit
    ? `${lastCommit.sha.slice(0, 7)} · ${formatDate(lastCommit.date)}`
    : "—";
}

// ─── Save / Connect ─────────────────────────────────────────
saveBtn.addEventListener("click", async () => {
  hideError(setupError);
  const token = tokenInput.value.trim();
  const commitsPerDay = clamp(Number(commitsInput.value), 1, 20);

  if (!token) {
    showError(setupError, "Please enter your GitHub token.");
    return;
  }

  // Disable button, show spinner
  saveBtn.disabled = true;
  saveLabel.textContent = "Connecting…";
  saveSpinner.classList.remove("hidden");

  try {
    // 1. Validate token
    const user = await getAuthenticatedUser(token);
    const email = await getUserEmail(token);

    if (!email) {
      showError(
        setupError,
        "No verified email found on your GitHub account. Ghost commits need a verified email to appear on your contribution graph."
      );
      return;
    }

    // 2. Create (or find) the private repo
    const repo = await createPrivateRepo(token);

    // 3. Save config
    const config = {
      token,
      owner: repo.owner,
      repo: repo.repo,
      html_url: repo.html_url,
      email,
      authorName: user.name || user.login,
      commitsPerDay,
      enabled: true,
    };
    await chrome.storage.local.set({ config });

    // 4. Tell background to start
    chrome.runtime.sendMessage({ type: "START" });

    // 5. Show dashboard
    await showDashboard(config);
  } catch (err) {
    console.error(err);
    showError(setupError, `Error: ${err.message}`);
  } finally {
    saveBtn.disabled = false;
    saveLabel.textContent = "Connect & Start";
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
  await chrome.storage.local.set({ config });
  await showDashboard(config);
});

// ─── Disconnect ─────────────────────────────────────────────
disconnectBtn.addEventListener("click", async () => {
  if (!confirm("Disconnect? This will stop ghost commits. The repo will remain on GitHub.")) {
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
