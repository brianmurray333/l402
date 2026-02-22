const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const crypto = require("crypto");
const cheerio = require("cheerio");
const { Resend } = require("resend");
const QRCode = require("qrcode");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config({ path: ".env.local" });
require("dotenv").config(); // fallback to .env

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const APPS_PATH = path.join(DATA_DIR, "apps.json");
const APIS_PATH = path.join(DATA_DIR, "apis.json");

/* ── Supabase ── */
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    : null;

if (supabase) {
  console.log("✅ Supabase connected");
} else {
  console.log("⚠️  No SUPABASE_URL/KEY — falling back to file-based storage");
}

const resend =
  process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim() !== ""
    ? new Resend(process.env.RESEND_API_KEY)
    : null;

/* ── L402 Configuration ── */
const rawLndHost = (process.env.LND_REST_HOST || "").replace(/\/+$/, "");
const LND_REST_HOST = rawLndHost && !rawLndHost.startsWith("http") ? `https://${rawLndHost}` : rawLndHost;
const LND_MACAROON_HEX = process.env.LND_MACAROON_HEX || "";
const MACAROON_SECRET = process.env.MACAROON_SECRET || "";
const APP_SUBMISSION_PRICE_SATS = 100;
const API_SUBMISSION_REWARD_SATS = 10;
const API_GET_PRICE_SATS = 10;
const BASE_BOOST_SATS = 21;
const LOW_BALANCE_THRESHOLD = parseInt(process.env.LOW_BALANCE_THRESHOLD || "1000", 10);
const LOW_BALANCE_COOLDOWN_MS = 3600000; // 1 hour
const BOOST_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOTTERY_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOTTERY_HOUSE_CUT = 0; // 0% for now
const LOTTERY_DEFAULT_SATS = 100;
const LOTTERY_MIN_SATS = 100;
const LOTTERY_MAX_SATS = 1000000;
const l402Enabled = !!(LND_REST_HOST && LND_MACAROON_HEX && MACAROON_SECRET);

const SITE_HOST = process.env.SITE_HOST || "https://www.l402apps.com";

// LND nodes typically use self-signed TLS certificates.
if (l402Enabled && process.env.LND_TLS_VERIFY !== "true") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

if (l402Enabled) {
  console.log("L402 enabled — app submissions charge 100 sats, API submissions pay 10 sats");
} else {
  console.log("L402 disabled — missing LND_REST_HOST, LND_MACAROON_HEX, or MACAROON_SECRET");
}

