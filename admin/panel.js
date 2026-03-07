const statusEl = document.getElementById("status");
const viewTitleEl = document.getElementById("viewTitle");
const viewSubtitleEl = document.getElementById("viewSubtitle");
const viewLinks = Array.from(document.querySelectorAll("[data-view-link]"));
const viewSections = Array.from(document.querySelectorAll("[data-view-section]"));
const settingsForm = document.getElementById("settingsForm");
const premiumPercentEl = document.getElementById("premiumPercent");
const fixedAudEl = document.getElementById("fixedAud");
const serialsForm = document.getElementById("serialsForm");
const serialsInputEl = document.getElementById("serialsInput");
const replaceModeEl = document.getElementById("replaceMode");
const activeTotalEl = document.getElementById("activeTotal");
const availableTotalEl = document.getElementById("availableTotal");
const allocatedTotalEl = document.getElementById("allocatedTotal");
const logoutBtn = document.getElementById("logoutBtn");

function setStatus(message) {
  statusEl.textContent = message;
}

function parseSerialTextarea(value) {
  return String(value || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function renderSummary(summary = {}) {
  activeTotalEl.textContent = Number(summary.totalActive ?? summary.activeTotal ?? 0);
  availableTotalEl.textContent = Number(summary.availableTotal || 0);
  allocatedTotalEl.textContent = Number(summary.allocatedTotal || 0);
}

function setView(view) {
  const activeView = view === "serials" ? "serials" : "pricing";
  viewLinks.forEach((link) => link.classList.toggle("active", link.dataset.viewLink === activeView));
  viewSections.forEach((section) => {
    section.classList.toggle("hidden", section.dataset.viewSection !== activeView);
  });
  if (activeView === "serials") {
    viewTitleEl.textContent = "Serial Inventory";
    viewSubtitleEl.textContent = "Manage and replace available mint serials.";
  } else {
    viewTitleEl.textContent = "Pricing";
    viewSubtitleEl.textContent = "Manage premium formula.";
  }
}

async function loadPremiumConfig() {
  const res = await fetch("/api/admin/premium-config", { cache: "no-store" });
  if (res.status === 401) {
    window.location.href = "/admin/login";
    return;
  }
  if (!res.ok) throw new Error("Unable to load premium settings");
  const data = await res.json();
  premiumPercentEl.value = Number(data.premiumPercent).toFixed(4);
  fixedAudEl.value = Number(data.fixedAud).toFixed(2);
}

async function loadSerials() {
  const res = await fetch("/api/admin/serials", { cache: "no-store" });
  if (res.status === 401) {
    window.location.href = "/admin/login";
    return;
  }
  if (!res.ok) throw new Error("Unable to load serial inventory");
  const data = await res.json();
  const available = (data.items || []).filter((item) => item.is_active && !item.is_allocated).map((item) => item.serial);
  serialsInputEl.value = available.join("\n");
  renderSummary(data.summary);
}

settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("Saving premium settings...");
  try {
    const res = await fetch("/api/admin/premium-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        premiumPercent: Number(premiumPercentEl.value),
        fixedAud: Number(fixedAudEl.value),
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to save premium settings");
    }
    setStatus("Premium settings saved.");
  } catch (err) {
    setStatus(err.message);
  }
});

serialsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("Saving serial inventory...");
  try {
    const serials = parseSerialTextarea(serialsInputEl.value);
    const mode = replaceModeEl.checked ? "replace" : "append";
    const res = await fetch("/api/admin/serials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serials, mode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Failed to save serials");
    renderSummary(data.summary);
    setStatus(`Serial inventory updated (${data.accepted || 0} accepted, mode: ${data.mode}).`);
    await loadSerials();
  } catch (err) {
    setStatus(err.message);
  }
});

logoutBtn.addEventListener("click", async () => {
  await fetch("/api/admin/logout", { method: "POST" }).catch(() => null);
  window.location.href = "/admin/login";
});

Promise.all([loadPremiumConfig(), loadSerials()])
  .then(() => setStatus("Admin panel ready."))
  .catch((err) => setStatus(err.message));

function applyViewFromHash() {
  const hash = (window.location.hash || "").replace("#", "");
  setView(hash === "serials" ? "serials" : "pricing");
}

viewLinks.forEach((link) => {
  link.addEventListener("click", () => {
    const view = link.dataset.viewLink === "serials" ? "serials" : "pricing";
    setView(view);
  });
});

window.addEventListener("hashchange", applyViewFromHash);
applyViewFromHash();
