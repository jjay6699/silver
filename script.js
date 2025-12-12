const SPOT_ENDPOINT_PRIMARY = "https://data-asg.goldprice.org/dbXRates/USD";
const SPOT_ENDPOINT_FALLBACK = "https://api.metals.live/v1/spot/silver";
const ETH_PRICE_ENDPOINTS = [
  "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd,aud",
  "https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD,AUD",
];
const FX_ENDPOINT = "https://open.er-api.com/v6/latest/USD";
const ETHERS_CDNS = [
  "https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js",
  "https://cdn.jsdelivr.net/npm/ethers@5.7.2/dist/ethers.umd.min.js",
  "https://unpkg.com/ethers@5.7.2/dist/ethers.umd.min.js",
];
const TREASURY_ADDRESS = "0xd85ca20db6e444e3b4c4b3c18a36fc45f7a66991";

let spotPriceUsd = null;
let mintPriceUsd = null;
let signerAddress = null;
let mintedItems = [];
let ethPriceUsd = null;
let ethPriceAud = null;
let audRate = null; // AUD per 1 USD
let currentCurrency = "USD";
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
const MINT_BALANCE_OZ = 300;
const ETH_DISPLAY_DECIMALS = 6;

async function fetchSpotPrice() {
  try {
    const primary = await fetch(SPOT_ENDPOINT_PRIMARY, { cache: "no-cache" });
    if (!primary.ok) throw new Error("Primary source failed");
    const data = await primary.json();
    const price = Number(data?.items?.[0]?.xagPrice);
    if (!Number.isFinite(price)) throw new Error("Primary payload invalid");
    return price;
  } catch (err) {
    console.warn("Primary price feed failed, using fallback:", err.message);
    const fallback = await fetch(SPOT_ENDPOINT_FALLBACK, { cache: "no-cache" });
    if (!fallback.ok) throw new Error("Fallback source failed");
    const data = await fallback.json();
    const price = Number(data?.[0]?.price ?? data?.[1]?.silver ?? data?.[1]);
    if (!Number.isFinite(price)) throw new Error("Fallback payload invalid");
    return price;
  }
}

async function hydratePrices() {
  if (spotEl) spotEl.textContent = "Loading...";
  if (mintEl) mintEl.textContent = "Loading...";
  if (ethValueEl) ethValueEl.textContent = "Loading...";
  try {
    const spot = await fetchSpotPrice();
    spotPriceUsd = spot;
    mintPriceUsd = spotPriceUsd * 1.04;

    try {
      audRate = await fetchFxRates();
    } catch (fxErr) {
      audRate = 1;
      console.warn("FX feed unavailable, defaulting to USD rates only", fxErr.message);
    }

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
      const res = await fetch(url, { cache: "no-cache" });
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
  const res = await fetch(FX_ENDPOINT, { cache: "no-cache" });
  if (!res.ok) throw new Error("FX rate feed failed");
  const data = await res.json();
  const rate = Number(data?.rates?.AUD);
  if (!Number.isFinite(rate)) throw new Error("AUD rate invalid");
  return rate;
}

function getFiatMultiplier(currency = currentCurrency) {
  if (currency === "AUD") return audRate || 1;
  return 1;
}

function recalcFromInput() {
  if (!slvrInput) return;
  const slvr = Number(slvrInput.value) || 0;
  const ounces = slvr / 100;
  if (mintAmountEl) mintAmountEl.textContent = ounces ? `${ounces.toFixed(2)} oz` : "-- oz";

  const usdMintPrice = mintPriceUsd;
  const fx = getFiatMultiplier();
  if (usdMintPrice && fx && usdValueEl) {
    const usdValueBase = ounces * usdMintPrice;
    const fiatValue = usdValueBase * fx;
    usdValueEl.textContent = ounces ? formatFiat(fiatValue, currentCurrency) : formatFiat(0, currentCurrency);
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
    loadMintHistoryForAddress(account);
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

  const ounces = slvr / 100;
  if (!mintPriceUsd) {
    alert("Mint price unavailable. Please refresh price and try again.");
    return;
  }

  const usdValue = ounces * mintPriceUsd;
  const ethNeeded = ethPrice ? usdValue / ethPrice : null;

  if (!ethPrice) {
    alert("ETH price unavailable. Please refresh price and try again.");
    return;
  }

  await loadEthers();
  web3Provider = new ethers.providers.Web3Provider(window.ethereum, "any");
  const signer = web3Provider.getSigner();

  const ethToSend = ethers.utils.parseEther((ethNeeded || 0).toFixed(6));
  const balance = await signer.getBalance();
  if (balance.lt(ethToSend)) {
    const needed = ethers.utils.formatEther(ethToSend);
    const available = ethers.utils.formatEther(balance);
    alert(`Insufficient ETH balance.\nNeeded: ${needed} ETH\nAvailable: ${Number(available).toFixed(6)} ETH`);
    return;
  }

  try {
    const tx = await signer.sendTransaction({
      to: TREASURY_ADDRESS,
      value: ethToSend,
    });
    console.log("Tx submitted", tx.hash);
  } catch (err) {
    console.error("Transaction rejected or failed", err);
    alert("Transaction was cancelled or failed. Please try again.");
    return;
  }

  // Demo-only mint record
  const serial = buildSerial();
  const fx = getFiatMultiplier() || 1;
  mintedItems.unshift({
    serial,
    ounces: ounces.toFixed(2),
    slvr: slvr.toFixed(0),
    usd: formatFiat(usdValue * fx, currentCurrency),
    usdRaw: usdValue,
    ethRaw: ethNeeded,
    ts: new Date(),
  });
  persistMintHistory();
  renderMintFeed();
}

function bindEvents() {
  if (slvrInput) slvrInput.addEventListener("input", recalcFromInput);
  if (connectBtn) connectBtn.addEventListener("click", connectWallet);
  if (mintBtn) mintBtn.addEventListener("click", handleMint);
  if (refreshBtn) refreshBtn.addEventListener("click", hydratePrices);
  if (refreshBtnMobile) refreshBtnMobile.addEventListener("click", () => { hydratePrices(); closeMenu(); });
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
    hydratePrices();
    recalcFromInput();
    setMintBalanceText();
    setInterval(hydratePrices, 120 * 1000);
  }
  attachWalletListeners();
  attemptSilentWalletRestore();
  updateWalletUI();
  renderMintFeed();
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
})();