/* ── LND REST Client ── */
const lndRequest = async (method, urlPath, body) => {
  const url = `${LND_REST_HOST}${urlPath}`;
  const opts = {
    method,
    headers: {
      "Grpc-Metadata-macaroon": LND_MACAROON_HEX,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    console.error(`LND network error (${method} ${urlPath}):`, err.message);
    throw new Error(`LND unreachable: ${err.message}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LND ${method} ${urlPath}: ${res.status} — ${text}`);
  }
  return res.json();
};

// In-memory cache of recent invoices keyed by paymentHash (for QR endpoint)
const pendingInvoices = new Map();

const createLndInvoice = async (amountSats, memo) => {
  const data = await lndRequest("POST", "/v1/invoices", {
    value: String(amountSats),
    memo,
    expiry: "3600",
  });
  const paymentHash = Buffer.from(data.r_hash, "base64").toString("hex");
  const paymentRequest = data.payment_request;
  pendingInvoices.set(paymentHash, { paymentRequest });
  return { paymentHash, paymentRequest };
};

const lookupLndInvoice = async (paymentHashHex) => {
  try {
    const rHashBase64 = Buffer.from(paymentHashHex, "hex").toString("base64url");
    const data = await lndRequest("GET", `/v2/invoices/lookup?payment_hash=${rHashBase64}`);
    return data;
  } catch (_err) {
    const data = await lndRequest("GET", `/v1/invoice/${paymentHashHex}`);
    return data;
  }
};

const checkInvoicePaid = async (paymentHashHex) => {
  const data = await lookupLndInvoice(paymentHashHex);
  if (data.settled || data.state === "SETTLED") {
    const preimage = Buffer.from(data.r_preimage, "base64").toString("hex");
    return { paid: true, preimage };
  }
  return { paid: false };
};

/* ── LND: Outgoing Payments & Balance ── */
const decodeInvoice = async (paymentRequest) => {
  const data = await lndRequest("GET", `/v1/payreq/${paymentRequest}`);
  return data;
};

const payInvoice = async (paymentRequest) => {
  const data = await lndRequest("POST", "/v1/channels/transactions", {
    payment_request: paymentRequest,
    fee_limit: { fixed: "10" },
  });
  if (data.payment_error && data.payment_error !== "") {
    throw new Error(`Payment failed: ${data.payment_error}`);
  }
  return data;
};

const keysendPayment = async (destPubkeyHex, amountSats) => {
  const preimage = crypto.randomBytes(32);
  const paymentHash = crypto.createHash("sha256").update(preimage).digest();

  const data = await lndRequest("POST", "/v1/channels/transactions", {
    dest: Buffer.from(destPubkeyHex, "hex").toString("base64"),
    amt: String(amountSats),
    payment_hash: paymentHash.toString("base64"),
    final_cltv_delta: 40,
    dest_custom_records: {
      "5482373484": preimage.toString("base64"),
    },
    fee_limit: { fixed: "10" },
  });

  if (data.payment_error && data.payment_error !== "") {
    throw new Error(`Keysend failed: ${data.payment_error}`);
  }
  return data;
};

const isValidPubkey = (hex) => /^(02|03)[0-9a-fA-F]{64}$/.test(hex);

const getChannelBalance = async () => {
  const data = await lndRequest("GET", "/v1/balance/channels");
  return parseInt(data.balance || "0", 10);
};

let lastLowBalanceNotification = 0;

const checkAndNotifyLowBalance = async () => {
  try {
    const balance = await getChannelBalance();
    if (
      balance < LOW_BALANCE_THRESHOLD &&
      Date.now() - lastLowBalanceNotification > LOW_BALANCE_COOLDOWN_MS
    ) {
      lastLowBalanceNotification = Date.now();
      console.warn(`⚠️ Low Lightning balance: ${balance} sats`);
      if (resend) {
        const from = process.env.RESEND_FROM || "onboarding@resend.dev";
        const to = process.env.RESEND_TO || "brianmurray03@gmail.com";
        await resend.emails.send({
          from,
          to: [to],
          subject: "⚠️ L402 Apps — Low Lightning Balance",
          html: `
            <h2>Low Lightning Balance Warning</h2>
            <p>Your Lightning node balance is <strong>${balance} sats</strong>,
               which is below the ${LOW_BALANCE_THRESHOLD} sat threshold.</p>
            <p>Please add funds to continue paying API submission rewards.</p>
          `,
        });
      }
    }
  } catch (err) {
    console.error("Balance check error:", err.message);
  }
};

/* ── L402 Token (simplified macaroon) ── */
const mintL402Token = (paymentHashHex) => {
  const id = Buffer.from(paymentHashHex, "hex");
  const sig = crypto.createHmac("sha256", MACAROON_SECRET).update(id).digest();
  return Buffer.concat([id, sig]).toString("base64");
};

const verifyL402Token = (tokenBase64, preimageHex) => {
  const buf = Buffer.from(tokenBase64, "base64");
  if (buf.length !== 64) throw new Error("Invalid token length");

  const id = buf.subarray(0, 32);
  const sig = buf.subarray(32);

  const expectedSig = crypto.createHmac("sha256", MACAROON_SECRET).update(id).digest();
  if (!crypto.timingSafeEqual(sig, expectedSig)) {
    throw new Error("Invalid token signature");
  }

  const preimage = Buffer.from(preimageHex, "hex");
  const hash = crypto.createHash("sha256").update(preimage).digest();
  if (!crypto.timingSafeEqual(id, hash)) {
    throw new Error("Preimage does not match payment hash");
  }

  return true;
};

const parseL402Header = (header) => {
  if (!header || !header.startsWith("L402 ")) return null;
  const parts = header.slice(5).split(":");
  if (parts.length !== 2) return null;
  return { macaroon: parts[0], preimage: parts[1] };
};

/* ── L402 Middleware (reusable for fixed-price endpoints) ── */
const requireL402 = (amountSats, memo) => async (req, res, next) => {
  if (!l402Enabled) return next();

  const authHeader = req.headers["authorization"];
  const l402 = parseL402Header(authHeader);

  if (!l402) {
    try {
      const { paymentHash, paymentRequest } = await createLndInvoice(amountSats, memo);
      const macaroon = mintL402Token(paymentHash);

      let qrDataUrl = "";
      try {
        qrDataUrl = await QRCode.toDataURL(paymentRequest.toUpperCase(), {
          width: 220,
          margin: 2,
          color: { dark: "#e5e9f2", light: "#0d111a" },
        });
      } catch (_) {}

      return res
        .status(402)
        .set("WWW-Authenticate", `L402 macaroon="${macaroon}", invoice="${paymentRequest}"`)
        .json({
          error: "Payment required",
          macaroon,
          invoice: paymentRequest,
          paymentHash,
          amountSats,
          qrCode: qrDataUrl,
        });
    } catch (error) {
      console.error("Invoice creation error:", error.message);
      return res.status(500).json({ error: "Failed to create Lightning invoice" });
    }
  }

  try {
    verifyL402Token(l402.macaroon, l402.preimage);
    next();
  } catch (error) {
    console.error("L402 verification error:", error.message);
    return res.status(401).json({ error: "Invalid L402 token: " + error.message });
  }
};

/* ── Helpers ── */
const normalizeUrl = (value) => {
  if (!value) return "";
  try {
    const parsed = new URL(value.startsWith("http") ? value : `https://${value}`);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.toString();
  } catch (error) {
    return "";
  }
};

const urlToId = (url) => crypto.createHash("md5").update(url).digest("hex").slice(0, 12);

/* ── Data persistence (Supabase with file fallback) ── */
const readJson = async (filePath, fallback) => {
  try {
    const data = await fs.readFile(filePath, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    return fallback;
  }
};

// ── App submissions ──
const readSubmissions = async () => {
  if (supabase) {
    const { data, error } = await supabase.from("app_submissions").select("*").order("submitted_at", { ascending: false });
    if (!error && data) return data.map(row => ({
      id: row.id, name: row.name, url: row.url, description: row.description,
      image: row.image, icon: row.icon, status: row.status,
      paymentHash: row.payment_hash, submittedAt: row.submitted_at,
    }));
  }
  return readJson(path.join(DATA_DIR, "submissions.json"), []);
};

const writeSubmission = async (submission) => {
  if (supabase) {
    await supabase.from("app_submissions").upsert({
      id: submission.id, name: submission.name, url: submission.url,
      description: submission.description, image: submission.image,
      icon: submission.icon, status: submission.status || "pending",
      payment_hash: submission.paymentHash, submitted_at: submission.submittedAt,
    });
  }
};

// ── API submissions ──
const readApiSubmissions = async () => {
  if (supabase) {
    const { data, error } = await supabase.from("api_submissions").select("*").order("submitted_at", { ascending: false });
    if (!error && data) return data.map(row => ({
      id: row.id, provider: row.provider, name: row.name, method: row.method,
      endpoint: row.endpoint, description: row.description, cost: row.cost,
      costType: row.cost_type, direction: row.direction, icon: row.icon,
      verified: row.verified, verifiedAt: row.verified_at,
      rewardInvoice: row.reward_invoice, rewardPaid: row.reward_paid,
      paymentHash: row.payment_hash, submittedAt: row.submitted_at,
    }));
  }
  return readJson(path.join(DATA_DIR, "api-submissions.json"), []);
};

const writeApiSubmission = async (entry) => {
  if (supabase) {
    await supabase.from("api_submissions").upsert({
      id: entry.id, provider: entry.provider, name: entry.name,
      method: entry.method, endpoint: entry.endpoint,
      description: entry.description, cost: entry.cost,
      cost_type: entry.costType, direction: entry.direction,
      icon: entry.icon, verified: entry.verified,
      verified_at: entry.verifiedAt, reward_invoice: entry.rewardInvoice,
      reward_paid: entry.rewardPaid, payment_hash: entry.paymentHash,
      submitted_at: entry.submittedAt,
    });
  }
};

// ── Boosts ──
const readBoosts = async () => {
  if (supabase) {
    const { data, error } = await supabase
      .from("boosts").select("*")
      .gt("expires_at", new Date().toISOString());
    if (!error && data) return data.map(row => ({
      id: row.id, itemId: row.item_id, itemType: row.item_type,
      amountSats: row.amount_sats, paymentHash: row.payment_hash,
      createdAt: row.created_at, expiresAt: row.expires_at,
    }));
  }
  return readJson(path.join(DATA_DIR, "boosts.json"), []);
};

const writeBoost = async (boost) => {
  if (supabase) {
    await supabase.from("boosts").insert({
      id: boost.id, item_id: boost.itemId, item_type: boost.itemType,
      amount_sats: boost.amountSats, payment_hash: boost.paymentHash,
      created_at: boost.createdAt, expires_at: boost.expiresAt,
    });
  }
};

// ── Apps catalog (read from Supabase, fallback to JSON) ──
const readApps = async () => {
  if (supabase) {
    const { data, error } = await supabase.from("apps").select("*").order("sort_order", { ascending: true });
    if (!error && data && data.length > 0) return data.map(row => ({
      id: row.id, name: row.name, url: row.url, description: row.description,
      image: row.image, icon: row.icon,
    }));
  }
  return (await readJson(APPS_PATH, [])).map(a => ({ ...a, id: a.id || urlToId(a.url) }));
};

// ── APIs catalog (read from Supabase, fallback to JSON) ──
const readApisCatalog = async () => {
  if (supabase) {
    const { data, error } = await supabase.from("apis").select("*").order("created_at", { ascending: true });
    if (!error && data && data.length > 0) return data.map(row => ({
      id: row.id, provider: row.provider, name: row.name, method: row.method,
      endpoint: row.endpoint, docsUrl: row.docs_url, description: row.description,
      cost: row.cost, costType: row.cost_type, direction: row.direction,
      icon: row.icon, verified: row.verified, verifiedAt: row.verified_at,
      featured: row.featured,
    }));
  }
  return readJson(APIS_PATH, []);
};

const getMeta = ($, key) =>
  $(`meta[property='${key}']`).attr("content") || $(`meta[name='${key}']`).attr("content");

const absoluteUrl = (value, base) => {
  if (!value) return "";
  try {
    return new URL(value, base).toString();
  } catch (error) {
    return value;
  }
};

const parseIconSize = (sizes) => {
  if (!sizes || sizes === "any") return 0;
  const [width] = sizes.split("x").map((value) => Number.parseInt(value, 10));
  return Number.isFinite(width) ? width : 0;
};

const extractIcon = ($, baseUrl) => {
  const candidates = [];
  $("link").each((_, element) => {
    const rel = ($(element).attr("rel") || "").toLowerCase();
    if (!rel.includes("icon")) return;
    const href = $(element).attr("href");
    if (!href) return;
    const sizes = ($(element).attr("sizes") || "").toLowerCase();
    candidates.push({
      href: absoluteUrl(href, baseUrl),
      size: parseIconSize(sizes),
      rel,
    });
  });

  if (candidates.length === 0) {
    return absoluteUrl("/favicon.ico", baseUrl);
  }

  candidates.sort((a, b) => b.size - a.size);
  return candidates[0].href;
};

const fetchMetadata = async (url) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const response = await fetch(url, {
    signal: controller.signal,
    headers: {
      "user-agent": "L402-Marketplace",
      accept: "text/html,application/xhtml+xml",
    },
  });
  clearTimeout(timeout);

  const html = await response.text();
  const $ = cheerio.load(html);

  const title =
    getMeta($, "og:title") ||
    getMeta($, "twitter:title") ||
    $("title").text().trim() ||
    new URL(url).host;
  const description =
    getMeta($, "og:description") ||
    getMeta($, "twitter:description") ||
    $("meta[name='description']").attr("content") ||
    "";
  const image =
    getMeta($, "og:image") || getMeta($, "twitter:image") || getMeta($, "og:image:secure_url") || "";
  const siteName = getMeta($, "og:site_name") || "";
  const icon = extractIcon($, url);

  return {
    name: title || siteName,
    description,
    image: absoluteUrl(image, url),
    icon,
    url,
  };
};

/* ── L402 Endpoint Verification ── */
const verifyL402Endpoint = async (endpointUrl) => {
  const methods = ["GET", "POST"];
  let lastError = null;

  for (const method of methods) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(endpointUrl, {
        method,
        signal: controller.signal,
        headers: {
          "user-agent": "L402-Marketplace/1.0",
          "Content-Type": "application/json",
        },
        body: method === "POST" ? JSON.stringify({}) : undefined,
      });
      clearTimeout(timeout);

      if (res.status === 402) {
        const wwwAuth = res.headers.get("www-authenticate") || "";
        const invoiceMatch = wwwAuth.match(/invoice="([^"]+)"/);

        if (!invoiceMatch) {
          // Check if there's a JSON body with invoice info
          try {
            const body = await res.json();
            if (body.invoice) {
              return { verified: true, method, invoice: body.invoice, wwwAuth };
            }
          } catch (_) {}
          return { verified: false, error: "402 returned but no L402 invoice found in WWW-Authenticate header" };
        }

        return { verified: true, method, invoice: invoiceMatch[1], wwwAuth };
      }

      lastError = `${method} returned ${res.status} (expected 402)`;
    } catch (err) {
      lastError = `${method} failed: ${err.message}`;
    }
  }

  return { verified: false, error: lastError || "Endpoint did not return HTTP 402" };
};

