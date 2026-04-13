const ABC_SILVER_PRICE_URL = "https://r.jina.ai/http://www.sbabullion.com.au/product/1oz-fine-silver-bullion-button/";
const ETH_PRICE_ENDPOINTS = [
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd,aud",
  "https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD,AUD",
];
const FX_ENDPOINT = "https://open.er-api.com/v6/latest/USD";
const PRICE_CACHE_KEY = "slvr_abc_price_cache_v2"; // bump key to drop stale pricing
const PRICE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MINT_HISTORY_LIMIT = 50;
const PREMIUM_CONFIG_TTL_MS = 5 * 60 * 1000;
const ETHERS_CDNS = [
  "https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js",
  "https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js",
  "https://unpkg.com/ethers@5.7.2/dist/ethers.umd.min.js",
];
const TREASURY_ADDRESS = "0x3875FB22655D8bd72310E92c57407d741cF5C8B6";

let spotPriceUsd = null;
let mintPriceUsd = null;
let spotPriceAud = null;
let mintPriceAud = null;
let signerAddress = null;
let mintedItems = [];
let ethPriceUsd = null;
let ethPriceAud = null;
let audRate = null; // AUD per 1 USD
let currentCurrency = "AUD";
let web3Provider = null;

const spotEl = document.getElementById("spotPrice");
const mintEl = document.getElementById("mintPrice");
const walletEl = document.getElementById("walletStatus");
const welcomeEl = document.getElementById("welcomeMessage");
const mintAmountEl = document.getElementById("mintAmount");
const usdValueEl = document.getElementById("usdValue");
const ethValueEl = document.getElementById("ethValue");
const ethValueLabelEl = document.getElementById("ethValueLabel");
const spotFiatSubEl = document.getElementById("spotFiatSub");
const slvrInput = document.getElementById("slvrInput");
const connectBtn = document.getElementById("connectWallet");
const mintBtn = document.getElementById("mintButton");
const refreshBtn = document.getElementById("refreshPrice");
const mintBalanceTopEl = document.getElementById("mintBalanceTop");
const walletEthBalanceEl = document.getElementById("walletEthBalance");
const walletTpcBalanceEl = document.getElementById("walletTpcBalance");
const totalMintedAmountEl = document.getElementById("totalMintedAmount");
const totalMintedValueFiatEl = document.getElementById("totalMintedValueFiat");
const totalMintedValueEthEl = document.getElementById("totalMintedValueEth");
const refreshBtnMobile = document.getElementById("refreshPriceMobile");
const menuToggle = document.getElementById("menuToggle");
const mobileMenu = document.getElementById("mobileMenu");
const closeMenuBtn = document.getElementById("closeMenu");
const currencyButtons = document.querySelectorAll(".currency-btn");
const fiatValueLabel = document.getElementById("fiatValueLabel");
const hasPricingUI = Boolean(spotEl && mintEl);
const hasMintForm = Boolean(slvrInput);
const ETH_DISPLAY_DECIMALS = 6;
const DISPLAY_SPOT_PERCENT_PREMIUM = 0.2; // 20% over ABC spot
const DISPLAY_SPOT_FIXED_AUD = 8.5; // A$8.50 fixed add-on per oz
const DEFAULT_MINT_PERCENT_PREMIUM = 0.04; // 4% maintenance premium over displayed spot
const DEFAULT_MINT_FIXED_AUD = 4.0; // A$4.00 fixed maintenance add-on per oz
const TPC_PER_COIN = 1000;
let mintPercentPremium = DEFAULT_MINT_PERCENT_PREMIUM;
let mintFixedAud = DEFAULT_MINT_FIXED_AUD;
let premiumConfigLoadedAt = 0;
let availableSerials = null;

function getMintApiBase() {
  return window.location.origin;
}

async function fetchMintHistoryFromApi(addr) {
  const url = `${getMintApiBase()}/api/mints/${encodeURIComponent(addr)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Mint history API failed (${res.status})`);
  const data = await res.json();
  return Array.isArray(data?.items) ? data.items : [];
}

