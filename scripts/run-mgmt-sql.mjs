#!/usr/bin/env node
/**
 * Run SQL against a Supabase project using a Personal Access Token (sbp_...).
 * Usage: SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/run-mgmt-sql.mjs
 * Loads SUPABASE_URL from .env.local (cwd) to derive project ref.
 */
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(process.cwd(), ".env.local") });
dotenv.config();

function projectRefFromUrl(url) {
  const m = (url || "").match(/https:\/\/([^.]+)\.supabase\.co/);
  return m?.[1] || "";
}

const token = process.env.SUPABASE_ACCESS_TOKEN || "";
const ref =
  process.env.SUPABASE_PROJECT_REF ||
  projectRefFromUrl(process.env.SUPABASE_URL || "");

const sqlPath = process.argv[2] || resolve(__dirname, "sql", "apply-rate-events.sql");
const query = readFileSync(sqlPath, "utf8");

if (!token || !ref) {
  console.error("Missing SUPABASE_ACCESS_TOKEN or project ref (SUPABASE_PROJECT_REF or SUPABASE_URL).");
  process.exit(1);
}

const url = `https://api.supabase.com/v1/projects/${ref}/database/query`;
const res = await fetch(url, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query }),
});

const text = await res.text();
if (!res.ok) {
  console.error(res.status, text);
  process.exit(1);
}
console.log(res.status, text || "(empty body)");