/* ── Duplicate Detection ── */
const isDuplicateApp = async (url) => {
  const normalized = normalizeUrl(url).replace(/\/+$/, "").toLowerCase();
  if (!normalized) return false;

  const apps = await readApps();
  const submissions = await readSubmissions();
  const all = [...apps, ...submissions];

  return all.some((item) => {
    const existing = (item.url || "").replace(/\/+$/, "").toLowerCase();
    return existing === normalized;
  });
};

const isDuplicateApi = async (url) => {
  const normalized = normalizeUrl(url).replace(/\/+$/, "").toLowerCase();
  if (!normalized) return false;

  const apis = await readApisCatalog();
  const apiSubs = await readApiSubmissions();
  const all = [...apis, ...apiSubs];

  return all.some((item) => {
    const existing = (item.endpoint || item.url || "").replace(/\/+$/, "").toLowerCase();
    return existing === normalized;
  });
};

/* ── L402Apps.com Own API Definitions ── */
const getOwnApis = () => [
  {
    id: "l402apps-submit-app",
    provider: "L402 Apps",
    name: "Submit App",
    method: "POST",
    endpoint: `${SITE_HOST}/api/submissions`,
    description: "Submit an L402-powered app to the directory.",
    cost: APP_SUBMISSION_PRICE_SATS,
    costType: "fixed",
    direction: "charges",
    icon: "/images/bitcoin.png",
    verified: true,
    featured: true,
  },
  {
    id: "l402apps-submit-api",
    provider: "L402 Apps",
    name: "Submit API Endpoint",
    method: "POST",
    endpoint: `${SITE_HOST}/api/api-submissions`,
    description: "Submit a verified L402 API endpoint and earn 10 sats.",
    cost: API_SUBMISSION_REWARD_SATS,
    costType: "fixed",
    direction: "pays",
    icon: "/images/bitcoin.png",
    verified: true,
    featured: true,
  },
  {
    id: "l402apps-get-apps",
    provider: "L402 Apps",
    name: "Get Apps Directory",
    method: "GET",
    endpoint: `${SITE_HOST}/api/apps`,
    description: "Get the complete JSON listing of all L402-powered apps.",
    cost: API_GET_PRICE_SATS,
    costType: "fixed",
    direction: "charges",
    icon: "/images/bitcoin.png",
    verified: true,
    featured: true,
  },
  {
    id: "l402apps-get-apis",
    provider: "L402 Apps",
    name: "Get APIs Directory",
    method: "GET",
    endpoint: `${SITE_HOST}/api/apis`,
    description: "Get the complete JSON listing of all L402-powered API endpoints.",
    cost: API_GET_PRICE_SATS,
    costType: "fixed",
    direction: "charges",
    icon: "/images/bitcoin.png",
    verified: true,
    featured: true,
  },
  {
    id: "l402apps-boost",
    provider: "L402 Apps",
    name: "Boost Listing",
    method: "POST",
    endpoint: `${SITE_HOST}/api/boost`,
    description: "Pay to boost an app or API to the top of the list. Marketplace-driven dynamic pricing.",
    cost: null,
    costType: "variable",
    direction: "charges",
    icon: "/images/bitcoin.png",
    verified: true,
    featured: true,
  },
  {
    id: "l402apps-lottery",
    provider: "L402 Apps",
    name: "Lightning Lottery",
    method: "POST",
    endpoint: `${SITE_HOST}/api/lottery/enter`,
    description: "Enter the 24h Lightning Lottery. More sats = higher winning probability. Provide a Lightning Address or node pubkey for payout.",
    cost: LOTTERY_DEFAULT_SATS,
    costType: "variable",
    direction: "charges",
    icon: "/images/lottery.jpg",
    verified: true,
    featured: true,
  },
];

