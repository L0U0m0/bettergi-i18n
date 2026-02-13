import { writeFile, mkdir } from "fs/promises";
import path from "node:path";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing env: ${name}`);
  }
  return value.trim();
}
async function fetchJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}
function buildLanguageOr(language) {
  const raw = String(language ?? "").trim();
  const lower = raw.toLowerCase();
  const upper = raw.toUpperCase();
  return `(language.ilike.${lower}*,language.eq.${upper})`;
}
const argv = process.argv.slice(2);
function getArg(name, def) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === `--${name}`) {
      const v = argv[i + 1];
      if (v == null || String(v).startsWith("--")) return def;
      return String(v).trim();
    }
    if (a.startsWith(`--${name}=`)) {
      return a.slice(name.length + 3).trim();
    }
  }
  return def;
}
async function fetchRawBatch({ supabaseUrl, supabaseKey, lastId, batchSize }) {
  const url = new URL(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/translation_missing`);
  url.searchParams.set("select", "*");
  url.searchParams.set("order", "id.asc");
  url.searchParams.set("limit", String(batchSize));
  url.searchParams.set("id", `gt.${lastId}`);
  return fetchJson(url.toString(), {
    method: "GET",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Accept: "application/json",
    },
  });
}
async function fetchLanguageBatch({ supabaseUrl, supabaseKey, language, lastId, batchSize }) {
  const url = new URL(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/translation_missing`);
  url.searchParams.set("select", "id,language,key,value");
  url.searchParams.set("order", "id.asc");
  url.searchParams.set("limit", String(batchSize));
  url.searchParams.set("id", `gt.${lastId}`);
  url.searchParams.set("or", buildLanguageOr(language));
  return fetchJson(url.toString(), {
    method: "GET",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Accept: "application/json",
    },
  });
}
async function main() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const mode = String(getArg("mode", "raw")).trim().toLowerCase();
  const batchSize = Number(getArg("batch-size", "1000"));
  const delayMs = Number(process.env.DELAY_MS ?? 0);
  if (!Number.isFinite(batchSize) || batchSize <= 0) throw new Error("batch-size must be a positive number");
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("DELAY_MS must be >= 0");
  const outDir = path.join(process.cwd(), "i18n");
  await mkdir(outDir, { recursive: true });
  if (mode === "raw") {
    let lastId = 0;
    const all = [];
    while (true) {
      const rows = await fetchRawBatch({ supabaseUrl, supabaseKey, lastId, batchSize });
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
      lastId = Math.max(lastId, rows[rows.length - 1]?.id ?? lastId);
      if (delayMs) await sleep(delayMs);
    }
    const outputPath = path.join(outDir, "translation_missing_raw.json");
    await writeFile(outputPath, JSON.stringify(all, null, 2), "utf-8");
    process.stdout.write(`exported raw rows=${all.length} to ${outputPath}\n`);
    return;
  }
  if (mode === "language" || mode === "kv") {
    const language = String(getArg("language", "")).trim();
    if (!language) throw new Error("Missing arg: --language");
    let lastId = 0;
    const map = {};
    let added = 0;
    while (true) {
      const rows = await fetchLanguageBatch({ supabaseUrl, supabaseKey, language, lastId, batchSize });
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const row of rows) {
        const k = String(row?.key ?? "").trim();
        const v = row?.value;
        if (!k) continue;
        if (typeof v === "string") {
          const t = v.trim();
          if (t) {
            map[k] = t;
            added += 1;
          }
        }
      }
      lastId = Math.max(lastId, rows[rows.length - 1]?.id ?? lastId);
      if (delayMs) await sleep(delayMs);
    }
    const outputPath = path.join(outDir, `${language}.json`);
    await writeFile(outputPath, JSON.stringify(map, null, 2), "utf-8");
    process.stdout.write(`exported kv entries=${added} language=${language} to ${outputPath}\n`);
    return;
  }
  throw new Error(`Unknown mode: ${mode}`);
}
main().catch((e) => {
  process.stderr.write(`${e?.stack ?? String(e)}\n`);
  process.exitCode = 1;
});
