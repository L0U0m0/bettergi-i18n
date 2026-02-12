const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing env: ${name}`);
  }
  return value.trim();
}

function toDeeplLangCode(language) {
  const raw = String(language ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();

  if (lower === "zh-cn" || lower === "zh-hans" || lower.startsWith("zh")) return "ZH";
  if (lower === "en-us" || lower === "en-gb" || lower.startsWith("en")) return "EN";
  if (lower.startsWith("ja")) return "JA";
  if (lower.startsWith("ko")) return "KO";
  if (lower.startsWith("fr")) return "FR";
  if (lower.startsWith("de")) return "DE";
  if (lower.startsWith("es")) return "ES";
  if (lower.startsWith("ru")) return "RU";
  if (lower.startsWith("it")) return "IT";
  if (lower.startsWith("nl")) return "NL";
  if (lower.startsWith("pl")) return "PL";
  if (lower.startsWith("tr")) return "TR";
  if (lower.startsWith("uk")) return "UK";
  if (lower.startsWith("sv")) return "SV";
  if (lower.startsWith("da")) return "DA";
  if (lower.startsWith("fi")) return "FI";
  if (lower.startsWith("cs")) return "CS";
  if (lower.startsWith("el")) return "EL";
  if (lower.startsWith("hu")) return "HU";
  if (lower.startsWith("nb") || lower.startsWith("no")) return "NB";
  if (lower.startsWith("pt-br")) return "PT-BR";
  if (lower.startsWith("pt")) return "PT";

  return raw.toUpperCase();
}

function getSourceText(row, sourceField) {
  if (sourceField === "key") return String(row.key ?? "");
  if (sourceField === "value") return String(row.value ?? "");

  if (sourceField.startsWith("source_info.")) {
    const path = sourceField.slice("source_info.".length).split(".").filter(Boolean);
    let cur = row.source_info;
    for (const part of path) cur = cur?.[part];
    if (typeof cur === "string") return cur;
    return cur == null ? "" : String(cur);
  }

  return String(row.key ?? "");
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

async function fetchMissingBatch({ supabaseUrl, supabaseKey, lastId, batchSize }) {
  const url = new URL(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/translation_missing`);
  url.searchParams.set("select", "id,language,key,value,source,source_info");
  url.searchParams.set("order", "id.asc");
  url.searchParams.set("limit", String(batchSize));
  url.searchParams.set("id", `gt.${lastId}`);
  url.searchParams.set("or", "(value.is.null,value.eq.)");

  return fetchJson(url.toString(), {
    method: "GET",
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
      Accept: "application/json",
    },
  });
}

async function updateValue({ supabaseUrl, supabaseKey, id, value }) {
  const url = new URL(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/translation_missing`);
  url.searchParams.set("id", `eq.${id}`);
  url.searchParams.set("or", "(value.is.null,value.eq.)");

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

async function translateWithRetry({ endpoint, bearerToken, text, sourceLang, targetLang, maxRetries }) {
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
        },
        body: JSON.stringify({
          text,
          source_lang: sourceLang,
          target_lang: targetLang,
        }),
      });

      const json = await res.json().catch(() => null);

      if (!res.ok) {
        const err = new Error(`DeepLX HTTP ${res.status} ${res.statusText}`);
        err.status = res.status;
        err.body = json;
        throw err;
      }

      const translated = json?.data ?? json?.translations?.[0]?.text;
      if (typeof translated !== "string" || !translated.trim()) {
        throw new Error(`DeepLX response missing translated text: ${JSON.stringify(json)}`);
      }
      return translated;
    } catch (e) {
      attempt += 1;
      const status = e?.status;
      const retryable = status === 429 || (typeof status === "number" && status >= 500) || status == null;
      if (!retryable || attempt > maxRetries) throw e;
      const backoffMs = Math.min(30_000, 500 * 2 ** (attempt - 1));
      await sleep(backoffMs);
    }
  }
}

async function main() {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const supabaseKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const deeplxEndpoint = requireEnv("DEEPLX_ENDPOINT");

  const sourceLang = (process.env.SOURCE_LANG ?? "auto").trim();
  const sourceField = (process.env.SOURCE_FIELD ?? "key").trim();
  const batchSize = Number(process.env.BATCH_SIZE ?? 50);
  const delayMs = Number(process.env.DELAY_MS ?? 200);
  const maxRows = Number(process.env.MAX_ROWS ?? Number.POSITIVE_INFINITY);
  const dryRun = String(process.env.DRY_RUN ?? "").toLowerCase() === "true";
  const maxRetries = Number(process.env.MAX_RETRIES ?? 5);
  const deeplxBearerToken = (process.env.DEEPLX_BEARER_TOKEN ?? "").trim() || null;

  if (!Number.isFinite(batchSize) || batchSize <= 0) throw new Error("BATCH_SIZE must be a positive number");
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error("DELAY_MS must be >= 0");
  if (!Number.isFinite(maxRetries) || maxRetries < 0) throw new Error("MAX_RETRIES must be >= 0");

  let lastId = 0;
  let processed = 0;
  let updated = 0;
  let skipped = 0;

  while (processed < maxRows) {
    const rows = await fetchMissingBatch({ supabaseUrl, supabaseKey, lastId, batchSize });
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const row of rows) {
      lastId = Math.max(lastId, row.id ?? lastId);
      if (processed >= maxRows) break;
      processed += 1;

      const targetLang = toDeeplLangCode(row.language);
      if (!targetLang) {
        skipped += 1;
        continue;
      }

      const sourceText = getSourceText(row, sourceField).trim();
      if (!sourceText) {
        skipped += 1;
        continue;
      }

      const translated = await translateWithRetry({
        endpoint: deeplxEndpoint,
        bearerToken: deeplxBearerToken,
        text: sourceText,
        sourceLang,
        targetLang,
        maxRetries,
      });

      if (!dryRun) {
        await updateValue({
          supabaseUrl,
          supabaseKey,
          id: row.id,
          value: translated,
        });
      }

      updated += 1;
      process.stdout.write(
        `[${updated}] id=${row.id} lang=${row.language} target=${targetLang} key=${JSON.stringify(
          row.key ?? ""
        )} value=${JSON.stringify(translated)} updated${dryRun ? " (dry-run)" : ""}\n`
      );

      if (delayMs) await sleep(delayMs);
    }
  }

  process.stdout.write(
    `done processed=${processed} updated=${updated} skipped=${skipped} lastId=${lastId}${dryRun ? " (dry-run)" : ""}\n`
  );
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? String(e)}\n`);
  process.exitCode = 1;
});