async function saveMintItemToApi(addr, item) {
  const url = `${getMintApiBase()}/api/mints/${encodeURIComponent(addr)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(item),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Mint save API failed (${res.status})`);
  return data?.item || null;
}

async function fetchSerialSummary() {
  try {
    const res = await fetch(`${getMintApiBase()}/api/serials/summary`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Serial summary failed (${res.status})`);
    const data = await res.json();
    const available = Number(data?.availableTotal);
    if (Number.isFinite(available)) {
      availableSerials = available;
      setMintBalanceText();
    }
  } catch (err) {
    console.warn("Serial summary unavailable", err.message);
  }
}

async function fetchPremiumConfig(forceFresh = false) {
  if (!forceFresh && Date.now() - premiumConfigLoadedAt < PREMIUM_CONFIG_TTL_MS) return;
  try {
    const res = await fetch(`${getMintApiBase()}/api/premium-config`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Premium config API failed (${res.status})`);
    const data = await res.json();
    const percent = Number(data?.premiumPercent);
    const fixed = Number(data?.fixedAud);
    if (Number.isFinite(percent) && percent >= 0 && percent <= 1) {
      mintPercentPremium = percent;
    } else {
      mintPercentPremium = DEFAULT_MINT_PERCENT_PREMIUM;
    }
    if (Number.isFinite(fixed) && fixed >= 0) {
      mintFixedAud = fixed;
    } else {
      mintFixedAud = DEFAULT_MINT_FIXED_AUD;
    }
    premiumConfigLoadedAt = Date.now();
  } catch (err) {
    console.warn("Premium config unavailable, using defaults", err.message);
    mintPercentPremium = DEFAULT_MINT_PERCENT_PREMIUM;
    mintFixedAud = DEFAULT_MINT_FIXED_AUD;
  }
}

function abcUrlWithCacheBust() {
  return `${ABC_SILVER_PRICE_URL}?ts=${Date.now()}`;
}

function withTimeout(promise, ms, label) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return promise(ctrl.signal)
    .finally(() => clearTimeout(t))
    .catch((err) => {
      if (err.name === "AbortError") throw new Error(`${label} timed out`);
      throw err;
    });
}

async function fetchAbcSpotPriceAud() {
  const res = await withTimeout(
    (signal) => fetch(abcUrlWithCacheBust(), { cache: "no-store", signal }),
    8000,
    "SBA price"
  );
  if (!res.ok) throw new Error(`ABC source failed (HTTP ${res.status})`);
  const html = await res.text();
  const parsed = parseAbcPrice(html);
  if (!Number.isFinite(parsed)) throw new Error("Unable to parse SBA silver price");
  return parsed;
}

function parseAbcPrice(html = "") {
  const regexes = [
    /1\s*oz[\s\S]{0,120}?\$?\s*([0-9][0-9,]*\.[0-9]{2})/i,
    /\$\s*([0-9][0-9,]*\.[0-9]{2})[\s\S]{0,120}?1\s*oz/i,
  ];
  for (const rx of regexes) {
    const match = rx.exec(html);
    if (match) {
      const num = parsePriceText(match[1]);
      if (Number.isFinite(num)) return num;
    }
  }
  return null;
}

function parsePriceText(value) {
  if (!value) return null;
  const normalized = String(value).replace(/[^0-9.,]/g, "").replace(/,/g, "");
  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}

