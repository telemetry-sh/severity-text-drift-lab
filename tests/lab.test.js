import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

import {
  buildTelemetry,
  createLabServer,
  runModel,
} from "../src/server.js";

test("the executable Vim Script model reproduces the default blind spot", () => {
  const model = runModel();

  assert.equal(model.meta.engine, "vimscript");
  assert.equal(model.population.total_logs, 100_000);
  assert.equal(model.population.error_logs, 1_200);
  assert.equal(model.summary.text_filter_visible, 420);
  assert.equal(model.summary.text_filter_hidden, 780);
  assert.equal(model.summary.text_filter_coverage_basis_points, 3_500);
  assert.equal(model.summary.numeric_filter_visible, 1_200);
  assert.match(model.runtime.version, /^VIM - Vi IMproved/);
  assert.match(model.runtime.modelSha256, /^[a-f0-9]{64}$/);
});

test("the five severity populations preserve the exact error total", () => {
  const model = runModel();
  const counts = Object.fromEntries(
    model.variants.map((variant) => [
      variant.severity_text ?? "(missing)",
      variant.count,
    ]),
  );

  assert.deepEqual(counts, {
    ERROR: 420,
    ERR: 300,
    SEVERE: 240,
    FATAL: 120,
    "(missing)": 120,
  });
  assert.equal(
    model.variants.reduce((sum, variant) => sum + variant.count, 0),
    model.population.error_logs,
  );
});

test("an all-canonical source closes the text-filter gap", () => {
  const model = runModel({ canonicalTextBasisPoints: 10_000 });

  assert.equal(model.summary.text_filter_visible, 1_200);
  assert.equal(model.summary.text_filter_hidden, 0);
  assert.equal(model.summary.text_filter_coverage_basis_points, 10_000);
  assert.equal(
    model.variants
      .filter((variant) => !variant.canonical)
      .reduce((sum, variant) => sum + variant.count, 0),
    0,
  );
});

test("a source with no canonical ERROR text defeats the exact filter", () => {
  const model = runModel({ canonicalTextBasisPoints: 0 });

  assert.equal(model.summary.text_filter_visible, 0);
  assert.equal(model.summary.text_filter_hidden, 1_200);
  assert.equal(model.summary.text_filter_coverage_basis_points, 0);
  assert.equal(model.summary.numeric_filter_coverage_basis_points, 10_000);
});

test("the model clamps unsafe inputs before calculating populations", () => {
  const model = runModel({
    totalLogs: 1,
    errorRateBasisPoints: 20_000,
    canonicalTextBasisPoints: -100,
  });

  assert.deepEqual(model.inputs, {
    total_logs: 100,
    error_rate_basis_points: 10_000,
    canonical_text_basis_points: 0,
  });
  assert.equal(model.population.error_logs, 100);
  assert.equal(model.summary.text_filter_hidden, 100);
});

test("OTLP-shaped logs preserve text while exposing normalized severity", () => {
  const telemetry = buildTelemetry(runModel());
  const records =
    telemetry.logs.resourceLogs[0].scopeLogs[0].logRecords;

  assert.equal(records.length, 5);
  assert.deepEqual(
    records.map((record) => record.severityText ?? null),
    ["ERROR", "ERR", "SEVERE", "FATAL", null],
  );
  assert.deepEqual(
    records.map((record) => record.severityNumber),
    [17, 17, 17, 21, 17],
  );

  const weights = records.map((record) =>
    Number(
      record.attributes.find(
        (entry) => entry.key === "lab.population.count",
      ).value.intValue,
    ),
  );
  assert.deepEqual(weights, [420, 300, 240, 120, 120]);
});

test("metrics and traces compare both query strategies", () => {
  const telemetry = buildTelemetry(runModel());
  const metrics =
    telemetry.metrics.resourceMetrics[0].scopeMetrics[0].metrics;
  const coverage = metrics.find(
    (metric) => metric.name === "lab.log.error_coverage",
  );
  assert.deepEqual(
    coverage.gauge.dataPoints.map((entry) => entry.asDouble),
    [0.35, 1],
  );

  const spans =
    telemetry.traces.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2);
  assert.deepEqual(
    spans.map((span) =>
      span.attributes.find(
        (entry) => entry.key === "lab.filter.strategy",
      ).value.stringValue,
    ),
    ["text-only", "number-aware"],
  );
  assert.deepEqual(
    spans.map((span) => span.status.code),
    [2, 1],
  );
});

test("the HTTP server exposes the UI, model, telemetry, and runtime health", async (t) => {
  const server = createLabServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());

  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${origin}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /One error level/);

  const simulation = await fetch(
    `${origin}/api/simulate?totalLogs=200000&errorRateBasisPoints=250&canonicalTextBasisPoints=4000`,
  );
  assert.equal(simulation.status, 200);
  const model = await simulation.json();
  assert.equal(model.population.error_logs, 5_000);
  assert.equal(model.summary.text_filter_visible, 2_000);

  const telemetry = await fetch(`${origin}/api/telemetry`);
  assert.equal(telemetry.status, 200);
  const payload = await telemetry.json();
  assert.ok(payload.logs.resourceLogs);
  assert.ok(payload.metrics.resourceMetrics);
  assert.ok(payload.traces.resourceSpans);

  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});
