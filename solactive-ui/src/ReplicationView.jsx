import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { DEFENSIVE_PUT_ISINS } from "./defensivePut";
import { loadReplicationData } from "./replicationData";
import { metricRows, formatMetricValue, pct, num } from "./replicationMetrics";

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-100">{value}</div>
    </div>
  );
}

function chartDomain(points, keys, { log = false, pad = 0.06 } = {}) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) {
    for (const k of keys) {
      const v = p[k];
      if (v == null || !Number.isFinite(v) || v <= 0) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return ["auto", "auto"];
  if (log) {
    const logLo = Math.log10(lo);
    const logHi = Math.log10(hi);
    const span = Math.max(logHi - logLo, 0.02);
    return [
      10 ** (logLo - pad * span),
      10 ** (logHi + pad * span),
    ];
  }
  const span = Math.max(hi - lo, 1);
  return [lo - pad * span, hi + pad * span];
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  const date = label ? new Date(label).toISOString().slice(0, 10) : row?.date;
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs text-slate-200 shadow-lg">
      <div className="mb-1 font-medium text-slate-100">{date}</div>
      {payload.map((item) => (
        <div key={item.dataKey} style={{ color: item.color }}>
          {item.name}: {Number(item.value).toFixed(2)}
        </div>
      ))}
      {row?.official > 0 && row?.replicated != null && (
        <div className="mt-1 border-t border-slate-800 pt-1 text-slate-400">
          Gap: {num(row.gap, 2)} ({num((row.replicated / row.official - 1) * 100, 1)}%)
        </div>
      )}
    </div>
  );
}

