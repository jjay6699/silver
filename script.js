const SPOT_ENDPOINT_PRIMARY = "https://data-asg.goldprice.org/dbXRates/USD";
const SPOT_ENDPOINT_FALLBACK = "https://api.metals.live/v1/spot/silver";
const ETH_PRICE_ENDPOINT = "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd";
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
let ethPrice = null;
let audRate = null; // AUD per 1 USD
let currentCurrency = "USD";

const spotEl = document.getElementById("spotPrice");
const mintEl = document.getElementById("mintPrice");
const walletEl = document.getElementById("walletStatus");
const welcomeEl = document.getElementById("welcomeMessage");
const mintAmountEl = document.getElementById("mintAmount");
const usdValueEl = document.getElementById("usdValue");
const ethValueEl = document.getElementById("ethValue");
const slvrInput = document.getElementById("slvrInput");
const connectBtn = document.getElementById("connectWallet");
const mintBtn = document.getElementById("mintButton");
const refreshBtn = document.getElementById("refreshPrice");
const mintBalanceTopEl = document.getElementById("mintBalanceTop");
const refreshBtnMobile = document.getElementById("refreshPriceMobile");
const menuToggle = document.getElementById("menuToggle");
const mobileMenu = document.getElementById("mobileMenu");
const closeMenuBtn = document.getElementById("closeMenu");
const currencyButtons = document.querySelectorAll(".currency-btn");
const fiatValueLabel = document.getElementById("fiatValueLabel");
const MINT_BALANCE_OZ = 300;

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
  spotEl.textContent = "Loading...";
  mintEl.textContent = "Loading...";
  ethValueEl.textContent = "Loading...";
  try {
    const [spot, fx] = await Promise.all([fetchSpotPrice(), fetchFxRates()]);
    spotPriceUsd = spot;
    mintPriceUsd = spotPriceUsd * 1.04;
    audRate = fx;
    ethPrice = await fetchEthPrice();
    updateFiatDisplays();
    updateEthDisplay();
    recalcFromInput();
  } catch (err) {
    console.error(err);
    spotEl.textContent = "Feed unavailable";
    mintEl.textContent = "--";
    usdValueEl.textContent = "--";
    ethValueEl.textContent = "--";
  }
}

async function fetchEthPrice() {
  const res = await fetch(ETH_PRICE_ENDPOINT, { cache: "no-cache" });
  if (!res.ok) throw new Error("ETH price feed failed");
  const data = await res.json();
  const price = Number(data?.ethereum?.usd);
  if (!Number.isFinite(price)) throw new Error("ETH price invalid");
  return price;
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
  if (currency === "AUD") return audRate || null;
  return 1;
}

function recalcFromInput() {
  const slvr = Number(slvrInput.value) || 0;
  const ounces = slvr / 100;
  mintAmountEl.textContent = ounces ? `${ounces.toFixed(2)} oz` : "-- oz";

  const usdMintPrice = mintPriceUsd;
  const fx = getFiatMultiplier();
  if (usdMintPrice && fx) {
    const usdValueBase = ounces * usdMintPrice;
    const fiatValue = usdValueBase * fx;
    usdValueEl.textContent = ounces ? formatFiat(fiatValue, currentCurrency) : formatFiat(0, currentCurrency);
  } else {
    usdValueEl.textContent = "--";
  }

  updateEthDisplay(slvr);
}

async function connectWallet() {
  if (!window.ethereum) {
    alert("Metamask not detected. Please install Metamask to continue.");
    return;
  }
  try {
    await loadEthers();
    const provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    connectBtn.disabled = false;
    let accounts = [];
    try {
      accounts = await provider.send("eth_requestAccounts", []);
    } catch (primaryError) {
      // Fallback for some wallet providers
      accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    }
    const account = accounts?.[0];
    if (!account) throw new Error("No account returned");
    signerAddress = account;
    loadMintHistoryForAddress(account);
    updateWalletUI();
    attachWalletListeners();
    return provider.getSigner();
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
    loadMintHistoryForAddress(account);
    updateWalletUI();
  });
  window.ethereum.on("disconnect", () => {
    signerAddress = null;
    mintedItems = [];
    updateWalletUI();
    renderMintFeed();
  });
  window.ethereum._slvrBound = true;
}

