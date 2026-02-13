import { readFile } from "fs/promises";
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
async function fetchRowsByKey({ supabaseUrl, supabaseKey, key }) {
  const url = new URL(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/translation_missing`);
  url.searchParams.set("select", "id,language,key,value");
  url.searchParams.set("key", `eq.${key}`);
  url.searchParams.set("or", "(language.ilike.en*,language.eq.EN)");
  return fetchJson(url.toString(), {
    method: "GET",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Accept: "application/json",
    },
  });
}
async function patchById({ supabaseUrl, supabaseKey, id, value }) {
  const url = new URL(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/translation_missing`);
  url.searchParams.set("id", `eq.${id}`);
  const res = await fetch(url.toString(), {
    method: "PATCH",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const bodyText = await res.text();
    throw new Error(`Supabase PATCH failed: ${res.status} ${res.statusText} ${bodyText}`);
  }
}
async function main() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const jsonPath = process.env.JSON_PATH?.trim() || "d:\\HuiPrograming\\Projects\\CSharp\\MiHoYo\\bettergi-i18n\\i18n\\en.json";
  const batchSize = Number(process.env.BATCH_SIZE ?? 20);
  const delayMs = Number(process.env.DELAY_MS ?? 100);
  const dryRun = String(process.env.DRY_RUN ?? "").toLowerCase() === "true";
  if (!Number.isFinite(batchSize) || batchSize <= 0) throw new Error("BATCH_SIZE must be a positive number");
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("DELAY_MS must be >= 0");
  const text = await readFile(jsonPath, "utf-8");
  const obj = JSON.parse(text);
  const entries = Object.entries(obj).filter(([k, v]) => typeof v === "string" && v.trim().length > 0);
  let processed = 0;
  let found = 0;
  let updated = 0;
  let skipped = 0;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const tasks = batch.map(async ([key, value]) => {
      processed += 1;
      const rows = await fetchRowsByKey({ supabaseUrl, supabaseKey, key });
      if (!Array.isArray(rows) || rows.length === 0) {
        skipped += 1;
        return;
      }
      found += rows.length;
      for (const row of rows) {
        if (!dryRun) {
          await patchById({ supabaseUrl, supabaseKey, id: row.id, value });
        }
        updated += 1;
        process.stdout.write(`[${updated}] id=${row.id} lang=${row.language} key=${JSON.stringify(key)} value=${JSON.stringify(value)} updated${dryRun ? " (dry-run)" : ""}\n`);
        if (delayMs) await sleep(delayMs);
      }
    });
    for (const t of tasks) await t;
  }
  process.stdout.write(`done processed=${processed} found=${found} updated=${updated} skipped=${skipped}${dryRun ? " (dry-run)" : ""}\n`);
}
main().catch((e) => {
  process.stderr.write(`${e?.stack ?? String(e)}\n`);
  process.exitCode = 1;
});
