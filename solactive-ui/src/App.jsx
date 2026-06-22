import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { listIsins, loadParquetBuffer, readIsinSeries } from "./parquet";
import {
  DEFENSIVE_PUT_ISINS,
  formatIsinLabel,
  getDefensivePutMeta,
  pickDefaultIsin,
  sortIsinsWithPriority,
} from "./defensivePut";
import ReplicationView from "./ReplicationView";


function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className="mt-1 text-lg font-semibold text-slate-100">{value}</div>
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState("explorer");
  const [file, setFile] = useState(null);
  const [isins, setIsins] = useState([]);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [series, setSeries] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [fileLabel, setFileLabel] = useState("");


  const defensiveInFile = useMemo(
    () => DEFENSIVE_PUT_ISINS.filter((x) => isins.includes(x.isin)),
    [isins]
  );

  const otherIsins = useMemo(() => isins.filter((isin) => !getDefensivePutMeta(isin)), [isins]);

  const selectOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = q ? isins.filter((i) => i.toLowerCase().includes(q) || formatIsinLabel(i).toLowerCase().includes(q)) : isins;
    const base = pool.slice(0, 300);
    if (selected && !base.includes(selected)) return [selected, ...base];
    return base;
  }, [query, isins, selected]);

  const idx = selected ? isins.indexOf(selected) : -1;

  const loadBuffer = useCallback(async (source, label) => {
    setLoading(true);
    setError("");
    setSeries([]);
    try {
      const { file: parquetFile } = await loadParquetBuffer(source);
      const list = sortIsinsWithPriority(await listIsins(parquetFile));
      if (!list.length) throw new Error("No ISIN columns found in parquet.");
      setFile(parquetFile);
      setIsins(list);
      setSelected(pickDefaultIsin(list));
      setQuery("");
      setFileLabel(label);
    } catch (err) {
      setError(err.message || "Failed to load parquet");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBuffer("/solactive.parquet", "solactive.parquet").catch(() => {});
  }, [loadBuffer]);

  useEffect(() => {
    if (!file || !selected) {
      setSeries([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setSeries([]);
    setError("");

    readIsinSeries(file, selected)
      .then((data) => {
        if (cancelled) return;
        if (!data.length) {
          setError(`No valid data points for ${selected}.`);
          setSeries([]);
          return;
        }
        setSeries(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || "Failed to read ISIN");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [file, selected]);

  const go = (delta) => {
    if (!isins.length || idx < 0) return;
    const next = Math.min(Math.max(idx + delta, 0), isins.length - 1);
    setSelected(isins[next]);
    setQuery("");
  };

  const onFile = (f) => {
    if (!f) return;
    loadBuffer(f, f.name);
  };

  const downloadCsv = () => {
    if (!series.length || !selected) return;
    const header = "Date,Level,Index";
    const rows = series.map((p) => `${p.date},${p.level},${p.index}`);
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selected}_series.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const last = series.length ? series[series.length - 1] : null;
  const min = series.length ? Math.min(...series.map((d) => d.index)) : null;
  const max = series.length ? Math.max(...series.map((d) => d.index)) : null;
  const from = series.length ? series[0].date : null;
  const to = series.length ? series[series.length - 1].date : null;

  return (
    <div className="min-h-screen bg-slate-950">
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight text-white">Solactive ISIN Explorer</h1>
          <p className="mt-2 text-slate-400">Browse indices or compare Defensive Put replication vs ETF.</p>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={() => setTab("explorer")}
              className={`rounded-lg px-4 py-2 text-sm font-medium ${
                tab === "explorer" ? "bg-indigo-500 text-white" : "border border-slate-700 text-slate-300 hover:bg-slate-800"
              }`}
            >
              Explorer
            </button>
            <button
              type="button"
              onClick={() => setTab("replication")}
              className={`rounded-lg px-4 py-2 text-sm font-medium ${
                tab === "replication" ? "bg-indigo-500 text-white" : "border border-slate-700 text-slate-300 hover:bg-slate-800"
              }`}
            >
              Defensive Put Replication
            </button>
          </div>
        </header>

        {tab === "replication" ? (
          <ReplicationView />
        ) : (
          <>

        <section className="mb-6 rounded-2xl border border-slate-800 bg-slate-900/50 p-5">
          <div className="flex flex-wrap items-center gap-3">
            <label className="cursor-pointer rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-400">
              Load parquet
              <input type="file" accept=".parquet" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            <span className="text-sm text-slate-400">{fileLabel ? `Loaded: ${fileLabel}` : "No file loaded"}</span>
            {isins.length > 0 && (
              <span className="rounded-full bg-slate-800 px-3 py-1 text-xs text-slate-300">
                {isins.length.toLocaleString()} ISINs
              </span>
            )}
          </div>
          {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
        </section>

        <section className="mb-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => go(-1)}
            disabled={idx <= 0}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            type="button"
            onClick={() => go(1)}
            disabled={idx < 0 || idx >= isins.length - 1}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm hover:bg-slate-800 disabled:opacity-40"
          >
            Next
          </button>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ISIN..."
            className="min-w-[220px] flex-1 rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-sm outline-none ring-indigo-500 focus:ring-2"
          />
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="min-w-[320px] rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
          >
            {!query && defensiveInFile.length > 0 && (
              <optgroup label="Defensive Put Write (priority)">
                {defensiveInFile.map((item) => (
                  <option key={item.isin} value={item.isin}>
                    {formatIsinLabel(item.isin)} · ETF {item.etf}
                  </option>
                ))}
              </optgroup>
            )}
            {!query && otherIsins.length > 0 && (
              <optgroup label="All other ISINs">
                {otherIsins.slice(0, 300).map((isin) => (
                  <option key={isin} value={isin}>
                    {isin}
                  </option>
                ))}
              </optgroup>
            )}
            {query &&
              selectOptions.map((isin) => (
                <option key={isin} value={isin}>
                  {formatIsinLabel(isin)}
                </option>
              ))}
          </select>
        </section>

        {selected && (
          <div className="mb-4 text-sm text-slate-400">
            {idx + 1} / {isins.length} · <span className="font-mono text-slate-100">{selected}</span>
            {getDefensivePutMeta(selected) && (
              <span className="ml-2 rounded-full bg-indigo-500/20 px-2 py-0.5 text-xs text-indigo-300">
                Defensive Put Write
              </span>
            )}
          </div>
        )}

        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Points" value={series.length || "—"} />
          <Stat label="From" value={from || "—"} />
          <Stat label="To" value={to || "—"} />
          <Stat label="Last index" value={last ? last.index.toFixed(2) : "—"} />
          <Stat label="Min index" value={min != null ? min.toFixed(2) : "—"} />
          <Stat label="Max index" value={max != null ? max.toFixed(2) : "—"} />
        </div>

        <section className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">{selected || "Select an ISIN"}</h2>
            <div className="flex items-center gap-3">
              {loading && <span className="text-xs text-slate-400">Loading…</span>}
              <button
                type="button"
                onClick={downloadCsv}
                disabled={!series.length}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800 disabled:opacity-40"
              >
                Download CSV
              </button>
            </div>
          </div>
          <div className="h-[420px]">
            {series.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart key={selected} data={series}>
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
                  <YAxis tick={{ fill: "#94a3b8", fontSize: 11 }} domain={["auto", "auto"]} />
                  <Tooltip
                    labelFormatter={(ts) => new Date(ts).toISOString().slice(0, 10)}
                    formatter={(v, _name, item) => [
                      `Index ${Number(v).toFixed(2)} (level ${item.payload.level.toFixed(2)})`,
                      "Normalized",
                    ]}
                    contentStyle={{ background: "#0f172a", border: "1px solid #334155", borderRadius: 8 }}
                    labelStyle={{ color: "#cbd5e1" }}
                  />
                  <Line
                    type="linear"
                    dataKey="index"
                    stroke="#818cf8"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-slate-500">
                {loading ? "Loading series…" : "Select an ISIN to plot."}
              </div>
            )}
          </div>
        </section>
          </>
        )}
      </div>
    </div>
  );
}
