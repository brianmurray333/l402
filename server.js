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
const API_SUBMISSION_REWARD_SATS = 100;
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
const MILLION_GRID_SIZE = 1000;
const MILLION_TOTAL_PIXELS = MILLION_GRID_SIZE * MILLION_GRID_SIZE;
const MILLION_MIN_PIXELS = 1;
const MILLION_MAX_PIXELS = 100000;
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

// ── Million Sat Homepage (pixel blocks) ──
let pixelBlocksCache = [];
let pixelBlocksCacheTime = 0;
const PIXEL_CACHE_TTL = 10000;

const readPixelBlocks = async () => {
  if (Date.now() - pixelBlocksCacheTime < PIXEL_CACHE_TTL && pixelBlocksCache.length > 0) {
    return pixelBlocksCache;
  }
  if (supabase) {
    const { data, error } = await supabase
      .from("pixel_blocks").select("*").order("created_at", { ascending: true });
    if (!error && data) {
      pixelBlocksCache = data.map(row => ({
        id: row.id, x: row.x, y: row.y, width: row.width, height: row.height,
        color: row.color, imageData: row.image_data, link: row.link,
        title: row.title, paymentHash: row.payment_hash,
        amountSats: row.amount_sats, createdAt: row.created_at,
      }));
      pixelBlocksCacheTime = Date.now();
      return pixelBlocksCache;
    }
  }
  return readJson(path.join(DATA_DIR, "pixel-blocks.json"), []);
};

const writePixelBlock = async (block) => {
  if (supabase) {
    await supabase.from("pixel_blocks").insert({
      id: block.id, x: block.x, y: block.y, width: block.width, height: block.height,
      color: block.color || "#ff9900", image_data: block.imageData || null,
      link: block.link || null, title: block.title || null,
      payment_hash: block.paymentHash, amount_sats: block.amountSats,
      created_at: block.createdAt,
    });
  }
  pixelBlocksCache = [];
  pixelBlocksCacheTime = 0;
};

const checkPixelOverlap = async (x, y, w, h) => {
  const blocks = await readPixelBlocks();
  for (const b of blocks) {
    if (x < b.x + b.width && x + w > b.x && y < b.y + b.height && y + h > b.y) {
      return true;
    }
  }
  return false;
};

const getPixelStats = async () => {
  const blocks = await readPixelBlocks();
  let totalPixels = 0;
  let totalSats = 0;
  const owners = {};
  for (const b of blocks) {
    const px = b.width * b.height;
    totalPixels += px;
    totalSats += b.amountSats;
    const key = b.title || "Anonymous";
    owners[key] = (owners[key] || 0) + px;
  }
  const leaderboard = Object.entries(owners)
    .map(([name, pixels]) => ({ name, pixels }))
    .sort((a, b) => b.pixels - a.pixels)
    .slice(0, 10);
  return { totalPixels, totalSats, blockCount: blocks.length, leaderboard };
};

const pendingPixelPurchases = new Map();

const completePixelPurchase = async (paymentHash, paidAmountSats) => {
  const pending = pendingPixelPurchases.get(paymentHash);
  if (!pending) return null;
  pendingPixelPurchases.delete(paymentHash);

  const overlaps = await checkPixelOverlap(pending.x, pending.y, pending.width, pending.height);
  if (overlaps) {
    console.log(`🟧 Million Sat: auto-complete skipped — pixels at (${pending.x},${pending.y}) already taken`);
    return null;
  }

  const block = {
    id: crypto.randomUUID(),
    x: pending.x, y: pending.y, width: pending.width, height: pending.height,
    color: pending.color || "#ff9900",
    imageData: pending.imageData || null,
    link: pending.link ? normalizeUrl(pending.link) : null,
    title: (pending.title || "").trim().slice(0, 100) || null,
    paymentHash,
    amountSats: paidAmountSats || pending.amountSats,
    createdAt: new Date().toISOString(),
  };

  await writePixelBlock(block);
  const px = block.width * block.height;
  console.log(`🟧 Million Sat (auto): ${px} pixel${px === 1 ? "" : "s"} at (${block.x},${block.y}) for ${block.amountSats} sats — "${block.title || "Anonymous"}"`);
  return block;
};