/* ── Boosts ── */
const getActiveBoosts = async () => {
  const boosts = await readBoosts();
  // Supabase query already filters expired boosts; file fallback needs filtering
  if (!supabase) {
    const now = new Date().toISOString();
    return boosts.filter((b) => b.expiresAt > now);
  }
  return boosts;
};

const getActiveBoostCount = async () => {
  return (await getActiveBoosts()).length;
};

const getBoostPrice = (activeBoostCount) => {
  return Math.ceil(BASE_BOOST_SATS * Math.pow(1 + activeBoostCount, 2));
};

/* ── Lightning Lottery ── */
let currentLottery = null;
let lotteryHistory = [];
const pendingLotteryEntries = new Map();

/*
 * Deterministic lottery rounds — the round boundaries are fixed to wall-clock time
 * so that every serverless instance agrees on when the current round started / ends,
 * even across cold starts.  We anchor to midnight UTC 2026-02-21 and step by LOTTERY_DURATION_MS.
 */
const LOTTERY_EPOCH = new Date("2026-02-21T00:00:00Z").getTime();

const getCurrentRoundBounds = () => {
  const now = Date.now();
  const elapsed = now - LOTTERY_EPOCH;
  const roundIndex = Math.floor(elapsed / LOTTERY_DURATION_MS);
  const startedAt = LOTTERY_EPOCH + roundIndex * LOTTERY_DURATION_MS;
  const endsAt = startedAt + LOTTERY_DURATION_MS;
  return {
    roundId: `round-${roundIndex}`,
    startedAt: new Date(startedAt).toISOString(),
    endsAt: new Date(endsAt).toISOString(),
  };
};

/* Lottery persistence — uses Supabase for cross-instance persistence */
const saveLotteryState = async () => {
  if (!supabase || !currentLottery) return;
  try {
    await supabase.from("lottery_rounds").upsert({
      id: currentLottery.id,
      started_at: currentLottery.startedAt,
      ends_at: currentLottery.endsAt,
      total_pot: currentLottery.totalPot,
      status: currentLottery.status,
      winner_address: currentLottery.winner?.lightningAddress || null,
      winner_pubkey: currentLottery.winner?.nodePubkey || null,
      winner_amount_contributed: currentLottery.winner?.amountContributed || null,
      winner_payout: currentLottery.winner?.payout || null,
      winner_house_cut: currentLottery.winner?.houseCut || null,
      winner_payout_status: currentLottery.winner?.payoutStatus || null,
      winner_payout_error: currentLottery.winner?.payoutError || null,
    });
  } catch (err) {
    console.error("Failed to save lottery state:", err.message);
  }
};

const saveLotteryEntry = async (entry, roundId) => {
  if (!supabase) return;
  try {
    await supabase.from("lottery_entries").insert({
      round_id: roundId,
      lightning_address: entry.lightningAddress || null,
      node_pubkey: entry.nodePubkey || null,
      amount_sats: entry.amountSats,
      payment_hash: entry.paymentHash || null,
      paid_at: entry.paidAt,
    });
  } catch (err) {
    console.error("Failed to save lottery entry:", err.message);
  }
};

const loadLotteryState = async () => {
  const { roundId } = getCurrentRoundBounds();

  if (supabase) {
    // Load current round from DB
    const { data: roundData } = await supabase
      .from("lottery_rounds").select("*").eq("id", roundId).single();

    if (roundData && roundData.status === "active") {
      // Load entries for this round
      const { data: entries } = await supabase
        .from("lottery_entries").select("*").eq("round_id", roundId).order("paid_at", { ascending: true });

      currentLottery = {
        id: roundData.id,
        startedAt: roundData.started_at,
        endsAt: roundData.ends_at,
        entries: (entries || []).map(e => ({
          lightningAddress: e.lightning_address,
          nodePubkey: e.node_pubkey,
          amountSats: e.amount_sats,
          paymentHash: e.payment_hash,
          paidAt: e.paid_at,
        })),
        totalPot: roundData.total_pot,
        status: roundData.status,
        winner: roundData.winner_payout_status ? {
          lightningAddress: roundData.winner_address,
          nodePubkey: roundData.winner_pubkey,
          amountContributed: roundData.winner_amount_contributed,
          payout: roundData.winner_payout,
          houseCut: roundData.winner_house_cut,
          payoutStatus: roundData.winner_payout_status,
          payoutError: roundData.winner_payout_error,
        } : null,
      };
      console.log(`📦 Loaded lottery state: round=${roundId}, pot=${roundData.total_pot} sats, entries=${entries?.length || 0}`);
    }

    // Load history
    const { data: historyData } = await supabase
      .from("lottery_rounds").select("*")
      .eq("status", "completed")
      .order("ends_at", { ascending: false })
      .limit(20);

    if (historyData && historyData.length > 0) {
      lotteryHistory = historyData.map(r => ({
        id: r.id, startedAt: r.started_at, endsAt: r.ends_at,
        totalPot: r.total_pot, status: r.status, entries: [],
        winner: r.winner_payout_status ? {
          lightningAddress: r.winner_address, nodePubkey: r.winner_pubkey,
          amountContributed: r.winner_amount_contributed,
          payout: r.winner_payout, houseCut: r.winner_house_cut,
          payoutStatus: r.winner_payout_status, payoutError: r.winner_payout_error,
        } : null,
      }));
      console.log(`📦 Loaded ${lotteryHistory.length} lottery history entries`);
    }
  }
};

const createNewLottery = async () => {
  const { roundId, startedAt, endsAt } = getCurrentRoundBounds();
  currentLottery = {
    id: roundId,
    startedAt,
    endsAt,
    entries: [],
    totalPot: 0,
    status: "active",
    winner: null,
  };
  await saveLotteryState();
  return currentLottery;
};

const maskLightningAddress = (address) => {
  if (!address) return "***@***.com";
  const [user, domain] = address.split("@");
  if (!user || !domain) return "***@***.com";
  const maskedUser = user.slice(0, 2) + "***";
  const parts = domain.split(".");
  const tld = parts.pop();
  const name = parts.join(".");
  const maskedDomain = name.slice(0, 2) + "***." + tld;
  return maskedUser + "@" + maskedDomain;
};

