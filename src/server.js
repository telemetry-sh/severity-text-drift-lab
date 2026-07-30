import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_PATH = join(ROOT, "model", "main.vim");
const PUBLIC_PATH = join(ROOT, "public");
const FIXED_TIME_UNIX_NANO = "1785283200000000000";
const DEFAULTS = Object.freeze({
  totalLogs: 100_000,
  errorRateBasisPoints: 120,
  canonicalTextBasisPoints: 3_500,
});

let runtimeCache;

function finiteInteger(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function normalizeInputs(raw = {}) {
  return {
    totalLogs: finiteInteger(
      raw.totalLogs ?? raw.total_logs,
      DEFAULTS.totalLogs,
    ),
    errorRateBasisPoints: finiteInteger(
      raw.errorRateBasisPoints ?? raw.error_rate_basis_points,
      DEFAULTS.errorRateBasisPoints,
    ),
    canonicalTextBasisPoints: finiteInteger(
      raw.canonicalTextBasisPoints ?? raw.canonical_text_basis_points,
      DEFAULTS.canonicalTextBasisPoints,
    ),
  };
}

function vimBinary() {
  return process.env.VIM_BIN || "vim";
}

function runtimeProof(binary) {
  if (runtimeCache?.binary === binary) return runtimeCache.value;

  const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
  if (version.status !== 0) {
    throw new Error(
      `Vim runtime not found. ${version.stderr || "Install Vim 8.2 or newer."}`,
    );
  }

  const value = {
    engine: "Vim Script",
    version: version.stdout.trim().split("\n")[0],
    platform: `${process.platform}/${process.arch}`,
    modelPath: "model/main.vim",
    modelSha256: createHash("sha256")
      .update(readFileSync(MODEL_PATH))
      .digest("hex"),
  };
  runtimeCache = { binary, value };
  return value;
}

export function runModel(raw = {}) {
  const input = normalizeInputs(raw);
  const binary = vimBinary();
  const result = spawnSync(
    binary,
    ["-Nu", "NONE", "-n", "-es", "-S", MODEL_PATH],
    {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        LAB_TOTAL_LOGS: String(input.totalLogs),
        LAB_ERROR_RATE_BASIS_POINTS: String(input.errorRateBasisPoints),
        LAB_CANONICAL_TEXT_BASIS_POINTS: String(
          input.canonicalTextBasisPoints,
        ),
      },
    },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || "Vim Script model evaluation failed.");
  }

  const model = JSON.parse(result.stdout);
  model.runtime = runtimeProof(binary);
  return model;
}

function attribute(key, value) {
  let wrapped;
  if (typeof value === "boolean") wrapped = { boolValue: value };
  else if (typeof value === "number" && Number.isInteger(value)) {
    wrapped = { intValue: String(value) };
  } else if (typeof value === "number") wrapped = { doubleValue: value };
  else wrapped = { stringValue: String(value) };
  return { key, value: wrapped };
}

function resourceAttributes(model) {
  return [
    attribute("service.name", "checkout-log-normalizer"),
    attribute("service.version", "2026.7.0"),
    attribute("deployment.environment.name", "lab"),
    attribute("telemetry.sdk.language", "vimscript"),
    attribute("lab.name", model.meta.lab),
  ];
}

function point(value, attrs = [], asDouble = false) {
  return {
    attributes: attrs,
    timeUnixNano: FIXED_TIME_UNIX_NANO,
    ...(asDouble
      ? { asDouble: value }
      : { asInt: String(value) }),
  };
}

function sumMetric(name, description, points) {
  return {
    name,
    description,
    unit: "{log}",
    sum: {
      aggregationTemporality: 2,
      isMonotonic: true,
      dataPoints: points,
    },
  };
}

function metricPayload(model) {
  const textStrategy = [attribute("lab.filter.strategy", "text-only")];
  const numericStrategy = [attribute("lab.filter.strategy", "number-aware")];
  const metrics = [
    sumMetric(
      "lab.log.records.total",
      "Log records evaluated by the lab.",
      [point(model.population.total_logs)],
    ),
    sumMetric(
      "lab.log.errors.actual",
      "Log records with normalized severity number ERROR or higher.",
      [point(model.population.error_logs)],
    ),
    sumMetric(
      "lab.log.errors.visible",
      "Erroneous records visible to each query strategy.",
      [
        point(model.summary.text_filter_visible, textStrategy),
        point(model.summary.numeric_filter_visible, numericStrategy),
      ],
    ),
    sumMetric(
      "lab.log.errors.hidden",
      "Erroneous records missed by each query strategy.",
      [
        point(model.summary.text_filter_hidden, textStrategy),
        point(0, numericStrategy),
      ],
    ),
    {
      name: "lab.log.error_coverage",
      description: "Visible erroneous records divided by actual erroneous records.",
      unit: "1",
      gauge: {
        dataPoints: [
          point(
            model.summary.text_filter_coverage_basis_points / 10_000,
            textStrategy,
            true,
          ),
          point(1, numericStrategy, true),
        ],
      },
    },
  ];

  return {
    resourceMetrics: [
      {
        resource: { attributes: resourceAttributes(model) },
        scopeMetrics: [
          {
            scope: {
              name: "telemetry.sh/severity-text-drift-lab",
              version: "1.0.0",
            },
            metrics,
          },
        ],
      },
    ],
  };
}

