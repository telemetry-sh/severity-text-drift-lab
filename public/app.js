const number = new Intl.NumberFormat("en-US");

const elements = {
  controls: document.querySelector("#controls"),
  totalLogs: document.querySelector("#totalLogs"),
  errorRate: document.querySelector("#errorRate"),
  canonical: document.querySelector("#canonical"),
  totalLogsOutput: document.querySelector("#totalLogsOutput"),
  errorRateOutput: document.querySelector("#errorRateOutput"),
  canonicalOutput: document.querySelector("#canonicalOutput"),
  heroVisible: document.querySelector("#hero-visible"),
  heroTotal: document.querySelector("#hero-total"),
  heroHidden: document.querySelector("#hero-hidden"),
  heroMeter: document.querySelector("#hero-meter"),
  textVisible: document.querySelector("#text-visible"),
  textCoverage: document.querySelector("#text-coverage"),
  textHidden: document.querySelector("#text-hidden"),
  numberVisible: document.querySelector("#number-visible"),
  variantRows: document.querySelector("#variantRows"),
  severeCount: document.querySelector("#severe-count"),
  metricHidden: document.querySelector("#metric-hidden"),
  runtimeProof: document.querySelector("#runtime-proof"),
};

function percent(basisPoints) {
  return `${(basisPoints / 100).toFixed(1)}%`;
}

function controlsToQuery() {
  const query = new URLSearchParams({
    totalLogs: elements.totalLogs.value,
    errorRateBasisPoints: elements.errorRate.value,
    canonicalTextBasisPoints: elements.canonical.value,
  });
  return query.toString();
}

function updateControlLabels() {
  elements.totalLogsOutput.value = number.format(
    Number(elements.totalLogs.value),
  );
  elements.errorRateOutput.value = percent(Number(elements.errorRate.value));
  elements.canonicalOutput.value = `${(
    Number(elements.canonical.value) / 100
  ).toFixed(0)}%`;
}

function renderVariants(variants) {
  elements.variantRows.replaceChildren(
    ...variants.map((variant) => {
      const row = document.createElement("div");
      row.className = "ledger-row";
      row.setAttribute("role", "row");

      const text = document.createElement("span");
      text.className = "variant-text";
      text.textContent = variant.severity_text ?? "∅ text";
      text.setAttribute("role", "cell");

      const severity = document.createElement("span");
      severity.className = "variant-number";
      severity.textContent = String(variant.severity_number);
      severity.setAttribute("role", "cell");

      const count = document.createElement("span");
      count.className = "variant-count";
      count.textContent = number.format(variant.count);
      count.setAttribute("role", "cell");

      const result = document.createElement("span");
      result.className = `query-result ${
        variant.canonical ? "matched" : "missed"
      }`;
      result.textContent = variant.canonical ? "matched" : "missed";
      result.setAttribute("role", "cell");

      row.append(text, severity, count, result);
      return row;
    }),
  );
}

function render(model) {
  const summary = model.summary;
  elements.heroVisible.textContent = number.format(summary.text_filter_visible);
  elements.heroTotal.textContent = number.format(model.population.error_logs);
  elements.heroHidden.textContent = number.format(summary.text_filter_hidden);
  elements.heroMeter.style.width = `${Math.min(
    100,
    summary.text_filter_coverage_basis_points / 100,
  )}%`;

  elements.textVisible.textContent = number.format(
    summary.text_filter_visible,
  );
  elements.textCoverage.textContent = percent(
    summary.text_filter_coverage_basis_points,
  );
  elements.textHidden.textContent = number.format(summary.text_filter_hidden);
  elements.numberVisible.textContent = number.format(
    summary.numeric_filter_visible,
  );
  elements.metricHidden.textContent = number.format(summary.text_filter_hidden);

  const severe = model.variants.find(
    (variant) => variant.severity_text === "SEVERE",
  );
  elements.severeCount.textContent = number.format(severe?.count ?? 0);
  renderVariants(model.variants);

  elements.runtimeProof.textContent = `${model.runtime.version} · ${
    model.runtime.platform
  } · ${model.runtime.modelPath} · sha256 ${model.runtime.modelSha256.slice(
    0,
    16,
  )}…`;
}

let requestNumber = 0;
let debounce;

async function refresh() {
  const current = ++requestNumber;
  const response = await fetch(`/api/simulate?${controlsToQuery()}`);
  if (!response.ok) throw new Error(`simulation failed: ${response.status}`);
  const model = await response.json();
  if (current === requestNumber) render(model);
}

function scheduleRefresh() {
  updateControlLabels();
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    refresh().catch((error) => {
      elements.runtimeProof.textContent = error.message;
    });
  }, 90);
}

elements.controls.addEventListener("input", scheduleRefresh);
updateControlLabels();
refresh().catch((error) => {
  elements.runtimeProof.textContent = error.message;
});