const startPixelPaymentPolling = (paymentHash) => {
  let attempts = 0;
  const maxAttempts = 150; // ~5 minutes at 2s intervals
  const interval = setInterval(async () => {
    attempts++;
    if (!pendingPixelPurchases.has(paymentHash) || attempts > maxAttempts) {
      clearInterval(interval);
      if (attempts > maxAttempts) pendingPixelPurchases.delete(paymentHash);
      return;
    }
    try {
      const result = await checkInvoicePaid(paymentHash);
      if (result.paid) {
        clearInterval(interval);
        let paidAmount = 0;
        try {
          const inv = await lookupLndInvoice(paymentHash);
          paidAmount = parseInt(inv.value || inv.amt_paid_sat || "0", 10);
        } catch (_) {}
        await completePixelPurchase(paymentHash, paidAmount);
      }
    } catch (_) {}
  }, 2000);
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
  let got401 = false;
  let got401Method = null;
  let got401WwwAuth = "";

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
          try {
            const body = await res.json();
            if (body.invoice) {
              return { verified: true, type: "full", method, invoice: body.invoice, wwwAuth };
            }
          } catch (_) {}
          return { verified: true, type: "full", method, invoice: null, wwwAuth };
        }

        return { verified: true, type: "full", method, invoice: invoiceMatch[1], wwwAuth };
      }

      if (res.status === 401) {
        got401 = true;
        got401Method = method;
        got401WwwAuth = res.headers.get("www-authenticate") || "";
        // Check body for L402 hints
        try {
          const body = await res.json();
          if (body.invoice) {
            return { verified: true, type: "full", method, invoice: body.invoice, wwwAuth: got401WwwAuth };
          }
        } catch (_) {}
      }

      lastError = `${method} returned ${res.status} (expected 402)`;
    } catch (err) {
      lastError = `${method} failed: ${err.message}`;
    }
  }

  // 401 means the endpoint requires auth -- it may accept L402 tokens
  // even though it doesn't self-issue 402 challenges
  if (got401) {
    return { verified: true, type: "compatible", method: got401Method, invoice: null, wwwAuth: got401WwwAuth };
  }

  return { verified: false, error: lastError || "Endpoint did not return HTTP 402 or 401" };
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
    description: `Submit a verified L402 API endpoint and earn ${API_SUBMISSION_REWARD_SATS} sats. Accepts BOLT11 invoice or Lightning address for payout.`,
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
  {
    id: "l402apps-million-buy",
    provider: "L402 Apps",
    name: "Million Sat Homepage — Buy Pixels",
    method: "POST",
    endpoint: `${SITE_HOST}/api/million/buy`,
    description: "Buy pixels on the Million Sat Homepage. 1 sat per pixel, minimum 1 pixel. Proceeds donated to OpenSats. Provide x, y, width, height, and optional color/imageData/link/title.",
    cost: 1,
    costType: "variable",
    direction: "charges",
    icon: "/images/bitcoin.png",
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
      // Query entry counts for all history rounds in one go
      const historyIds = historyData.map(r => r.id);
      const { data: countData } = await supabase
        .from("lottery_entries")
        .select("round_id")
        .in("round_id", historyIds);

      const countMap = {};
      if (countData) {
        for (const row of countData) {
          countMap[row.round_id] = (countMap[row.round_id] || 0) + 1;
        }
      }

      lotteryHistory = historyData.map(r => ({
        id: r.id, startedAt: r.started_at, endsAt: r.ends_at,
        totalPot: r.total_pot, status: r.status, entries: [],
        entryCount: countMap[r.id] || 0,
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
    entryCount: lottery.entryCount != null ? lottery.entryCount : lottery.entries.length,
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
    lotteryHistory.unshift({ ...currentLottery, entries: [], entryCount: 0 });
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
    entryCount: currentLottery.entries.length,
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

/* Serve Million Sat Homepage with injected data */
const serveMillion = async (_req, res) => {
  try {
    let html = await fs.readFile(path.join(PUBLIC_DIR, "million.html"), "utf-8");
    const blocks = await readPixelBlocks();
    const stats = await getPixelStats();

    const injection = `<script>
      window.__PIXEL_BLOCKS__=${JSON.stringify(blocks)};
      window.__PIXEL_STATS__=${JSON.stringify(stats)};
      window.__L402_ENABLED__=${l402Enabled};
    </script>`;

    html = html.replace("</head>", `${injection}\n</head>`);
    res.send(html);
  } catch (err) {
    console.error("Error serving million:", err.message);
    res.status(500).send("Internal server error");
  }
};

app.get("/million", serveMillion);
app.get("/million.html", serveMillion);

app.use(express.static(PUBLIC_DIR, { index: false }));

/* ── API Routes ── */

/* Agent discovery — machine-readable manifest of all L402 endpoints */
app.get("/.well-known/l402.json", (_req, res) => {
  res.json({
    name: "L402 Apps",
    description: "Directory of L402-powered apps and API endpoints. Submit your L402 endpoints and earn sats.",
    url: SITE_HOST,
    endpoints: getOwnApis().map(({ id, name, method, endpoint, description, cost, costType, direction }) => ({
      id, name, method, endpoint, description, cost, costType, direction,
    })),
    millionSatHomepage: {
      description: "The Million Sat Homepage — own a piece of Bitcoin internet history. 1 sat per pixel. All proceeds donated to OpenSats.",
      gridSize: MILLION_GRID_SIZE,
      totalPixels: MILLION_TOTAL_PIXELS,
      costPerPixel: 1,
      minPixels: MILLION_MIN_PIXELS,
      maxPixels: MILLION_MAX_PIXELS,
      pageUrl: `${SITE_HOST}/million`,
      endpoints: {
        grid: { method: "GET", url: `${SITE_HOST}/api/million/grid`, description: "Get all purchased pixel blocks (free)." },
        stats: { method: "GET", url: `${SITE_HOST}/api/million/stats`, description: "Get grid stats: total pixels sold, sats raised, leaderboard (free)." },
        check: { method: "POST", url: `${SITE_HOST}/api/million/check`, description: "Check if a region is available. Send {x, y, width, height}.", body: { x: "integer 0-999", y: "integer 0-999", width: "integer >=1", height: "integer >=1" } },
        buy: { method: "POST", url: `${SITE_HOST}/api/million/buy`, description: "Buy pixels via L402. Send {x, y, width, height, color?, imageData?, link?, title?}. Returns 402 with invoice on first call; pay and retry with Authorization: L402 macaroon:preimage header.", body: { x: "integer 0-999", y: "integer 0-999", width: "integer >=1", height: "integer >=1", color: "hex color string (optional, default #ff9900)", imageData: "base64 data URL of image — use a rasterized format (PNG or JPEG). IMPORTANT: source image should be 3-5x the block dimensions for crisp rendering (e.g. 250x250 source for a 50x50 block). The canvas scales it down with smooth interpolation. If your encoded image is under 1KB for blocks larger than a few pixels, something is wrong — verify the image before submitting. Do NOT use SVG data URLs.", link: "URL to link to when clicked (optional)", title: "display name / tooltip (optional, max 100 chars)" } },
      },
      agentInstructions: "To buy pixels: 1) POST /api/million/check to verify availability, 2) POST /api/million/buy with your desired region — you'll get a 402 with an invoice, 3) Pay the Lightning invoice, 4) POST /api/million/buy again with the SAME request body plus Authorization: L402 <macaroon>:<preimage> header to confirm. Cost = width * height sats (1 sat per pixel). IMAGE TIPS: Use a real PNG/JPEG image at 3-5x the block dimensions (e.g. 250x250 for a 50x50 block). Verify your base64 output is a valid image — if under 1KB for anything larger than a few pixels, the image is likely blank/broken.",
    },
    submission: {
      endpoint: `${SITE_HOST}/api/api-submissions`,
      method: "POST",
      description: `Submit an L402 API endpoint. The site verifies your endpoint returns HTTP 402 (full L402) or 401 (L402-compatible), then pays you ${API_SUBMISSION_REWARD_SATS} sats.`,
      rewardSats: API_SUBMISSION_REWARD_SATS,
      request: {
        url: { type: "string", required: true, description: "The L402 endpoint URL to verify and list." },
        invoice: { type: "string", required: false, description: `A BOLT11 Lightning invoice for exactly ${API_SUBMISSION_REWARD_SATS} sats. Preferred payment method.` },
        lightningAddress: { type: "string", required: false, description: `A Lightning address (e.g. user@wallet.com) to receive ${API_SUBMISSION_REWARD_SATS} sats. Fallback if you cannot generate an invoice.` },
        description: { type: "string", required: false, description: "Optional human-readable description of the endpoint." },
      },
      notes: "Provide either 'invoice' (preferred) or 'lightningAddress' (fallback). The endpoint URL is verified server-side — endpoints returning HTTP 402 (with L402 challenge) or 401 (L402-compatible, accepts L402 tokens) are both accepted.",
      example: {
        curl: `curl -X POST ${SITE_HOST}/api/api-submissions -H "Content-Type: application/json" -d '{"url":"https://api.example.com/v1/resource","lightningAddress":"you@wallet.com"}'`,
      },
    },
  });
});

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
    type: result.type,
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

/* Human-friendly API endpoint page */
app.get("/api/api-submissions", (_req, res) => {
  const rewardCopy = l402Enabled
    ? `Submitters receive ${API_SUBMISSION_REWARD_SATS} sats after successful verification.`
    : "Submissions are accepted, but Lightning rewards are currently disabled.";

  res
    .status(200)
    .type("html")
    .send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>L402 Apps API - Submit API Endpoint</title>
    <style>
      :root {
        color-scheme: dark;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
        background: radial-gradient(circle at 0% 0%, #1f2937 0, #0b1220 40%, #060a12 100%);
        color: #e5e7eb;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .card {
        width: min(900px, 100%);
        background: rgba(12, 18, 31, 0.88);
        border: 1px solid rgba(148, 163, 184, 0.26);
        border-radius: 18px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
        padding: 28px;
      }
      .eyebrow {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border-radius: 999px;
        border: 1px solid rgba(250, 204, 21, 0.4);
        color: #facc15;
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        padding: 6px 12px;
        margin-bottom: 14px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: clamp(1.5rem, 3vw, 2.2rem);
      }
      .muted {
        color: #cbd5e1;
        margin: 0 0 16px;
        line-height: 1.55;
      }
      .badge {
        display: inline-block;
        font-weight: 700;
        color: #0f172a;
        background: #38bdf8;
        border-radius: 8px;
        padding: 4px 10px;
        margin-right: 8px;
      }
      .endpoint {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        color: #93c5fd;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
        gap: 14px;
        margin: 18px 0;
      }
      .panel {
        background: rgba(15, 23, 42, 0.72);
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 12px;
        padding: 14px;
      }
      .panel h2 {
        margin: 0 0 10px;
        font-size: 1rem;
      }
      ul {
        margin: 0;
        padding-left: 18px;
      }
      li + li {
        margin-top: 8px;
      }
      code,
      pre {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      }
      pre {
        margin: 8px 0 0;
        overflow-x: auto;
        border-radius: 10px;
        background: #020617;
        border: 1px solid rgba(148, 163, 184, 0.26);
        padding: 12px;
        color: #e2e8f0;
      }
      .actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 20px;
      }
      .btn {
        text-decoration: none;
        font-weight: 600;
        border-radius: 10px;
        padding: 10px 14px;
      }
      .btn-primary {
        color: #0f172a;
        background: #facc15;
      }
      .btn-secondary {
        color: #dbeafe;
        border: 1px solid rgba(148, 163, 184, 0.35);
      }
      .status {
        margin-top: 10px;
        color: #bbf7d0;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="eyebrow">L402 Apps API Endpoint</div>
      <h1>Submit a verified L402 API</h1>
      <p class="muted">
        This route is intended for server-to-server calls.
        <span class="badge">POST</span>
        <span class="endpoint">${SITE_HOST}/api/api-submissions</span>
      </p>

      <section class="grid">
        <article class="panel">
          <h2>Request body</h2>
          <ul>
            <li><code>url</code> (required): the endpoint URL to verify.</li>
            <li><code>invoice</code>: a ${API_SUBMISSION_REWARD_SATS}-sat BOLT11 invoice for payout (preferred).</li>
            <li><code>lightningAddress</code>: a Lightning address, e.g. <code>user@wallet.com</code> (fallback if you can't generate an invoice).</li>
            <li><code>description</code> (optional): your endpoint description.</li>
          </ul>
          <p style="color:#94a3b8;font-size:0.9em;">Provide either <code>invoice</code> or <code>lightningAddress</code> to receive your ${API_SUBMISSION_REWARD_SATS} sat reward.</p>
          <pre><code>{
  "url": "https://api.example.com/v1/endpoint",
  "invoice": "lnbc100n1...",
  "description": "Optional human-readable description"
}

// Or with a Lightning address:
{
  "url": "https://api.example.com/v1/endpoint",
  "lightningAddress": "you@wallet.com"
}</code></pre>
        </article>

        <article class="panel">
          <h2>Example cURL</h2>
          <pre><code># With BOLT11 invoice (default):
curl -X POST "${SITE_HOST}/api/api-submissions" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://api.example.com/v1/endpoint",
    "invoice": "lnbc100n1..."
  }'

# With Lightning address (fallback):
curl -X POST "${SITE_HOST}/api/api-submissions" \\
  -H "Content-Type: application/json" \\
  -d '{
    "url": "https://api.example.com/v1/endpoint",
    "lightningAddress": "you@wallet.com"
  }'</code></pre>
          <p class="status">${rewardCopy}</p>
        </article>
      </section>

      <div class="actions">
        <a class="btn btn-primary" href="/#submit">Use the web submit flow</a>
        <a class="btn btn-secondary" href="/api/apis">View API directory endpoint</a>
      </div>
    </main>
  </body>
</html>`);
});

/* Submit API Endpoint (site pays user sats) */
app.post("/api/api-submissions", async (req, res) => {
  const { url, invoice, lightningAddress, description: userDesc } = req.body || {};
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

  // If L402 enabled, pay the submitter via BOLT11 invoice (default) or Lightning address (fallback)
  if (l402Enabled) {
    const hasInvoice = invoice && invoice.trim();
    const hasLightningAddress = lightningAddress && lightningAddress.includes("@");

    if (!hasInvoice && !hasLightningAddress) {
      return res.status(400).json({
        error: `Provide a BOLT11 invoice for ${API_SUBMISSION_REWARD_SATS} sats, or a Lightning address (e.g. user@wallet.com) to receive your reward.`,
      });
    }

    if (hasInvoice) {
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

      try {
        await payInvoice(invoice.trim());
      } catch (err) {
        console.error("Payment to submitter failed:", err.message);
        return res.status(502).json({
          error: "Payment failed. Please check your invoice and try again. " + err.message,
        });
      }
    } else {
      // Lightning address fallback for callers without a wallet
      try {
        await payToLightningAddress(lightningAddress, API_SUBMISSION_REWARD_SATS);
        console.log(`Paid ${API_SUBMISSION_REWARD_SATS} sats to ${lightningAddress} for API submission`);
      } catch (err) {
        console.error("Lightning address payment failed:", err.message);
        return res.status(502).json({
          error: `Could not pay Lightning address "${lightningAddress}": ${err.message}`,
        });
      }
    }

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
    verificationType: verification.type,
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

/* ── Million Sat Homepage API Routes ── */

/* GET grid state — all pixel blocks (public, free) */
app.get("/api/million/grid", async (_req, res) => {
  const blocks = await readPixelBlocks();
  res.json(blocks);
});

/* GET stats — total pixels, sats, leaderboard (public, free) */
app.get("/api/million/stats", async (_req, res) => {
  const stats = await getPixelStats();
  res.json(stats);
});

/* POST check region availability (free) */
app.post("/api/million/check", async (req, res) => {
  const { x, y, width, height } = req.body || {};
  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(width) || !Number.isInteger(height)) {
    return res.status(400).json({ error: "x, y, width, height must be integers." });
  }
  if (x < 0 || y < 0 || x + width > MILLION_GRID_SIZE || y + height > MILLION_GRID_SIZE) {
    return res.status(400).json({ error: `Coordinates must be within 0–${MILLION_GRID_SIZE - 1}.` });
  }
  if (width < 1 || height < 1) {
    return res.status(400).json({ error: "Width and height must be at least 1." });
  }
  const overlaps = await checkPixelOverlap(x, y, width, height);
  res.json({ available: !overlaps, x, y, width, height, costSats: width * height });
});

/* POST buy pixels (L402-gated, variable amount) */
app.post("/api/million/buy", async (req, res) => {
  if (!l402Enabled) {
    return res.status(503).json({ error: "L402 not configured" });
  }

  const { x, y, width, height, color, imageData, link, title } = req.body || {};

  if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(width) || !Number.isInteger(height)) {
    return res.status(400).json({ error: "x, y, width, height must be integers." });
  }
  if (x < 0 || y < 0 || x + width > MILLION_GRID_SIZE || y + height > MILLION_GRID_SIZE) {
    return res.status(400).json({ error: `Coordinates must be within 0–${MILLION_GRID_SIZE - 1}.` });
  }
  const totalPixels = width * height;
  if (totalPixels < MILLION_MIN_PIXELS || totalPixels > MILLION_MAX_PIXELS) {
    return res.status(400).json({ error: `Total pixels must be between ${MILLION_MIN_PIXELS} and ${MILLION_MAX_PIXELS.toLocaleString()}.` });
  }

  if (imageData) {
    if (typeof imageData !== "string" || !imageData.startsWith("data:image/")) {
      return res.status(400).json({ error: "imageData must be a base64 data URL starting with 'data:image/'. Use PNG or JPEG format." });
    }
    const base64Part = imageData.split(",")[1] || "";
    const byteSize = Math.ceil(base64Part.length * 3 / 4);
    if (totalPixels > 4 && byteSize < 1024) {
      return res.status(400).json({ error: `imageData is only ${byteSize} bytes — too small for a ${width}x${height} block. Your image is likely blank or corrupt. Use a source image at 3-5x the block dimensions (e.g. ${width * 4}x${height * 4} pixels) and verify it before submitting.` });
    }
  }

  const amountSats = totalPixels;

  const authHeader = req.headers["authorization"];
  const l402 = parseL402Header(authHeader);

  if (!l402) {
    const overlaps = await checkPixelOverlap(x, y, width, height);
    if (overlaps) {
      return res.status(409).json({ error: "Some of those pixels are already taken. Pick a different region." });
    }

    try {
      const { paymentHash, paymentRequest } = await createLndInvoice(
        amountSats,
        `Million Sat Homepage — ${totalPixels} pixel${totalPixels === 1 ? "" : "s"} at (${x},${y})`
      );
      const macaroon = mintL402Token(paymentHash);

      pendingPixelPurchases.set(paymentHash, {
        x, y, width, height,
        color: color || "#ff9900",
        imageData: imageData || null,
        link: link ? normalizeUrl(link) : link || null,
        title: title || null,
        amountSats,
      });

      startPixelPaymentPolling(paymentHash);

      let qrDataUrl = "";
      try {
        qrDataUrl = await QRCode.toDataURL(paymentRequest.toUpperCase(), {
          width: 260, margin: 2,
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
          totalPixels,
          qrCode: qrDataUrl,
        });
    } catch (error) {
      console.error("Million pixel invoice creation error:", error.message);
      return res.status(500).json({ error: "Failed to create Lightning invoice" });
    }
  }

  try {
    verifyL402Token(l402.macaroon, l402.preimage);
  } catch (error) {
    return res.status(401).json({ error: "Invalid L402 token: " + error.message });
  }

  const paymentHash = Buffer.from(l402.macaroon, "base64").subarray(0, 32).toString("hex");

  let paidAmountSats = amountSats;
  try {
    const invoiceData = await lookupLndInvoice(paymentHash);
    paidAmountSats = parseInt(invoiceData.value || invoiceData.amt_paid_sat || "0", 10);
    if (paidAmountSats <= 0) paidAmountSats = amountSats;
  } catch (err) {
    console.error("Could not look up pixel invoice amount:", err.message);
  }

  // Check if already completed (e.g. by auto-polling on same instance)
  const existingBlocks = await readPixelBlocks();
  const existing = existingBlocks.find(b => b.paymentHash === paymentHash);
  if (existing) {
    pendingPixelPurchases.delete(paymentHash);
    return res.json({ success: true, block: existing, stats: await getPixelStats() });
  }

  // Try in-memory pending data first; fall back to request body (serverless-safe)
  let purchaseData = pendingPixelPurchases.get(paymentHash);
  if (!purchaseData) {
    purchaseData = {
      x, y, width, height,
      color: color || "#ff9900",
      imageData: imageData || null,
      link: link ? normalizeUrl(link) : link || null,
      title: title || null,
      amountSats,
    };
  }
  pendingPixelPurchases.delete(paymentHash);

  const overlaps = await checkPixelOverlap(purchaseData.x, purchaseData.y, purchaseData.width, purchaseData.height);
  if (overlaps) {
    return res.status(409).json({ error: "Those pixels were claimed while you were paying. Please pick a different region." });
  }

  const block = {
    id: crypto.randomUUID(),
    x: purchaseData.x, y: purchaseData.y, width: purchaseData.width, height: purchaseData.height,
    color: purchaseData.color || "#ff9900",
    imageData: purchaseData.imageData || null,
    link: purchaseData.link || null,
    title: (purchaseData.title || "").trim().slice(0, 100) || null,
    paymentHash,
    amountSats: paidAmountSats || purchaseData.amountSats,
    createdAt: new Date().toISOString(),
  };

  await writePixelBlock(block);
  const px = block.width * block.height;
  console.log(`🟧 Million Sat: ${px} pixel${px === 1 ? "" : "s"} at (${block.x},${block.y}) for ${block.amountSats} sats — "${block.title || "Anonymous"}"`);

  res.json({
    success: true,
    block: { id: block.id, x: block.x, y: block.y, width: block.width, height: block.height, color: block.color, title: block.title, link: block.link, amountSats: block.amountSats, createdAt: block.createdAt },
    stats: await getPixelStats(),
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
