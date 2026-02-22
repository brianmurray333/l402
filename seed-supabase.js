#!/usr/bin/env node
/**
 * Seed Supabase tables from existing JSON data files.
 * Run once: node seed-supabase.js
 */
require("dotenv").config({ path: ".env.local" });
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const urlToId = (url) => crypto.createHash("md5").update(url).digest("hex").slice(0, 12);

async function seedApps() {
  const apps = JSON.parse(fs.readFileSync(path.join(__dirname, "data/apps.json"), "utf-8"));
  const rows = apps.map((a, i) => ({
    id: a.id || urlToId(a.url),
    name: a.name,
    url: a.url,
    description: a.description || null,
    image: a.image || null,
    icon: a.icon || null,
    sort_order: i,
  }));

  const { error } = await supabase.from("apps").upsert(rows, { onConflict: "id" });
  if (error) {
    console.error("❌ Apps seed error:", error.message);
  } else {
    console.log(`✅ Seeded ${rows.length} apps`);
  }
}

async function seedApis() {
  const apis = JSON.parse(fs.readFileSync(path.join(__dirname, "data/apis.json"), "utf-8"));
  const rows = apis.map((a) => ({
    id: a.id,
    provider: a.provider || null,
    name: a.name,
    method: a.method || "GET",
    endpoint: a.endpoint,
    docs_url: a.docsUrl || null,
    description: a.description || null,
    cost: a.cost || null,
    cost_type: a.costType || "variable",
    direction: a.direction || "charges",
    icon: a.icon || null,
    verified: a.verified || false,
    verified_at: a.verifiedAt || null,
    featured: a.featured || false,
  }));

  const { error } = await supabase.from("apis").upsert(rows, { onConflict: "id" });
  if (error) {
    console.error("❌ APIs seed error:", error.message);
  } else {
    console.log(`✅ Seeded ${rows.length} APIs`);
  }
}

async function seedBoosts() {
  const boostsPath = path.join(__dirname, "data/boosts.json");
  if (!fs.existsSync(boostsPath)) {
    console.log("⏭️  No boosts.json to seed");
    return;
  }
  const boosts = JSON.parse(fs.readFileSync(boostsPath, "utf-8"));
  if (boosts.length === 0) {
    console.log("⏭️  No boosts to seed");
    return;
  }
  const rows = boosts.map((b) => ({
    id: b.id,
    item_id: b.itemId,
    item_type: b.itemType,
    amount_sats: b.amountSats,
    payment_hash: b.paymentHash || null,
    created_at: b.createdAt || b.boostedAt,
    expires_at: b.expiresAt,
  }));

  const { error } = await supabase.from("boosts").upsert(rows, { onConflict: "id" });
  if (error) {
    console.error("❌ Boosts seed error:", error.message);
  } else {
    console.log(`✅ Seeded ${rows.length} boosts`);
  }
}

async function seedSubmissions() {
  const subsPath = path.join(__dirname, "data/submissions.json");
  if (!fs.existsSync(subsPath)) {
    console.log("⏭️  No submissions.json to seed");
    return;
  }
  const subs = JSON.parse(fs.readFileSync(subsPath, "utf-8"));
  if (subs.length === 0) {
    console.log("⏭️  No submissions to seed");
    return;
  }
  const rows = subs.map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url,
    description: s.description || null,
    image: s.image || null,
    icon: s.icon || null,
    status: s.status || "pending",
    payment_hash: s.paymentHash || null,
    submitted_at: s.submittedAt,
  }));

  const { error } = await supabase.from("app_submissions").upsert(rows, { onConflict: "id" });
  if (error) {
    console.error("❌ Submissions seed error:", error.message);
  } else {
    console.log(`✅ Seeded ${rows.length} app submissions`);
  }
}

async function seedApiSubmissions() {
  const subsPath = path.join(__dirname, "data/api-submissions.json");
  if (!fs.existsSync(subsPath)) {
    console.log("⏭️  No api-submissions.json to seed");
    return;
  }
  const subs = JSON.parse(fs.readFileSync(subsPath, "utf-8"));
  if (subs.length === 0) {
    console.log("⏭️  No API submissions to seed");
    return;
  }
  const rows = subs.map((s) => ({
    id: s.id,
    provider: s.provider || null,
    name: s.name,
    method: s.method || "GET",
    endpoint: s.endpoint,
    description: s.description || null,
    cost: s.cost || null,
    cost_type: s.costType || "variable",
    direction: s.direction || "charges",
    icon: s.icon || null,
    verified: s.verified || false,
    verified_at: s.verifiedAt || null,
    reward_invoice: s.rewardInvoice || null,
    reward_paid: s.rewardPaid || false,
    payment_hash: s.paymentHash || null,
    submitted_at: s.submittedAt,
  }));

  const { error } = await supabase.from("api_submissions").upsert(rows, { onConflict: "id" });
  if (error) {
    console.error("❌ API submissions seed error:", error.message);
  } else {
    console.log(`✅ Seeded ${rows.length} API submissions`);
  }
}

async function main() {
  console.log("🌱 Seeding Supabase from JSON files...\n");
  await seedApps();
  await seedApis();
  await seedBoosts();
  await seedSubmissions();
  await seedApiSubmissions();
  console.log("\n🎉 Done!");
}

main().catch(console.error);