function buildSerial() {
  const now = Date.now();
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, "0");
  return `TPC-${now.toString(36).toUpperCase()}-${rand}`;
}

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
    normalized.ounces = (slvr / 100).toFixed(2);
  }
  // Backfill usdRaw from formatted string if missing
  if (!Number.isFinite(Number(normalized.usdRaw)) && typeof normalized.usd === "string") {
    const parsedUsd = parseFloat(normalized.usd.replace(/[^0-9.]+/g, ""));
    if (Number.isFinite(parsedUsd)) normalized.usdRaw = parsedUsd;
  }
  // Backfill ethRaw if missing and we have usdRaw + ethPrice
  if (!Number.isFinite(Number(normalized.ethRaw)) && Number.isFinite(Number(normalized.usdRaw)) && Number.isFinite(ethPrice)) {
    normalized.ethRaw = Number(normalized.usdRaw) / ethPrice;
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
  const ounces = slvr / 100;
  const usdValue = mintPriceUsd ? ounces * mintPriceUsd : null;
  const fx = getFiatMultiplier();
  const fiatValue = usdValue && fx ? usdValue * fx : null;
  const ethPx = currentCurrency === "AUD" ? ethPriceAud || ethPriceUsd : ethPriceUsd;
  if (!ethPx || !usdValue) {
    ethValueEl.textContent = "-- ETH";
    return;
  }
  const ethNeeded =
    currentCurrency === "AUD"
      ? fiatValue && ethPx ? fiatValue / ethPx : usdValue / ethPx
      : usdValue / ethPx;
  ethValueEl.textContent = `${ethNeeded.toFixed(ETH_DISPLAY_DECIMALS)} ETH`;
  if (ethValueLabelEl) ethValueLabelEl.textContent = `Live ETH/${currentCurrency}`;
}

function setMintBalanceText() {
  const text = `${MINT_BALANCE_OZ} oz`;
  if (mintBalanceTopEl) mintBalanceTopEl.textContent = text;
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
  const fx = getFiatMultiplier();
  if (!spotPriceUsd || !mintPriceUsd || !fx || !spotEl || !mintEl) return;
  const spot = spotPriceUsd * fx;
  const mint = mintPriceUsd * fx;
  spotEl.textContent = formatFiat(spot);
  mintEl.textContent = formatFiat(mint);
  if (spotFiatSubEl) spotFiatSubEl.textContent = `Live per oz (${currentCurrency})`;
}

function updateMintTotals() {
  if (!totalMintedAmountEl && !totalMintedValueFiatEl && !totalMintedValueEthEl) return;
  let totalOz = 0;
  let totalUsd = 0;
  let totalEth = 0;
  mintedItems.forEach((rawItem) => {
    const item = normalizeMintItem(rawItem);
    const oz = Number(item.ounces) || (Number(item.slvr) || 0) / 100 || 0;
    const usdRaw = Number(item.usdRaw);
    const ethRaw = Number(item.ethRaw);
    totalOz += oz;
    if (Number.isFinite(usdRaw)) totalUsd += usdRaw;
    if (Number.isFinite(ethRaw)) totalEth += ethRaw;
  });
  const ozText = `${totalOz.toFixed(2)} oz`;
  if (totalMintedAmountEl) totalMintedAmountEl.textContent = totalOz > 0 ? ozText : "0.00 oz";
  const fx = getFiatMultiplier();
  const fiatText = formatFiat((totalUsd || 0) * fx, currentCurrency);
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

function loadMintHistoryForAddress(addr) {
  const key = storageKeyForAddress(addr);
  mintedItems = [];
  if (!key) {
    renderMintFeed();
    return;
  }
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        mintedItems = parsed.map(normalizeMintItem);
      }
    }
  } catch (err) {
    console.warn("Failed to load mint history", err);
  }
  renderMintFeed();
  updateMintTotals();
}

function persistMintHistory() {
  const key = storageKeyForAddress(signerAddress);
  if (!key) return;
  try {
    const normalized = mintedItems.map(normalizeMintItem);
    localStorage.setItem(key, JSON.stringify(normalized.slice(0, 50)));
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
      loadMintHistoryForAddress(account);
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
