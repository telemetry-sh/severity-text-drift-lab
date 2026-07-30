# Severity Text Drift Lab

[![CI](https://github.com/telemetry-sh/severity-text-drift-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/telemetry-sh/severity-text-drift-lab/actions/workflows/ci.yml)

An interactive OpenTelemetry lab about a query that looks sensible and lies by
omission:

```text
severity_text == "ERROR"
```

`SeverityText` is the original string emitted by a source. Java may say
`SEVERE`, another logger may say `ERR`, and a record may omit the text entirely.
Those records can still carry the same normalized OpenTelemetry
`SeverityNumber`. Comparing the number finds the semantic severity across
sources:

```text
severity_number >= 17
```

The default experiment produces 100,000 logs and 1,200 actual errors. Only 420
use the exact text `ERROR`, so the text-only filter reports 35% coverage and
hides 780 valid errors. The normalized-number filter finds all 1,200.

## What makes this a telemetry.sh lab

The interface makes the observability failure visible, while the API exposes
the same evidence in OTLP-shaped logs, metrics, and traces:

- Logs preserve representative `SeverityText` values alongside normalized
  `SeverityNumber`, plus a population weight for each source label.
- Metrics compare visible errors, hidden errors, and coverage by query strategy.
- Traces record the text-only and number-aware evaluations as sibling spans.
- Every response includes proof that the model was evaluated by Vim, including
  the runtime version and SHA-256 of the Vim Script source.

Try the JSON directly:

```sh
curl 'http://localhost:8080/api/simulate'
curl 'http://localhost:8080/api/telemetry'
curl 'http://localhost:8080/healthz'
```

## Run it

Requirements:

- Node.js 24+
- Vim 8.2+

```sh
npm ci
npm start
```

Open <http://localhost:8080>.

Or use Docker:

```sh
docker compose up --build
```

## The executable model

[`model/main.vim`](model/main.vim) is the source of truth. The Node service
passes three integer inputs through environment variables and invokes Vim in
headless Ex mode:

```sh
LAB_TOTAL_LOGS=100000 \
LAB_ERROR_RATE_BASIS_POINTS=120 \
LAB_CANONICAL_TEXT_BASIS_POINTS=3500 \
vim -Nu NONE -n -es -S model/main.vim
```

The model computes:

1. Actual erroneous records from the total population and error rate.
2. The portion whose source text is exactly `ERROR`.
3. A deterministic split of the remaining errors across `ERR`, `SEVERE`,
   `FATAL`, and missing text.
4. Coverage for an exact-text filter and a normalized-number filter.

The split preserves integer totals at every input size. There is no random
fixture hiding inside the UI.

## API inputs

`GET /api/simulate` and `GET /api/telemetry` accept:

| Query parameter | Range | Default | Meaning |
| --- | ---: | ---: | --- |
| `totalLogs` | 100–10,000,000 | 100,000 | Records in the population |
| `errorRateBasisPoints` | 0–10,000 | 120 | Error share; 120 bps = 1.20% |
| `canonicalTextBasisPoints` | 0–10,000 | 3,500 | Errors whose text is exactly `ERROR` |

Example:

```sh
curl 'http://localhost:8080/api/simulate?totalLogs=200000&errorRateBasisPoints=250&canonicalTextBasisPoints=4000'
```

## Why the number is the comparison field

The OpenTelemetry Logs Data Model defines `SeverityText` as the original string
representation of severity and `SeverityNumber` as its normalized integer
representation. It assigns ERROR to 17–20 and FATAL to 21–24, and explicitly
recommends using `SeverityNumber` for comparisons. See:

- [OpenTelemetry Logs Data Model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
- [Mapping source severity to OpenTelemetry](https://opentelemetry.io/docs/specs/otel/logs/data-model-appendix/)
- [OpenTelemetry exception log conventions](https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-logs/)

The lesson is not to discard the text. Preserve and display it. Use the
normalized number for alerts, ranges, and cross-source analysis.

## Verify it

```sh
npm run check
```

The test suite runs the real Vim Script model, checks boundary behavior and
population conservation, validates representative OTLP records, and exercises
all HTTP endpoints. CI repeats those checks and builds the container image.

## License

MIT