const getSafeLotteryState = (lottery) => {
  if (!lottery) return null;
  return {
    id: lottery.id,
    startedAt: lottery.startedAt,
    endsAt: lottery.endsAt,
    totalPot: lottery.totalPot,
    entryCount: lottery.entries.length,
    status: lottery.status,
    entries: lottery.entries.map((e) => ({
      amountSats: e.amountSats,
      paidAt: e.paidAt,
    })),
    winner: lottery.winner
      ? {
          maskedAddress: lottery.winner.lightningAddress
            ? maskLightningAddress(lottery.winner.lightningAddress)
            : lottery.winner.nodePubkey
              ? lottery.winner.nodePubkey.slice(0, 8) + "..." + lottery.winner.nodePubkey.slice(-4)
              : "unknown",
          payoutMethod: lottery.winner.lightningAddress ? "lightning_address" : "keysend",
          amountContributed: lottery.winner.amountContributed,
          payout: lottery.winner.payout,
          payoutStatus: lottery.winner.payoutStatus,
        }
      : null,
  };
};

const payToLightningAddress = async (address, amountSats) => {
  const [user, domain] = address.split("@");
  if (!user || !domain) throw new Error("Invalid Lightning Address");

  const lnurlUrl = `https://${domain}/.well-known/lnurlp/${user}`;

  const controller1 = new AbortController();
  const timeout1 = setTimeout(() => controller1.abort(), 10000);
  const res1 = await fetch(lnurlUrl, { signal: controller1.signal });
  clearTimeout(timeout1);

  if (!res1.ok) throw new Error(`LNURL fetch failed: ${res1.status}`);
  const lnurlData = await res1.json();

  if (lnurlData.tag !== "payRequest") {
    throw new Error("Not a valid LNURL-pay endpoint");
  }

  const millisats = amountSats * 1000;
  if (millisats < lnurlData.minSendable || millisats > lnurlData.maxSendable) {
    throw new Error(`Amount ${amountSats} sats is outside allowed range`);
  }

  const callbackUrl = new URL(lnurlData.callback);
  callbackUrl.searchParams.set("amount", String(millisats));

  const controller2 = new AbortController();
  const timeout2 = setTimeout(() => controller2.abort(), 10000);
  const res2 = await fetch(callbackUrl.toString(), { signal: controller2.signal });
  clearTimeout(timeout2);

  if (!res2.ok) throw new Error(`Invoice request failed: ${res2.status}`);
  const invoiceData = await res2.json();

  if (!invoiceData.pr) throw new Error("No invoice returned from LNURL");

  await payInvoice(invoiceData.pr);
  return invoiceData.pr;
};

const drawLottery = async () => {
  if (!currentLottery) return;

  if (currentLottery.entries.length === 0) {
    currentLottery.status = "completed";
    currentLottery.winner = null;
    await saveLotteryState();
    lotteryHistory.unshift({ ...currentLottery, entries: [] });
    await createNewLottery();
    return;
  }

  currentLottery.status = "drawing";

  // Weighted random selection
  const totalWeight = currentLottery.totalPot;
  let random = Math.floor(Math.random() * totalWeight);
  let winner = null;

  for (const entry of currentLottery.entries) {
    random -= entry.amountSats;
    if (random < 0) {
      winner = entry;
      break;
    }
  }
  if (!winner) winner = currentLottery.entries[currentLottery.entries.length - 1];

  const houseCut = Math.floor(currentLottery.totalPot * LOTTERY_HOUSE_CUT);
  const payout = currentLottery.totalPot - houseCut;

  currentLottery.winner = {
    lightningAddress: winner.lightningAddress || null,
    nodePubkey: winner.nodePubkey || null,
    amountContributed: winner.amountSats,
    payout,
    houseCut,
    payoutStatus: "pending",
  };

  if (l402Enabled && payout > 0) {
    try {
      if (winner.lightningAddress) {
        await payToLightningAddress(winner.lightningAddress, payout);
        console.log(`🎉 Lottery paid ${payout} sats to ${maskLightningAddress(winner.lightningAddress)}`);
      } else if (winner.nodePubkey) {
        await keysendPayment(winner.nodePubkey, payout);
        console.log(`🎉 Lottery keysent ${payout} sats to ${winner.nodePubkey.slice(0, 10)}...`);
      }
      currentLottery.winner.payoutStatus = "paid";
    } catch (err) {
      console.error("Lottery payout failed:", err.message);
      currentLottery.winner.payoutStatus = "failed";
      currentLottery.winner.payoutError = err.message;
    }
  }

  currentLottery.status = "completed";
  await saveLotteryState();
  lotteryHistory.unshift({
    ...currentLottery,
    entries: currentLottery.entries.map((e) => ({ amountSats: e.amountSats, paidAt: e.paidAt })),
  });

  await createNewLottery();
};

const ensureActiveLottery = async () => {
  if (!currentLottery) {
    await loadLotteryState();
  }
  if (!currentLottery) {
    await createNewLottery();
  }

  if (currentLottery.status === "active" && Date.now() > new Date(currentLottery.endsAt).getTime()) {
    await drawLottery();
  }

  return currentLottery;
};

/* ── Data Access (with boosts applied) ── */
const applyBoosts = (items, boosts, itemType) => {
  // Build a map: itemId -> highest active boost
  const boostMap = new Map();
  for (const b of boosts) {
    if (b.itemType !== itemType) continue;
    const existing = boostMap.get(b.itemId);
    if (!existing || b.amountSats > existing.amountSats) {
      boostMap.set(b.itemId, b);
    }
  }

  return items
    .map((item) => {
      const id = item.id || urlToId(item.url || item.endpoint || "");
      return { ...item, id, boost: boostMap.get(id) || null };
    })
    .sort((a, b) => {
      // Featured items stay at top
      if (a.featured && !b.featured) return -1;
      if (!a.featured && b.featured) return 1;
      // Then by boost amount
      const aBoost = a.boost?.amountSats || 0;
      const bBoost = b.boost?.amountSats || 0;
      return bBoost - aBoost;
    });
};

const getApps = async () => {
  const apps = await readApps();
  const submissions = await readSubmissions();
  const combined = [...apps, ...submissions];
  const boosts = await getActiveBoosts();
  return applyBoosts(combined, boosts, "app");
};

const getApis = async () => {
  const curated = await readApisCatalog();
  const submitted = await readApiSubmissions();
  const ownApis = getOwnApis();
  const combined = [...ownApis, ...curated, ...submitted];
  const boosts = await getActiveBoosts();
  return applyBoosts(combined, boosts, "api");
};

/* ── Email Notifications ── */
const sendSubmissionEmail = async (submission) => {
  if (!resend) return;

  const from = process.env.RESEND_FROM || "onboarding@resend.dev";
  const to = process.env.RESEND_TO || "brianmurray03@gmail.com";
  const subject = `New L402 app submission: ${submission.name}`;
  const html = `
    <h2>New L402 app submission</h2>
    <p><strong>Name:</strong> ${submission.name}</p>
    <p><strong>URL:</strong> ${submission.url}</p>
    <p><strong>Description:</strong> ${submission.description || "None provided"}</p>
    <p><strong>Image:</strong> ${submission.image || "None provided"}</p>
    <p><strong>Icon:</strong> ${submission.icon || "None provided"}</p>
    <p><strong>Submitted at:</strong> ${submission.submittedAt}</p>
  `;

  await resend.emails.send({ from, to: [to], subject, html });
};

