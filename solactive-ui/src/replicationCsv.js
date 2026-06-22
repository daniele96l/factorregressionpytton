export function buildReplicationCsv(points, meta = {}) {
  const header = [
    "date",
    "replicated_index",
    "official_index",
    "level_gap",
    "level_drift_pct",
    "rolling_tracking_error_ann",
    "rolling_correlation",
  ];
  const lines = [header.join(",")];
  for (const p of points) {
    const driftPct = p.official > 0 ? ((p.replicated / p.official - 1) * 100).toFixed(6) : "";
    lines.push(
      [
        p.date,
        fmt(p.replicated),
        fmt(p.official),
        fmt(p.gap),
        driftPct,
        fmt(p.rollingTe),
        fmt(p.rollingCorr),
      ].join(","),
    );
  }
  const metaLines = [
    "",
    `# region,${meta.indexIsin ?? ""}`,
    `# name,${csvEscape(meta.name ?? "")}`,
    `# portfolio_start,${meta.portfolioStart ?? ""}`,
    `# effective_start,${meta.effectiveStart ?? ""}`,
    `# inception_cash,${meta.inceptionCash ?? ""}`,
    `# methodology,${csvEscape(meta.methodology ?? "")}`,
    `# generated,${new Date().toISOString().slice(0, 10)}`,
  ];
  return `${lines.join("\n")}\n${metaLines.join("\n")}\n`;
}

function fmt(v) {
  if (v == null || !Number.isFinite(v)) return "";
  return String(v);
}

function csvEscape(s) {
  if (s.includes(",") || s.includes('"')) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function replicationCsvFilename(region, meta = {}) {
  const isin = meta.indexIsin ?? region;
  return `defensive-put-replication-${region}-${isin}.csv`;
}