export default function ReplicationView() {
  const [region, setRegion] = useState("eur");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showMethodology, setShowMethodology] = useState(false);
  const [logScale, setLogScale] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    loadReplicationData(region)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => {
        if (!cancelled) {
          setData(null);
          setError(err.message || "Failed to run replication");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [region]);

  const meta = DEFENSIVE_PUT_ISINS.find((x) =>
    region === "eur" ? x.isin === "DE000SL0AS77" : x.isin === "DE000SL0AS51",
  );
  const rows = metricRows(data?.metrics);

  const levelDomain = useMemo(
    () => (data?.points ? chartDomain(data.points, ["replicated", "official"], { log: logScale }) : ["auto", "auto"]),
    [data?.points, logScale],
  );

  const gapPctDomain = useMemo(() => {
    if (!data?.points?.length) return ["auto", "auto"];
    const vals = data.points.map((p) => (p.official > 0 ? (p.replicated / p.official - 1) * 100 : 0));
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.08, 1);
    return [lo - pad, hi + pad];
  }, [data?.points]);

  const formatCell = (row, which) => {
    const v = row[which];
    if (v === "—") return "—";
    if (row.isGap) return num(v, 2);
    if (row.isCorrelation) return num(v, 3);
    if (row.isSharpe || row.metric === "Sharpe") return num(v, 3);
    if (row.replicationOnly && row.metric === "Tracking error (ann.)") return pct(v);
    return formatMetricValue(row.metric, v);
  };

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-white">Defensive Put Replication</h1>
        <p className="mt-1 text-sm text-slate-400">
          Recreated strategy vs official Solactive index from parquet
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
        >
          <option value="eur">Euro — DE000SL0AS77</option>
          <option value="usd">US — DE000SL0AS51</option>
        </select>
        <button
          type="button"
          onClick={() => setShowMethodology((v) => !v)}
          className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800"
        >
          {showMethodology ? "Hide" : "Show"} methodology
        </button>
      </div>

      {showMethodology && (
        <section className="mb-6 rounded-2xl border border-slate-800 bg-slate-900/50 p-5 text-sm text-slate-300">
          <h2 className="mb-2 font-semibold text-white">Methodology</h2>
          <ul className="list-inside list-disc space-y-1">
            <li>Weekly Friday roll of 4-week (28d) European puts at 97% strike; short −¼ notional per tranche.</li>
            <li>Cash leg earns 3-month risk-free; fees per Solactive amendment schedule.</li>
            <li>Friday rolls price new puts at opening settlement; daily marks use close with ask-side BS fallback.</li>
            <li>Option marks: entry IV per tranche with parallel index-vol surface shift.</li>
          </ul>
          <p className="mt-3">
            <a
              href="https://www.solactive.com/downloads/Guideline_SPX_Put_v12.pdf"
              target="_blank"
              rel="noreferrer"
              className="text-indigo-400 hover:underline"
            >
              Solactive US guideline (v1.2)
            </a>
          </p>
          {data?.meta?.caveats?.map((c) => (
            <p key={c} className="mt-2 text-amber-400/90">
              {c}
            </p>
          ))}
        </section>
      )}

      {error && <p className="mb-4 text-sm text-rose-400">{error}</p>}
      {loading && <p className="text-sm text-slate-400">Running replication vs official index…</p>}

      {data && !loading && (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Index ISIN" value={data.meta?.indexIsin || meta?.isin} />
            <Stat
              label="Correlation"
              value={num(data.metrics?.replication?.correlation, 3)}
            />
            <Stat label="Tracking error" value={pct(data.metrics?.replication?.trackingError)} />
            <Stat label="From" value={data.dates[0]} />
          </div>

          <section className="mb-6 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-white">Replicated vs official (base 100)</h2>
              <div className="flex rounded-lg border border-slate-700 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setLogScale(true)}
                  className={`rounded-md px-2.5 py-1 ${logScale ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"}`}
                >
                  Log scale
                </button>
                <button
                  type="button"
                  onClick={() => setLogScale(false)}
                  className={`rounded-md px-2.5 py-1 ${!logScale ? "bg-slate-700 text-white" : "text-slate-400 hover:text-slate-200"}`}
                >
                  Linear
                </button>
              </div>
            </div>
            <div className="h-[380px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.points}>
                  <CartesianGrid stroke="#334155" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    tickFormatter={(ts) => new Date(ts).toISOString().slice(0, 10)}
                    minTickGap={50}
                  />
                  <YAxis
                    scale={logScale ? "log" : "linear"}
                    domain={levelDomain}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    tickFormatter={(v) => Number(v).toFixed(0)}
                    allowDataOverflow
                  />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend />
                  <Line type="monotone" dataKey="replicated" name="Replicated" stroke="#22d3ee" dot={false} strokeWidth={2} isAnimationActive={false} />
                  <Line type="monotone" dataKey="official" name="Official (parquet)" stroke="#818cf8" dot={false} strokeWidth={2} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="mb-6 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
            <h2 className="mb-2 text-lg font-semibold text-white">Level drift (replicated / official − 1)</h2>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={data.points.map((p) => ({
                    ...p,
                    gapPct: p.official > 0 ? (p.replicated / p.official - 1) * 100 : null,
                  }))}
                >
                  <CartesianGrid stroke="#334155" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    tickFormatter={(ts) => new Date(ts).toISOString().slice(0, 10)}
                    minTickGap={50}
                  />
                  <YAxis
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    domain={gapPctDomain}
                    tickFormatter={(v) => `${Number(v).toFixed(0)}%`}
                  />
                  <ReferenceLine y={0} stroke="#64748b" strokeDasharray="4 4" />
                  <Tooltip
                    labelFormatter={(ts) => new Date(ts).toISOString().slice(0, 10)}
                    formatter={(v) => [`${Number(v).toFixed(2)}%`, "Level drift"]}
                    contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8 }}
                  />
                  <Line type="monotone" dataKey="gapPct" name="Level drift" stroke="#f472b6" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="mb-6 rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
            <h2 className="mb-2 text-lg font-semibold text-white">Rolling tracking error & correlation (63d)</h2>
            <div className="h-[200px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.points}>
                  <CartesianGrid stroke="#334155" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tick={{ fill: "#94a3b8", fontSize: 11 }}
                    tickFormatter={(ts) => new Date(ts).toISOString().slice(0, 10)}
                    minTickGap={50}
                  />
                  <YAxis yAxisId="te" tick={{ fill: "#94a3b8", fontSize: 11 }} />
                  <YAxis yAxisId="corr" orientation="right" domain={[-1, 1]} tick={{ fill: "#94a3b8", fontSize: 11 }} />
                  <Tooltip
                    labelFormatter={(ts) => new Date(ts).toISOString().slice(0, 10)}
                    contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8 }}
                  />
                  <Legend />
                  <Line yAxisId="te" type="linear" dataKey="rollingTe" name="Rolling TE (ann.)" stroke="#fb923c" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                  <Line yAxisId="corr" type="linear" dataKey="rollingCorr" name="Rolling corr" stroke="#34d399" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
            <h2 className="mb-3 text-lg font-semibold text-white">Evaluation metrics</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-slate-400">
                    <th className="py-2 pr-4">Metric</th>
                    <th className="py-2 pr-4">Replicated</th>
                    <th className="py-2">Official</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.metric} className="border-b border-slate-800">
                      <td className="py-2 pr-4 text-slate-300">{row.metric}</td>
                      <td className="py-2 pr-4 font-mono text-slate-100">{formatCell(row, "replicated")}</td>
                      <td className="py-2 font-mono text-slate-100">{formatCell(row, "official")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