const sendApiSubmissionEmail = async (entry) => {
  if (!resend) return;

  const from = process.env.RESEND_FROM || "onboarding@resend.dev";
  const to = process.env.RESEND_TO || "brianmurray03@gmail.com";
  const subject = `New L402 API submission: ${entry.provider} — ${entry.name}`;
  const html = `
    <h2>New L402 API endpoint submitted</h2>
    <p><strong>Provider:</strong> ${entry.provider}</p>
    <p><strong>Endpoint:</strong> ${entry.method} ${entry.endpoint}</p>
    <p><strong>Cost:</strong> ${entry.costType === "variable" ? "Variable" : entry.cost + " sats"}</p>
    <p><strong>Description:</strong> ${entry.description || "None"}</p>
    <p><strong>Paid:</strong> ${API_SUBMISSION_REWARD_SATS} sats</p>
    <p><strong>Submitted at:</strong> ${entry.submittedAt}</p>
  `;

  await resend.emails.send({ from, to: [to], subject, html });
};

/* ── Serve index.html with injected data ── */
const serveIndex = async (_req, res) => {
  try {
    let html = await fs.readFile(path.join(PUBLIC_DIR, "index.html"), "utf-8");
    const apps = await getApps();
    const apis = await getApis();
    const boostPrice = getBoostPrice(await getActiveBoostCount());

    const injection = `<script>
      window.__APPS__=${JSON.stringify(apps)};
      window.__APIS__=${JSON.stringify(apis)};
      window.__BOOST_PRICE__=${boostPrice};
      window.__L402_ENABLED__=${l402Enabled};
    </script>`;

    html = html.replace("</head>", `${injection}\n</head>`);
    res.send(html);
  } catch (err) {
    console.error("Error serving index:", err.message);
    res.status(500).send("Internal server error");
  }
};

/* ── Express Setup ── */
app.use(express.json());

/* Serve index with injected data BEFORE static middleware */
app.get("/", serveIndex);
app.get("/index.html", serveIndex);

/* Serve lottery page with injected data */
const serveLottery = async (_req, res) => {
  try {
    let html = await fs.readFile(path.join(PUBLIC_DIR, "lottery.html"), "utf-8");
    const lottery = await ensureActiveLottery();
    const safeHistory = lotteryHistory.slice(0, 20).map((l) => getSafeLotteryState(l));

    const injection = `<script>
      window.__LOTTERY__=${JSON.stringify(getSafeLotteryState(lottery))};
      window.__LOTTERY_HISTORY__=${JSON.stringify(safeHistory)};
      window.__L402_ENABLED__=${l402Enabled};
    </script>`;

    html = html.replace("</head>", `${injection}\n</head>`);
    res.send(html);
  } catch (err) {
    console.error("Error serving lottery:", err.message);
    res.status(500).send("Internal server error");
  }
};

app.get("/lottery", serveLottery);
app.get("/lottery.html", serveLottery);

app.use(express.static(PUBLIC_DIR, { index: false }));

/* ── API Routes ── */

/* L402 Status */
app.get("/api/l402/status", (_req, res) => {
  res.json({
    enabled: l402Enabled,
    appSubmissionCostSats: l402Enabled ? APP_SUBMISSION_PRICE_SATS : 0,
    apiSubmissionRewardSats: API_SUBMISSION_REWARD_SATS,
  });
});

/* Boost Price */
app.get("/api/boost/price", async (_req, res) => {
  const activeBoosts = await getActiveBoostCount();
  const priceSats = getBoostPrice(activeBoosts);
  res.json({
    priceSats,
    activeBoosts,
    basePrice: BASE_BOOST_SATS,
    formula: `${BASE_BOOST_SATS} × (1 + ${activeBoosts})² = ${priceSats}`,
  });
});

/* GET Apps Directory (L402-gated) */
app.get(
  "/api/apps",
  requireL402(API_GET_PRICE_SATS, "L402 Apps — Get apps directory"),
  async (_req, res) => {
    const apps = await getApps();
    res.json(apps);
  }
);

/* GET APIs Directory (L402-gated) */
app.get(
  "/api/apis",
  requireL402(API_GET_PRICE_SATS, "L402 Apps — Get APIs directory"),
  async (_req, res) => {
    const apis = await getApis();
    res.json(apis);
  }
);

/* Metadata fetch (free — used by the frontend for app submissions) */
app.post("/api/metadata", async (req, res) => {
  const url = normalizeUrl(req.body?.url);
  if (!url) {
    res.status(400).send("Invalid URL.");
    return;
  }

  try {
    const metadata = await fetchMetadata(url);
    res.json(metadata);
  } catch (error) {
    res.status(500).send("Metadata fetch failed.");
  }
});

/* Verify L402 Endpoint (free — used by the frontend for API submissions) */
app.post("/api/verify-l402", async (req, res) => {
  const rawUrl = normalizeUrl(req.body?.url);
  if (!rawUrl) {
    return res.status(400).json({ error: "Invalid URL" });
  }

  // Check for duplicates first
  if (await isDuplicateApi(rawUrl)) {
    return res.status(409).json({ error: "This API endpoint is already listed." });
  }

  // Verify the endpoint returns 402 with L402 headers
  const result = await verifyL402Endpoint(rawUrl);
  if (!result.verified) {
    return res.status(400).json({
      error: `Not a valid L402 endpoint: ${result.error}`,
    });
  }

  // Decode the invoice from the 402 response to extract cost & description
  let cost = null;
  let costType = "variable";
  let description = "";

  if (result.invoice && l402Enabled) {
    try {
      const decoded = await decodeInvoice(result.invoice);
      const sats = parseInt(decoded.num_satoshis || "0", 10);
      if (sats > 0) {
        cost = sats;
        costType = "fixed";
      }
      description = decoded.description || "";
    } catch (err) {
      console.error("Invoice decode error:", err.message);
      // Still verified, just can't extract cost/description
    }
  }

  // Extract provider info from URL
  let provider = "";
  let icon = "";
  try {
    const parsed = new URL(rawUrl);
    provider = parsed.hostname.replace(/^www\./, "");
    icon = `${parsed.origin}/favicon.ico`;
  } catch (_) {}

  res.json({
    verified: true,
    method: result.method,
    endpoint: rawUrl,
    provider,
    icon,
    cost,
    costType,
    description,
  });
});

/* Submit App (L402-gated — user pays 100 sats) */
app.post(
  "/api/submissions",
  requireL402(APP_SUBMISSION_PRICE_SATS, "L402 Apps — Submit an app"),
  async (req, res) => {
    const payload = {
      name: req.body?.name?.trim(),
      url: normalizeUrl(req.body?.url),
      description: req.body?.description?.trim(),
      image: req.body?.image?.trim(),
      icon: req.body?.icon?.trim(),
    };

    if (!payload.name || !payload.url) {
      return res.status(400).send("Name and URL are required.");
    }

    // Duplicate check
    if (await isDuplicateApp(payload.url)) {
      return res.status(409).json({ error: "This app is already listed." });
    }

    const submission = {
      ...payload,
      id: crypto.randomUUID(),
      submittedAt: new Date().toISOString(),
    };
    await writeSubmission(submission);

    try {
      await sendSubmissionEmail(submission);
    } catch (error) {
      // Keep submission saved even if email fails
    }

    res.json(submission);
  }
);