function loadCachedPrices() {
  try {
    const raw = localStorage.getItem(PRICE_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    if (Date.now() - Number(parsed.ts || 0) > PRICE_CACHE_TTL_MS) return null;
    return {
      spotAud: Number(parsed.spotAud),
      mintAud: Number(parsed.mintAud),
      audRate: Number.isFinite(Number(parsed.audRate)) ? Number(parsed.audRate) : null,
    };
  } catch (err) {
    console.warn("Price cache read failed", err.message);
    return null;
  }
}

function persistPrices(spotAud, mintAud, audRate) {
  try {
    const payload = {
      spotAud,
      mintAud,
      audRate: Number.isFinite(audRate) ? audRate : null,
      ts: Date.now(),
    };
    localStorage.setItem(PRICE_CACHE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("Price cache write failed", err.message);
  }
}

async function hydratePrices(forceFresh = false) {
  await fetchPremiumConfig(forceFresh);
  const cached = forceFresh ? null : loadCachedPrices();
  const hasCachedPrices = cached && Number.isFinite(cached.spotAud) && Number.isFinite(cached.mintAud);
  if (!hasCachedPrices) {
    if (spotEl) spotEl.textContent = "Loading...";
    if (mintEl) mintEl.textContent = "Loading...";
    if (ethValueEl) ethValueEl.textContent = "Loading...";
  } else {
    spotPriceAud = cached.spotAud;
    mintPriceAud = cached.mintAud;
    if (Number.isFinite(cached.audRate)) {
      audRate = cached.audRate;
      spotPriceUsd = spotPriceAud / audRate;
      mintPriceUsd = mintPriceAud / audRate;
    }
    updateFiatDisplays();
    recalcFromInput();
  }
  try {
    const fxPromise = fetchFxRates().catch((fxErr) => {
      console.warn("FX feed unavailable, USD display will be disabled", fxErr.message);
      return null;
    });

    const abcSpotAud = await fetchAbcSpotPriceAud();
    const spotAud = abcSpotAud * (1 + DISPLAY_SPOT_PERCENT_PREMIUM) + DISPLAY_SPOT_FIXED_AUD;
    spotPriceAud = Number(spotAud.toFixed(4));
    const mintAudRaw = spotPriceAud * (1 + mintPercentPremium) + mintFixedAud;
    mintPriceAud = Number(mintAudRaw.toFixed(4)); // keep precision for FX conversion

    audRate = await fxPromise;
    if (audRate) {
      spotPriceUsd = spotPriceAud / audRate;
      mintPriceUsd = mintPriceAud / audRate;
    } else {
      spotPriceUsd = null;
      mintPriceUsd = null;
    }
    persistPrices(spotPriceAud, mintPriceAud, audRate);

    try {
      const { usd, aud } = await fetchEthPrice();
      ethPriceUsd = usd;
      ethPriceAud = aud;
    } catch (ethErr) {
      ethPriceUsd = null;
      ethPriceAud = null;
      console.warn("ETH feed unavailable", ethErr.message);
    }

    updateFiatDisplays();
    if (ethPriceUsd) updateEthDisplay();
    recalcFromInput();
    fetchSerialSummary();
  } catch (err) {
    console.error(err);
    if (spotEl) spotEl.textContent = "Feed unavailable";
    if (mintEl) mintEl.textContent = "--";
    if (usdValueEl) usdValueEl.textContent = "--";
    if (ethValueEl) ethValueEl.textContent = "--";
  }
}

async function fetchEthPrice() {
  let lastError;
  for (const url of ETH_PRICE_ENDPOINTS) {
    try {
      const res = await withTimeout(
        (signal) => fetch(url, { cache: "no-store", signal }),
        8000,
        "ETH price"
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      let priceUsd = null;
      let priceAud = null;
      if (data?.ethereum) {
        priceUsd = Number(data.ethereum.usd);
        priceAud = Number(data.ethereum.aud);
      } else {
        priceUsd = Number(data?.USD);
        priceAud = Number(data?.AUD);
      }
      if (!Number.isFinite(priceUsd)) throw new Error("ETH price invalid");
      return { usd: priceUsd, aud: Number.isFinite(priceAud) ? priceAud : null };
    } catch (err) {
      lastError = err;
      console.warn(`ETH price endpoint failed (${url})`, err.message);
    }
  }
  throw lastError || new Error("ETH price unavailable");
}

async function fetchFxRates() {
  const res = await withTimeout(
    (signal) => fetch(FX_ENDPOINT, { cache: "no-store", signal }),
    8000,
    "FX rate"
  );
  if (!res.ok) throw new Error("FX rate feed failed");
  const data = await res.json();
  const rate = Number(data?.rates?.AUD);
  if (!Number.isFinite(rate)) throw new Error("AUD rate invalid");
  return rate;
}

function getFiatMultiplier(currency = currentCurrency) {
  if (currency === "AUD") return audRate || null;
  return 1;
}

function recalcFromInput() {
  if (!slvrInput) return;
  const slvr = Number(slvrInput.value) || 0;
  const coins = slvr / TPC_PER_COIN;
  if (mintAmountEl) {
    const label = coins === 1 ? "Coin" : "Coins";
    mintAmountEl.textContent = coins ? `${coins.toFixed(2)} ${label}` : `-- ${label}`;
  }

  const usdMintPrice = mintPriceUsd;
  const fx = getFiatMultiplier();
  const effectiveMintPrice =
    currentCurrency === "AUD"
      ? mintPriceAud ?? (fx && usdMintPrice ? usdMintPrice * fx : null)
      : usdMintPrice ?? (audRate && mintPriceAud ? mintPriceAud / audRate : null);

  if (effectiveMintPrice && usdValueEl) {
    const usdValueBase = coins * effectiveMintPrice;
    usdValueEl.textContent = coins ? formatFiat(usdValueBase, currentCurrency) : formatFiat(0, currentCurrency);
  } else if (usdValueEl) {
    usdValueEl.textContent = "--";
  }

  updateEthDisplay(slvr);
  updateMintTotals();
}

async function connectWallet() {
  if (!window.ethereum) {
    alert("Metamask not detected. Please install Metamask to continue.");
    return;
  }
  try {
    await loadEthers();
    web3Provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    connectBtn.disabled = false;
    let accounts = [];
    try {
      accounts = await web3Provider.send("eth_requestAccounts", []);
    } catch (primaryError) {
      // Fallback for some wallet providers
      accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    }
    const account = accounts?.[0];
    if (!account) throw new Error("No account returned");
    signerAddress = account;
    await updateWalletBalance();
    await loadMintHistoryForAddress(account);
    updateWalletUI();
    attachWalletListeners();
    return web3Provider.getSigner();
  } catch (err) {
    console.error("Wallet connection cancelled", err);
    alert("Wallet connection failed or was dismissed. Please try again in Metamask.");
    walletEl.textContent = "Not connected";
    connectBtn.disabled = false;
    connectBtn.textContent = "Connect Wallet";
    setWelcomeText(null);
    return null;
  }
}

let ethersReadyPromise = null;
function loadEthers() {
  if (window.ethers) return Promise.resolve(window.ethers);
  if (ethersReadyPromise) return ethersReadyPromise;
  ethersReadyPromise = new Promise((resolve, reject) => {
    let idx = 0;
    const tryNext = () => {
      if (window.ethers) return resolve(window.ethers);
      if (idx >= ETHERS_CDNS.length) return reject(new Error("Unable to load ethers library."));
      const script = document.createElement("script");
      script.src = ETHERS_CDNS[idx++];
      script.async = true;
      script.onload = () => (window.ethers ? resolve(window.ethers) : tryNext());
      script.onerror = tryNext;
      document.head.appendChild(script);
    };
    tryNext();
  });
  return ethersReadyPromise;
}

function attachWalletListeners() {
  if (!window.ethereum || window.ethereum._slvrBound) return;
  window.ethereum.on("accountsChanged", (accounts) => {
    const account = accounts?.[0];
    signerAddress = account || null;
    setWalletBalanceText(null);
    updateWalletBalance();
    loadMintHistoryForAddress(account);
    updateWalletUI();
  });
  window.ethereum.on("disconnect", () => {
    signerAddress = null;
    setWalletBalanceText(null);
    mintedItems = [];
    updateWalletUI();
    renderMintFeed();
  });
  window.ethereum._slvrBound = true;
}

function updateWalletUI() {
  if (signerAddress) {
    if (walletEl) walletEl.textContent = shortenAddress(signerAddress);
    if (connectBtn) {
      connectBtn.textContent = shortenAddress(signerAddress);
      connectBtn.disabled = true;
    }
    updateWalletBalance();
    setWelcomeText(signerAddress);
  } else {
    if (walletEl) walletEl.textContent = "Not connected";
    if (connectBtn) {
      connectBtn.textContent = "Connect Wallet";
      connectBtn.disabled = false;
    }
    setWalletBalanceText(null);
    setWelcomeText(null);
  }
}

function shortenAddress(addr) {
  if (!addr) return "";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

async function handleMint() {
  if (!signerAddress) {
    await connectWallet();
    if (!signerAddress) return;
  }

  const slvr = Number(slvrInput.value) || 0;
  if (slvr <= 0) {
    alert("Enter a TPC amount greater than 0.");
    return;
  }

  const ounces = slvr / TPC_PER_COIN;
  const fx = audRate || null;
  const pricePerOz =
    currentCurrency === "AUD"
      ? mintPriceAud ?? (fx && mintPriceUsd ? mintPriceUsd * fx : null)
      : mintPriceUsd ?? (fx && mintPriceAud ? mintPriceAud / fx : null);
  const activeEthPrice =
    currentCurrency === "AUD"
      ? ethPriceAud ?? (fx && ethPriceUsd ? ethPriceUsd * fx : null)
      : ethPriceUsd ?? (fx && ethPriceAud ? ethPriceAud / fx : null);

  if (!pricePerOz) {
    alert("Mint price unavailable. Please refresh price and try again.");
    return;
  }
  if (!activeEthPrice) {
    alert("ETH price unavailable. Please refresh price and try again.");
    return;
  }
  const fiatValue = ounces * pricePerOz;
  const ethNeeded = fiatValue / activeEthPrice;
  const usdUnitPrice = mintPriceUsd ?? (fx && mintPriceAud ? mintPriceAud / fx : null);
  const usdValue =
    usdUnitPrice ? ounces * usdUnitPrice : currentCurrency === "USD" ? fiatValue : fx ? fiatValue / fx : null;

  await loadEthers();
  web3Provider = new ethers.providers.Web3Provider(window.ethereum, "any");
  const signer = web3Provider.getSigner();

  const ethToSend = ethers.utils.parseEther((ethNeeded || 0).toFixed(6));

  try {
    const tx = await signer.sendTransaction({
      to: TREASURY_ADDRESS,
      value: ethToSend,
    });
    console.log("Tx submitted", tx.hash);
  } catch (err) {
    console.error("Transaction rejected or failed", err);
    const reason = String(err?.message || "").toLowerCase();
    if (reason.includes("insufficient funds")) {
      alert("Insufficient ETH (including gas) in wallet. Please top up and try again.");
    } else {
      alert("Transaction was cancelled or failed. Please try again.");
    }
    return;
  }

  // Demo-only mint record
  const payload = {
    ounces: ounces.toFixed(2),
    slvr: slvr.toFixed(0),
    usd: formatFiat(fiatValue, currentCurrency),
    usdRaw: Number.isFinite(usdValue) ? usdValue : null,
    ethRaw: ethNeeded,
    ts: new Date(),
  };
  try {
    const saved = await saveMintItemToApi(signerAddress, payload);
    if (!saved?.serial) throw new Error("No serial returned by server");
    mintedItems.unshift(normalizeMintItem(saved));
  } catch (err) {
    console.error("Failed to persist mint to server", err);
    alert("Mint completed but failed to allocate/save serial. Please contact admin.");
    return;
  }
  await persistMintHistory();
  fetchSerialSummary();
  renderMintFeed();
}

function bindEvents() {
  if (slvrInput) slvrInput.addEventListener("input", recalcFromInput);
  if (connectBtn) connectBtn.addEventListener("click", connectWallet);
  if (mintBtn) mintBtn.addEventListener("click", handleMint);
  if (refreshBtn) refreshBtn.addEventListener("click", () => hydratePrices(true));
  if (refreshBtnMobile) refreshBtnMobile.addEventListener("click", () => { hydratePrices(true); closeMenu(); });
  currencyButtons.forEach((btn) =>
    btn.addEventListener("click", () => {
      setCurrency(btn.dataset.currency);
    })
  );
  if (menuToggle) menuToggle.addEventListener("click", toggleMenu);
  if (closeMenuBtn) closeMenuBtn.addEventListener("click", closeMenu);
  if (mobileMenu) {
    mobileMenu.addEventListener("click", (e) => {
      if (e.target === mobileMenu) closeMenu();
    });
  }
}

(function init() {
  bindEvents();
  if (hasPricingUI || hasMintForm) {
    hydratePrices(true);
    recalcFromInput();
    setMintBalanceText();
    setInterval(hydratePrices, 60 * 60 * 1000);
  }
  attachWalletListeners();
  attemptSilentWalletRestore();
  updateWalletUI();
  renderMintFeed();
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();

function renderMintFeed() {
  const container = document.getElementById("mintFeed");
  if (!container) return;
  if (!mintedItems.length) {
    container.innerHTML = `<div class="feed-item empty">No mints yet. Complete a mint to see a serial.</div>`;
    updateMintTotals();
    return;
  }
  container.innerHTML = mintedItems
    .map(
      (item) => `
      <div class="feed-item">
        <div class="serial">${item.serial}</div>
        <div>${item.ounces} oz</div>
        <div>${item.slvr} TPC</div>
        <div>${item.usd}</div>
      </div>
    `
    )
    .join("");
  updateMintTotals();
}

function normalizeMintItem(item = {}) {
  const normalized = { ...item };
  const oz = Number(normalized.ounces);
  const slvr = Number(normalized.slvr);
  // Backfill ounces if missing
  if (!Number.isFinite(oz) && Number.isFinite(slvr)) {
    normalized.ounces = (slvr / TPC_PER_COIN).toFixed(2);
  }
  // Backfill usdRaw from formatted string if missing
  if (!Number.isFinite(Number(normalized.usdRaw)) && typeof normalized.usd === "string") {
    const parsedUsd = parseFloat(normalized.usd.replace(/[^0-9.]+/g, ""));
    if (Number.isFinite(parsedUsd)) normalized.usdRaw = parsedUsd;
  }
  // Backfill ethRaw from USD value only against ETH/USD.
  if (!Number.isFinite(Number(normalized.ethRaw)) && Number.isFinite(Number(normalized.usdRaw)) && Number.isFinite(ethPriceUsd)) {
    normalized.ethRaw = Number(normalized.usdRaw) / ethPriceUsd;
  }
  return normalized;
}

function setWelcomeText(addr) {
  if (!welcomeEl) return;
  if (addr) {
    welcomeEl.textContent = `Welcome, ${shortenAddress(addr)}`;
  } else {
    welcomeEl.textContent = "Welcome, connect your wallet";
  }
}

function updateEthDisplay(slvrInputValue) {
  if (!ethValueEl) return;
  if (!slvrInput && slvrInputValue === undefined) return;
  const slvr = slvrInputValue !== undefined ? Number(slvrInputValue) || 0 : Number(slvrInput.value) || 0;
  const ounces = slvr / TPC_PER_COIN;
  const fx = audRate || null;
  const pricePerOz =
    currentCurrency === "AUD"
      ? mintPriceAud ?? (fx && mintPriceUsd ? mintPriceUsd * fx : null)
      : fx ? mintPriceAud / fx : null;
  const fiatValue = pricePerOz ? ounces * pricePerOz : null;
  const ethPx = currentCurrency === "AUD" ? ethPriceAud || ethPriceUsd : ethPriceUsd;
  if (!ethPx || !fiatValue) {
    ethValueEl.textContent = "-- ETH";
    return;
  }
  const ethNeeded = fiatValue / ethPx;
  ethValueEl.textContent = `${ethNeeded.toFixed(ETH_DISPLAY_DECIMALS)} ETH`;
  if (ethValueLabelEl) ethValueLabelEl.textContent = `Live ETH/${currentCurrency}`;
}

function setMintBalanceText() {
  if (!mintBalanceTopEl) return;
  if (!Number.isFinite(availableSerials)) {
    mintBalanceTopEl.textContent = "-- Coins";
    return;
  }
  const suffix = availableSerials === 1 ? "Coin" : "Coins";
  mintBalanceTopEl.textContent = `${availableSerials.toLocaleString("en-US")} ${suffix}`;
}

function formatFiat(value, currency = currentCurrency) {
  const symbol = currency === "AUD" ? "A$" : "$";
  const number = Number(value || 0).toLocaleString(currency === "AUD" ? "en-AU" : "en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${symbol}${number}`;
}

function updateFiatDisplays() {
  if (fiatValueLabel) fiatValueLabel.textContent = `${currentCurrency} value`;
  if (!spotEl || !mintEl) return;

  const fx = audRate || null;

  let spot = null;
  let mint = null;
  if (currentCurrency === "AUD") {
    spot = spotPriceAud ?? (fx && spotPriceUsd ? spotPriceUsd * fx : null);
    mint = mintPriceAud ?? (fx && mintPriceUsd ? mintPriceUsd * fx : null);
  } else {
    spot = fx ? spotPriceAud / fx : null;
    mint = fx ? mintPriceAud / fx : null;
  }

  if (Number.isFinite(spot) && Number.isFinite(mint)) {
    spotEl.textContent = formatFiat(spot);
    mintEl.textContent = formatFiat(mint);
    if (spotFiatSubEl) spotFiatSubEl.textContent = `Live per oz (${currentCurrency})`;
  } else {
    spotEl.textContent = "--";
    mintEl.textContent = "--";
    if (spotFiatSubEl) spotFiatSubEl.textContent = "";
  }
}

function updateMintTotals() {
  if (!totalMintedAmountEl && !totalMintedValueFiatEl && !totalMintedValueEthEl) return;
  let totalOz = 0;
  let totalUsd = 0;
  let totalEth = 0;
  mintedItems.forEach((rawItem) => {
    const item = normalizeMintItem(rawItem);
    const oz = Number(item.ounces) || (Number(item.slvr) || 0) / TPC_PER_COIN || 0;
    const usdRaw = Number(item.usdRaw);
    const ethRaw = Number(item.ethRaw);
    totalOz += oz;
    if (Number.isFinite(usdRaw)) totalUsd += usdRaw;
    if (Number.isFinite(ethRaw)) totalEth += ethRaw;
  });
  const coinsText = `${totalOz.toFixed(2)} Coins`;
  if (totalMintedAmountEl) totalMintedAmountEl.textContent = totalOz > 0 ? coinsText : "0.00 Coins";
  const fx = getFiatMultiplier();
  const effectiveFx = currentCurrency === "AUD" ? fx : 1;
  const fiatText =
    currentCurrency === "AUD" && !effectiveFx
      ? "--"
      : formatFiat((totalUsd || 0) * (effectiveFx || 1), currentCurrency);
  if (totalMintedValueFiatEl) totalMintedValueFiatEl.textContent = fiatText;
  const ethText = totalEth ? `${totalEth.toFixed(ETH_DISPLAY_DECIMALS)} ETH` : "0.000000 ETH";
  if (totalMintedValueEthEl) totalMintedValueEthEl.textContent = ethText;
}

function setCurrency(currency) {
  if (currency === currentCurrency) return;
  currentCurrency = currency;
  currencyButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.currency === currency));
  updateFiatDisplays();
  recalcFromInput();
  updateMintTotals();
  hydratePrices(true); // force fresh fetch on currency switch to ensure USD/AUD reflect latest ABC quote
}

function toggleMenu() {
  const isOpen = mobileMenu?.classList.contains("open");
  if (isOpen) {
    closeMenu();
  } else {
    openMenu();
  }
}

function openMenu() {
  if (!mobileMenu || !menuToggle) return;
  mobileMenu.classList.add("open");
  menuToggle.setAttribute("aria-expanded", "true");
}

function closeMenu() {
  if (!mobileMenu || !menuToggle) return;
  mobileMenu.classList.remove("open");
  menuToggle.setAttribute("aria-expanded", "false");
}

function storageKeyForAddress(addr) {
  if (!addr) return null;
  return `slvr_mints_${addr.toLowerCase()}`;
}

function isValidSerial(serial) {
  const text = String(serial || "").trim();
  return /^\d{11}$/.test(text);
}

async function loadMintHistoryForAddress(addr) {
  const key = storageKeyForAddress(addr);
  mintedItems = [];
  if (!key) {
    renderMintFeed();
    return;
  }
  try {
    const apiItems = await fetchMintHistoryFromApi(addr);
    if (Array.isArray(apiItems)) {
      mintedItems = apiItems.map(normalizeMintItem).filter((item) => isValidSerial(item.serial)).slice(0, MINT_HISTORY_LIMIT);
      try {
        localStorage.setItem(key, JSON.stringify(mintedItems));
      } catch (storageErr) {
        console.warn("Failed to update local mint cache", storageErr);
      }
      renderMintFeed();
      updateMintTotals();
      return;
    }
  } catch (apiErr) {
    console.warn("Mint history API unavailable, using local cache", apiErr.message);
  }
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        mintedItems = parsed.map(normalizeMintItem).filter((item) => isValidSerial(item.serial)).slice(0, MINT_HISTORY_LIMIT);
      }
    }
  } catch (err) {
    console.warn("Failed to load mint history", err);
  }
  renderMintFeed();
  updateMintTotals();
}

async function persistMintHistory() {
  const key = storageKeyForAddress(signerAddress);
  if (!key) return;
  try {
    const normalized = mintedItems.map(normalizeMintItem).slice(0, MINT_HISTORY_LIMIT);
    localStorage.setItem(key, JSON.stringify(normalized));
  } catch (err) {
    console.warn("Failed to persist mint history", err);
  }
}

async function attemptSilentWalletRestore() {
  if (!window.ethereum) return;
  try {
    await loadEthers();
    web3Provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    const accounts = await web3Provider.send("eth_accounts", []);
    const account = accounts?.[0];
    if (account) {
      signerAddress = account;
      await updateWalletBalance();
      await loadMintHistoryForAddress(account);
      updateWalletUI();
    }
  } catch (err) {
    console.warn("Silent wallet restore skipped", err.message);
  }
}

async function updateWalletBalance() {
  if (!walletEthBalanceEl) return;
  if (!signerAddress || !web3Provider) {
    setWalletBalanceText(null);
    setWalletTpcBalanceText(null);
    return;
  }
  try {
    const balance = await web3Provider.getBalance(signerAddress);
    const formatted = Number(ethers.utils.formatEther(balance)).toFixed(ETH_DISPLAY_DECIMALS);
    setWalletBalanceText(formatted);
    setWalletTpcBalanceText(null); // Placeholder until token is live
  } catch (err) {
    console.warn("Unable to fetch wallet balance", err.message);
    setWalletBalanceText(null);
    setWalletTpcBalanceText(null);
  }
}

function setWalletBalanceText(value) {
  if (!walletEthBalanceEl) return;
  walletEthBalanceEl.textContent = value ? `${Number(value).toFixed(ETH_DISPLAY_DECIMALS)} ETH` : "--";
}

function setWalletTpcBalanceText(value) {
  if (!walletTpcBalanceEl) return;
  walletTpcBalanceEl.textContent = value ?? "--";
}
