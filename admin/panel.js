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
const refreshMintsBtn = document.getElementById("refreshMintsBtn");
const mintRowsCountEl = document.getElementById("mintRowsCount");
const mintTotalCountEl = document.getElementById("mintTotalCount");
const mintsTableBodyEl = document.getElementById("mintsTableBody");
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
  const activeView = view === "serials" || view === "mints" ? view : "pricing";
  viewLinks.forEach((link) => link.classList.toggle("active", link.dataset.viewLink === activeView));
  viewSections.forEach((section) => {
    section.classList.toggle("hidden", section.dataset.viewSection !== activeView);
  });
  if (activeView === "serials") {
    viewTitleEl.textContent = "Serial Inventory";
    viewSubtitleEl.textContent = "Manage and replace available mint serials.";
  } else if (activeView === "mints") {
    viewTitleEl.textContent = "Mint History";
    viewSubtitleEl.textContent = "Review all minted records.";
    loadMintHistory().catch((err) => setStatus(err.message));
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

function shortWallet(addr) {
  const text = String(addr || "");
  if (text.length < 12) return text;
  return `${text.slice(0, 8)}...${text.slice(-6)}`;
}

function formatDate(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleString();
}

async function loadMintHistory() {
  const res = await fetch("/api/admin/mints?limit=250", { cache: "no-store" });
  if (res.status === 401) {
    window.location.href = "/admin/login";
    return;
  }
  if (!res.ok) throw new Error("Unable to load mint history");
  const data = await res.json();
  const items = Array.isArray(data.items) ? data.items : [];
  mintRowsCountEl.textContent = String(items.length);
  mintTotalCountEl.textContent = String(Number(data.total || 0));

  if (!items.length) {
    mintsTableBodyEl.innerHTML = `<tr><td colspan="6">No mints yet.</td></tr>`;
    return;
  }

  mintsTableBodyEl.innerHTML = items
    .map((item) => {
      const value = item.usd_text || (Number.isFinite(Number(item.usd_raw)) ? `$${Number(item.usd_raw).toFixed(2)}` : "--");
      return `
        <tr>
          <td>${formatDate(item.minted_at || item.created_at)}</td>
          <td title="${String(item.wallet_address || "")}">${shortWallet(item.wallet_address)}</td>
          <td>${String(item.serial || "")}</td>
          <td>${Number(item.ounces || 0).toFixed(2)}</td>
          <td>${Number(item.slvr || 0).toFixed(0)}</td>
          <td>${value}</td>
        </tr>
      `;
    })
    .join("");
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

refreshMintsBtn?.addEventListener("click", async () => {
  setStatus("Refreshing mint history...");
  try {
    await loadMintHistory();
    setStatus("Mint history refreshed.");
  } catch (err) {
    setStatus(err.message);
  }
});

Promise.all([loadPremiumConfig(), loadSerials()])
  .then(() => setStatus("Admin panel ready."))
  .catch((err) => setStatus(err.message));

function applyViewFromHash() {
  const hash = (window.location.hash || "").replace("#", "");
  setView(hash === "serials" || hash === "mints" ? hash : "pricing");
}

viewLinks.forEach((link) => {
  link.addEventListener("click", () => {
    const view = link.dataset.viewLink === "serials" ? "serials" : "pricing";
    setView(view);
  });
});

window.addEventListener("hashchange", applyViewFromHash);
applyViewFromHash();