/* Submit API Endpoint (site pays user 10 sats) */
app.post("/api/api-submissions", async (req, res) => {
  const { url, invoice, description: userDesc } = req.body || {};
  const rawUrl = normalizeUrl(url);

  if (!rawUrl) {
    return res.status(400).json({ error: "A valid API endpoint URL is required." });
  }

  // Duplicate check
  if (await isDuplicateApi(rawUrl)) {
    return res.status(409).json({ error: "This API endpoint is already listed." });
  }

  // Check it's not one of our own endpoints
  const ownEndpoints = getOwnApis().map((a) => a.endpoint.toLowerCase());
  if (ownEndpoints.includes(rawUrl.toLowerCase())) {
    return res.status(409).json({ error: "This endpoint is already listed." });
  }

  // Verify the endpoint is actually L402
  const verification = await verifyL402Endpoint(rawUrl);
  if (!verification.verified) {
    return res.status(400).json({
      error: `Not a valid L402 endpoint: ${verification.error}`,
    });
  }

  // Decode the 402 response invoice for cost/description
  let cost = null;
  let costType = "variable";
  let description = "";

  if (verification.invoice && l402Enabled) {
    try {
      const decoded = await decodeInvoice(verification.invoice);
      const sats = parseInt(decoded.num_satoshis || "0", 10);
      if (sats > 0) {
        cost = sats;
        costType = "fixed";
      }
      description = decoded.description || "";
    } catch (err) {
      console.error("Invoice decode error:", err.message);
    }
  }

  // Allow user to override description
  if (userDesc && userDesc.trim()) {
    description = userDesc.trim();
  }

  // Extract provider info
  let provider = "";
  let icon = "";
  try {
    const parsed = new URL(rawUrl);
    provider = parsed.hostname.replace(/^www\./, "");
    icon = `${parsed.origin}/favicon.ico`;
  } catch (_) {}

  // If L402 enabled, verify and pay the submitter's invoice
  if (l402Enabled) {
    if (!invoice || !invoice.trim()) {
      return res.status(400).json({
        error: "A Lightning invoice for 10 sats is required to receive your reward.",
      });
    }

    // Decode the user's invoice to verify amount
    let userInvoiceDecoded;
    try {
      userInvoiceDecoded = await decodeInvoice(invoice.trim());
    } catch (err) {
      return res.status(400).json({
        error: "Could not decode your Lightning invoice. Please provide a valid bolt11 invoice.",
      });
    }

    const invoiceSats = parseInt(userInvoiceDecoded.num_satoshis || "0", 10);
    if (invoiceSats !== API_SUBMISSION_REWARD_SATS) {
      return res.status(400).json({
        error: `Invoice must be for exactly ${API_SUBMISSION_REWARD_SATS} sats (got ${invoiceSats} sats).`,
      });
    }

    // Pay the invoice
    try {
      await payInvoice(invoice.trim());
    } catch (err) {
      console.error("Payment to submitter failed:", err.message);
      return res.status(502).json({
        error: "Payment failed. Please check your invoice and try again. " + err.message,
      });
    }

    // Check balance after payment
    checkAndNotifyLowBalance().catch(() => {});
  }

  // Save the API entry
  const entry = {
    id: crypto.randomUUID(),
    provider,
    name: description || `${provider} API`,
    method: verification.method,
    endpoint: rawUrl,
    description,
    cost,
    costType,
    direction: "charges",
    icon,
    verified: true,
    verifiedAt: new Date().toISOString(),
    submittedAt: new Date().toISOString(),
  };

  await writeApiSubmission(entry);

  try {
    await sendApiSubmissionEmail(entry);
  } catch (error) {
    // Keep entry saved even if email fails
  }

  res.json(entry);
});

/* Boost (L402-gated with dynamic pricing) */
app.post("/api/boost", async (req, res) => {
  if (!l402Enabled) {
    return res.status(503).json({ error: "L402 not configured" });
  }

  const authHeader = req.headers["authorization"];
  const l402 = parseL402Header(authHeader);

  if (!l402) {
    // Calculate dynamic price and issue 402
    const { itemId, itemType } = req.body || {};
    if (!itemId || !["app", "api"].includes(itemType)) {
      return res.status(400).json({ error: "itemId and itemType (app|api) are required." });
    }

    const activeBoosts = await getActiveBoostCount();
    const priceSats = getBoostPrice(activeBoosts);

    try {
      const { paymentHash, paymentRequest } = await createLndInvoice(
        priceSats,
        `L402 Apps — Boost ${itemType} listing`
      );
      const macaroon = mintL402Token(paymentHash);

      let qrDataUrl = "";
      try {
        qrDataUrl = await QRCode.toDataURL(paymentRequest.toUpperCase(), {
          width: 220,
          margin: 2,
          color: { dark: "#e5e9f2", light: "#0d111a" },
        });
      } catch (_) {}

      return res
        .status(402)
        .set("WWW-Authenticate", `L402 macaroon="${macaroon}", invoice="${paymentRequest}"`)
        .json({
          error: "Payment required",
          macaroon,
          invoice: paymentRequest,
          paymentHash,
          amountSats: priceSats,
          qrCode: qrDataUrl,
        });
    } catch (error) {
      console.error("Boost invoice creation error:", error.message);
      return res.status(500).json({ error: "Failed to create Lightning invoice" });
    }
  }

  // Verify L402 token
  try {
    verifyL402Token(l402.macaroon, l402.preimage);
  } catch (error) {
    return res.status(401).json({ error: "Invalid L402 token: " + error.message });
  }

  const { itemId, itemType } = req.body || {};
  if (!itemId || !["app", "api"].includes(itemType)) {
    return res.status(400).json({ error: "itemId and itemType (app|api) are required." });
  }

  // Look up how much they paid from LND
  let amountSats = 0;
  try {
    const paymentHash = Buffer.from(l402.macaroon, "base64").subarray(0, 32).toString("hex");
    const invoiceData = await lookupLndInvoice(paymentHash);
    amountSats = parseInt(invoiceData.value || invoiceData.amt_paid_sat || "0", 10);
  } catch (err) {
    console.error("Could not look up boost invoice amount:", err.message);
    // Fall back to current price
    amountSats = getBoostPrice(await getActiveBoostCount());
  }

  // Save the boost
  const boost = {
    id: crypto.randomUUID(),
    itemId,
    itemType,
    amountSats,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + BOOST_DURATION_MS).toISOString(),
  };
  await writeBoost(boost);

  res.json({ success: true, boost });
});

