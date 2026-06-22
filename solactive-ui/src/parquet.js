import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from "hyparquet";
import { compressors } from "hyparquet-compressors";

function toAsyncBuffer(arrayBuffer) {
  return {
    byteLength: arrayBuffer.byteLength,
    slice: (start, end) => arrayBuffer.slice(start, end),
  };
}

export async function loadParquetBuffer(source) {
  let arrayBuffer;
  if (source instanceof File) {
    arrayBuffer = await source.arrayBuffer();
  } else {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`Failed to load parquet (${res.status})`);
    arrayBuffer = await res.arrayBuffer();
  }
  return { file: toAsyncBuffer(arrayBuffer), arrayBuffer };
}

export async function listIsins(file) {
  const metadata = await parquetMetadataAsync(file);
  const schema = parquetSchema(metadata);
  return schema.children
    .map((e) => e.element.name)
    .filter((name) => name !== "date")
    .sort();
}

function isValidValue(raw) {
  return raw !== null && raw !== undefined && raw !== "" && Number.isFinite(Number(raw));
}

export async function readIsinSeries(file, isin) {
  const rows = await parquetReadObjects({
    file,
    columns: ["date", isin],
    compressors,
  });

  const seen = new Set();
  const series = [];

  for (const row of rows) {
    const raw = row[isin];
    if (!isValidValue(raw)) continue;

    const value = Number(raw);
    const date = String(row.date).slice(0, 10);
    const ts = Date.parse(date);
    if (!date || Number.isNaN(ts) || seen.has(date)) continue;

    seen.add(date);
    series.push({ date, ts, level: value });
  }

  if (!series.length) return [];

  series.sort((a, b) => a.ts - b.ts);
  const base = series[0].level;

  return series.map((point) => ({
    ...point,
    index: (point.level / base) * 100,
  }));
}