function logRecord(variant, index) {
  const text = variant.severity_text;
  const record = {
    timeUnixNano: String(BigInt(FIXED_TIME_UNIX_NANO) + BigInt(index)),
    observedTimeUnixNano: String(
      BigInt(FIXED_TIME_UNIX_NANO) + BigInt(index + 100),
    ),
    severityNumber: variant.severity_number,
    body: {
      stringValue:
        text === null
          ? "checkout failed without a source severity label"
          : `checkout failed with source label ${text}`,
    },
    attributes: [
      attribute("event.name", "checkout.failed"),
      attribute("lab.population.count", variant.count),
      attribute("lab.text_filter.match", variant.canonical),
      attribute("error.type", "PaymentDeclined"),
    ],
    traceId: "d4cda95b652f4a1592b449d5929fda1b",
    spanId: "6e0c63257de34c92",
  };
  if (text !== null) record.severityText = text;
  return record;
}

function logPayload(model) {
  return {
    resourceLogs: [
      {
        resource: { attributes: resourceAttributes(model) },
        scopeLogs: [
          {
            scope: {
              name: "telemetry.sh/source-log-bridge",
              version: "1.0.0",
            },
            logRecords: model.variants.map(logRecord),
          },
        ],
      },
    ],
  };
}

function analysisSpan(model, strategy, index) {
  const data = model.strategies[index];
  return {
    traceId: "d4cda95b652f4a1592b449d5929fda1b",
    spanId: index === 0 ? "021a61526cc26f3d" : "3fc69f235a8e74f1",
    parentSpanId: "6e0c63257de34c92",
    name: "evaluate severity filter",
    kind: 1,
    startTimeUnixNano: String(
      BigInt(FIXED_TIME_UNIX_NANO) - BigInt(2_000_000 + index * 1_000_000),
    ),
    endTimeUnixNano: String(
      BigInt(FIXED_TIME_UNIX_NANO) - BigInt(index * 1_000_000),
    ),
    attributes: [
      attribute("lab.filter.strategy", strategy),
      attribute("lab.filter.predicate", data.predicate),
      attribute("lab.errors.visible", data.visible_errors),
      attribute("lab.errors.hidden", data.hidden_errors),
      attribute("lab.error_coverage", data.coverage_basis_points / 10_000),
    ],
    status: {
      code: data.hidden_errors > 0 ? 2 : 1,
      message: data.hidden_errors > 0 ? "erroneous logs hidden" : "",
    },
  };
}

function tracePayload(model) {
  return {
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes(model) },
        scopeSpans: [
          {
            scope: {
              name: "telemetry.sh/severity-query-comparison",
              version: "1.0.0",
            },
            spans: [
              analysisSpan(model, "text-only", 0),
              analysisSpan(model, "number-aware", 1),
            ],
          },
        ],
      },
    ],
  };
}

export function buildTelemetry(model) {
  return {
    model,
    logs: logPayload(model),
    metrics: metricPayload(model),
    traces: tracePayload(model),
  };
}

function contentType(path) {
  return (
    {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".svg": "image/svg+xml",
    }[extname(path)] || "application/octet-stream"
  );
}

function writeJson(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

function queryInputs(url) {
  return {
    totalLogs: url.searchParams.get("totalLogs"),
    errorRateBasisPoints: url.searchParams.get("errorRateBasisPoints"),
    canonicalTextBasisPoints: url.searchParams.get(
      "canonicalTextBasisPoints",
    ),
  };
}

function staticPath(pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = resolve(PUBLIC_PATH, requested);
  return candidate.startsWith(`${PUBLIC_PATH}/`) ? candidate : null;
}

export function createLabServer() {
  return createServer((request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");

      if (request.method === "GET" && url.pathname === "/healthz") {
        return writeJson(response, 200, {
          ok: true,
          engine: runtimeProof(vimBinary()),
        });
      }

      if (
        request.method === "GET" &&
        (url.pathname === "/api/simulate" ||
          url.pathname === "/api/telemetry")
      ) {
        const model = runModel(queryInputs(url));
        const payload =
          url.pathname === "/api/telemetry" ? buildTelemetry(model) : model;
        return writeJson(response, 200, payload);
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return writeJson(response, 405, { error: "method not allowed" });
      }

      const path = staticPath(url.pathname);
      if (!path) return writeJson(response, 404, { error: "not found" });

      try {
        if (!statSync(path).isFile()) throw new Error("not a file");
      } catch {
        return writeJson(response, 404, { error: "not found" });
      }

      response.writeHead(200, {
        "content-type": contentType(path),
        "cache-control": "no-cache",
      });
      response.end(request.method === "HEAD" ? undefined : readFileSync(path));
    } catch (error) {
      writeJson(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

const isEntrypoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isEntrypoint) {
  const port = finiteInteger(process.env.PORT, 8080);
  const host = process.env.HOST || "0.0.0.0";
  const server = createLabServer();
  server.listen(port, host, () => {
    process.stdout.write(
      `severity-text-drift-lab listening on http://${host}:${port}\n`,
    );
  });
}