/* ── QR Code Image Endpoint ── */
app.get("/api/l402/qr/:paymentHash", async (req, res) => {
  const invoice = pendingInvoices.get(req.params.paymentHash);
  if (!invoice) {
    return res.status(404).send("Invoice not found");
  }
  try {
    const buffer = await QRCode.toBuffer(invoice.paymentRequest.toUpperCase(), {
      width: 280,
      margin: 2,
      color: { dark: "#000000", light: "#ffffff" },
    });
    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "no-store");
    res.send(buffer);
  } catch (err) {
    console.error("QR generation error:", err.message);
    res.status(500).send("QR generation failed");
  }
});

/* ── L402 Invoice Check (for browser polling) ── */
app.get("/api/l402/check/:paymentHash", async (req, res) => {
  if (!l402Enabled) {
    return res.status(503).json({ error: "L402 not configured" });
  }

  try {
    const result = await checkInvoicePaid(req.params.paymentHash);
    res.json(result);
  } catch (error) {
    console.error("Invoice check error:", error.message);
    res.status(500).json({ error: "Failed to check invoice status" });
  }
});

/* ── Lottery API Routes ── */

/* GET current lottery state */
app.get("/api/lottery", async (_req, res) => {
  const lottery = await ensureActiveLottery();
  res.json(getSafeLotteryState(lottery));
});

/* GET lottery history */
app.get("/api/lottery/history", async (_req, res) => {
  await ensureActiveLottery(); // trigger draw if needed
  const safeHistory = lotteryHistory.slice(0, 20).map((l) => getSafeLotteryState(l));
  res.json(safeHistory);
});

/* POST enter lottery (L402-gated, variable amount) */
app.post("/api/lottery/enter", async (req, res) => {
  if (!l402Enabled) {
    return res.status(503).json({ error: "L402 not configured" });
  }

  const lottery = await ensureActiveLottery();
  if (lottery.status !== "active") {
    return res.status(409).json({ error: "Lottery is currently drawing. Please wait for the next round." });
  }

  const { lightningAddress, nodePubkey, amountSats: rawAmount } = req.body || {};
  const amountSats = parseInt(rawAmount || LOTTERY_DEFAULT_SATS, 10);

  // Must provide either a Lightning Address or a node pubkey
  const hasLnAddress = lightningAddress && lightningAddress.includes("@");
  const hasPubkey = nodePubkey && isValidPubkey(nodePubkey);

  if (!hasLnAddress && !hasPubkey) {
    return res.status(400).json({
      error:
        "Provide either a Lightning Address (e.g. user@wallet.com) or a node pubkey (66-char hex starting with 02/03).",
    });
  }

  if (!Number.isFinite(amountSats) || amountSats < LOTTERY_MIN_SATS || amountSats > LOTTERY_MAX_SATS) {
    return res
      .status(400)
      .json({ error: `Amount must be between ${LOTTERY_MIN_SATS} and ${LOTTERY_MAX_SATS.toLocaleString()} sats.` });
  }

  const authHeader = req.headers["authorization"];
  const l402 = parseL402Header(authHeader);

  if (!l402) {
    // Issue 402 with invoice
    try {
      const { paymentHash, paymentRequest } = await createLndInvoice(
        amountSats,
        `Lightning Lottery — ${amountSats} sat entry`
      );
      const macaroon = mintL402Token(paymentHash);

      // Store pending entry with whichever payout method was provided
      pendingLotteryEntries.set(paymentHash, {
        lightningAddress: hasLnAddress ? lightningAddress : null,
        nodePubkey: hasPubkey ? nodePubkey : null,
        amountSats,
      });

      let qrDataUrl = "";
      try {
        qrDataUrl = await QRCode.toDataURL(paymentRequest.toUpperCase(), {
          width: 260,
          margin: 2,
          color: { dark: "#e5e9f2", light: "#0d111a" },
        });
      } catch (_) {}

      return res
        .status(402)
        .set("WWW-Authenticate", `L402 macaroon="${macaroon}", invoice="${paymentRequest}"`)
        .json({
          error: "Payment required",
          macaroon,
          invoice: paymentRequest,
          paymentHash,
          amountSats,
          qrCode: qrDataUrl,
        });
    } catch (error) {
      console.error("Lottery invoice creation error:", error.message);
      return res.status(500).json({ error: "Failed to create Lightning invoice" });
    }
  }

  // Verify L402 token
  try {
    verifyL402Token(l402.macaroon, l402.preimage);
  } catch (error) {
    return res.status(401).json({ error: "Invalid L402 token: " + error.message });
  }

  const paymentHash = Buffer.from(l402.macaroon, "base64").subarray(0, 32).toString("hex");

  // Look up actual paid amount from LND (don't rely on in-memory state which is lost across serverless instances)
  let paidAmountSats = amountSats;
  try {
    const invoiceData = await lookupLndInvoice(paymentHash);
    paidAmountSats = parseInt(invoiceData.value || invoiceData.amt_paid_sat || "0", 10);
    if (paidAmountSats <= 0) paidAmountSats = amountSats;
  } catch (err) {
    console.error("Could not look up lottery invoice amount:", err.message);
    // Fall back to the amount the client claims (already validated above)
  }

  // Clean up in-memory pending entry if it exists (may have been set by same instance)
  pendingLotteryEntries.delete(paymentHash);

  // Re-check lottery is still active
  if (currentLottery.status !== "active") {
    return res.status(409).json({ error: "Lottery round ended while you were paying. Your sats will carry over." });
  }

  // Prevent duplicate entries for the same payment hash
  if (currentLottery.entries.some((e) => e.paymentHash === paymentHash)) {
    return res.json({
      success: true,
      entry: currentLottery.entries.find((e) => e.paymentHash === paymentHash),
      lottery: getSafeLotteryState(currentLottery),
    });
  }

  // Record the entry using request body data (client re-sends it) + LND-verified amount
  const entry = {
    lightningAddress: hasLnAddress ? lightningAddress : null,
    nodePubkey: hasPubkey ? nodePubkey : null,
    amountSats: paidAmountSats,
    paidAt: new Date().toISOString(),
    paymentHash,
  };

  currentLottery.entries.push(entry);
  currentLottery.totalPot += paidAmountSats;

  // Persist to Supabase
  await saveLotteryEntry(entry, currentLottery.id);
  await saveLotteryState();

  const entryLabel = hasLnAddress
    ? maskLightningAddress(lightningAddress)
    : nodePubkey.slice(0, 10) + "...";
  console.log(`🎫 Lottery entry: ${paidAmountSats} sats from ${entryLabel} — pot now ${currentLottery.totalPot} sats`);

  res.json({
    success: true,
    entry: { amountSats: entry.amountSats, paidAt: entry.paidAt },
    lottery: getSafeLotteryState(currentLottery),
  });
});

/* ── Catch-all ── */
app.get("*", (req, res) => {
  // Serve other static files as-is, but fallback to injected index for SPA routes
  const filePath = path.join(PUBLIC_DIR, req.path);
  res.sendFile(filePath, (err) => {
    if (err) serveIndex(req, res);
  });
});

app.listen(PORT, () => {
  console.log(`L402 marketplace running on http://localhost:${PORT}`);
});
