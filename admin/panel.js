const statusEl = document.getElementById("status");
const form = document.getElementById("settingsForm");
const premiumPercentEl = document.getElementById("premiumPercent");
const fixedAudEl = document.getElementById("fixedAud");
const logoutBtn = document.getElementById("logoutBtn");

async function loadConfig() {
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

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  statusEl.textContent = "Saving...";
  const payload = {
    premiumPercent: Number(premiumPercentEl.value),
    fixedAud: Number(fixedAudEl.value),
  };

  try {
    const res = await fetch("/api/admin/premium-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      window.location.href = "/admin/login";
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Save failed");
    }
    statusEl.textContent = "Saved.";
  } catch (err) {
    statusEl.textContent = err.message;
  }
});

logoutBtn.addEventListener("click", async () => {
  await fetch("/api/admin/logout", { method: "POST" }).catch(() => null);
  window.location.href = "/admin/login";
});

loadConfig().catch((err) => {
  statusEl.textContent = err.message;
});