function updateWalletUI() {
  if (signerAddress) {
    walletEl.textContent = shortenAddress(signerAddress);
    connectBtn.textContent = shortenAddress(signerAddress);
    connectBtn.disabled = true;
    setWelcomeText(signerAddress);
  } else {
    walletEl.textContent = "Not connected";
    connectBtn.textContent = "Connect Wallet";
    connectBtn.disabled = false;
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
  const provider = new ethers.providers.Web3Provider(window.ethereum, "any");
  const signer = provider.getSigner();

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
    ts: new Date(),
  });
  persistMintHistory();
  renderMintFeed();
}

function bindEvents() {
  slvrInput.addEventListener("input", recalcFromInput);
  connectBtn.addEventListener("click", connectWallet);
  mintBtn.addEventListener("click", handleMint);
  refreshBtn.addEventListener("click", hydratePrices);
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
  hydratePrices();
  recalcFromInput();
  attachWalletListeners();
  attemptSilentWalletRestore();
  updateWalletUI();
  renderMintFeed();
  setMintBalanceText();
  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  // Auto-refresh pricing every 60 seconds
  setInterval(hydratePrices, 60 * 1000);
})();

function buildSerial() {
  const now = Date.now();
  const rand = Math.floor(Math.random() * 1e6).toString().padStart(6, "0");
  return `TPC-${now.toString(36).toUpperCase()}-${rand}`;
}

function renderMintFeed() {
  const container = document.getElementById("mintFeed");
  if (!mintedItems.length) {
    container.innerHTML = `<div class="feed-item empty">No mints yet. Complete a mint to see a serial.</div>`;
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
  const slvr = slvrInputValue !== undefined ? Number(slvrInputValue) || 0 : Number(slvrInput.value) || 0;
  const ounces = slvr / 100;
  const usdValue = mintPriceUsd ? ounces * mintPriceUsd : null;
  if (!ethPrice || !usdValue) {
    ethValueEl.textContent = "-- ETH";
    return;
  }
  const ethNeeded = usdValue / ethPrice;
  ethValueEl.textContent = `${ethNeeded.toFixed(5)} ETH`;
}

function setMintBalanceText() {
  const text = `${MINT_BALANCE_OZ} oz`;
  if (mintBalanceTopEl) mintBalanceTopEl.textContent = text;
}

function formatFiat(value, currency = currentCurrency) {
  return new Intl.NumberFormat(currency === "AUD" ? "en-AU" : "en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function updateFiatDisplays() {
  if (fiatValueLabel) fiatValueLabel.textContent = `${currentCurrency} value`;
  const fx = getFiatMultiplier();
  if (!spotPriceUsd || !mintPriceUsd || !fx) return;
  const spot = spotPriceUsd * fx;
  const mint = mintPriceUsd * fx;
  spotEl.textContent = formatFiat(spot);
  mintEl.textContent = formatFiat(mint);
}

function setCurrency(currency) {
  if (currency === currentCurrency) return;
  currentCurrency = currency;
  currencyButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.currency === currency));
  updateFiatDisplays();
  recalcFromInput();
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
        mintedItems = parsed;
      }
    }
  } catch (err) {
    console.warn("Failed to load mint history", err);
  }
  renderMintFeed();
}

function persistMintHistory() {
  const key = storageKeyForAddress(signerAddress);
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(mintedItems.slice(0, 50)));
  } catch (err) {
    console.warn("Failed to persist mint history", err);
  }
}

async function attemptSilentWalletRestore() {
  if (!window.ethereum) return;
  try {
    await loadEthers();
    const provider = new ethers.providers.Web3Provider(window.ethereum, "any");
    const accounts = await provider.send("eth_accounts", []);
    const account = accounts?.[0];
    if (account) {
      signerAddress = account;
      loadMintHistoryForAddress(account);
      updateWalletUI();
    }
  } catch (err) {
    console.warn("Silent wallet restore skipped", err.message);
  }
}
