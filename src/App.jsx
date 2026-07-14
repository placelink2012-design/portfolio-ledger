import { useState, useEffect, useMemo, useRef } from "react";
import Papa from "papaparse";
import {
  ResponsiveContainer, ComposedChart, Line, Scatter, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, PieChart, Pie, Cell,
} from "recharts";
import {
  Upload, PieChart as PieIcon, TrendingUp, LineChart as LineIcon,
  RefreshCw, AlertCircle, Trash2, Check, ChevronRight, Loader2,
} from "lucide-react";

/* ---------------------------------------------------------------------- */
/*  Design tokens — trading-terminal palette, echoing the ticker screens  */
/* ---------------------------------------------------------------------- */
const C = {
  bg: "#0F1115",
  surface: "#171A21",
  surfaceAlt: "#1D212B",
  border: "#282D38",
  text: "#E7E9EE",
  muted: "#8B93A5",
  accent: "#46C2B9",
  gold: "#E0B15C",
  gain: "#3ED598",
  loss: "#FF6B6B",
};
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/* ---------------------------------------------------------------------- */
/*  Exchange + field definitions                                          */
/* ---------------------------------------------------------------------- */
const EXCHANGES = [
  { id: "minna_fx", label: "みんなのFX", type: "margin" },
  { id: "matsui", label: "松井証券", type: "spot" },
  { id: "bitbank", label: "bitbank", type: "spot" },
  { id: "gmo_coin", label: "GMOコイン", type: "spot" },
];

const FIELD_DEFS = [
  { key: "date", label: "日付（約定日）", required: true },
  { key: "symbol", label: "銘柄 / 通貨ペア", required: true },
  { key: "side", label: "売買区分", required: true },
  { key: "quantity", label: "数量", required: true },
  { key: "price", label: "約定単価", required: true },
  { key: "fee", label: "手数料", required: false },
  { key: "realizedPnL", label: "損益（あれば）", required: false },
];

const GUESS_DICT = {
  date: ["約定日時", "約定日", "取引日", "受渡日", "執行日", "日付", "date"],
  symbol: ["通貨ペア", "銘柄コード", "銘柄名", "銘柄", "ペア", "コイン", "symbol", "asset"],
  side: ["売買区分", "取引区分", "売買種別", "売買", "区分", "side"],
  quantity: ["約定数量", "取引数量", "数量", "株数", "amount", "qty"],
  price: ["約定単価", "約定価格", "単価", "レート", "価格", "price"],
  fee: ["手数料", "費用", "fee"],
  realizedPnL: ["決済損益", "実現損益", "損益", "pnl", "realized"],
};

const FLOW_FIELD_DEFS = [
  { key: "date", label: "日付", required: true },
  { key: "type", label: "区分（入金 / 出金）", required: false },
  { key: "amount", label: "金額", required: true },
];

const FLOW_GUESS_DICT = {
  date: ["入出金日", "処理日", "約定日", "取引日", "日付", "date"],
  type: ["区分", "種別", "入出金区分", "取引種別", "type"],
  amount: ["入出金額", "金額", "amount"],
};

function normalizeFlowType(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (s.includes("出金") || /withdraw/.test(s)) return "withdrawal";
  if (s.includes("入金") || /deposit/.test(s)) return "deposit";
  return null;
}

function guessMapping(headers, fieldDefs = FIELD_DEFS, dict = GUESS_DICT) {
  const used = new Set();
  const mapping = {};
  for (const field of fieldDefs) {
    const candidates = dict[field.key] || [];
    let best = null;
    for (const h of headers) {
      if (used.has(h)) continue;
      const hh = String(h).trim();
      if (candidates.some((c) => hh.includes(c))) { best = h; break; }
    }
    mapping[field.key] = best;
    if (best) used.add(best);
  }
  return mapping;
}

function parseNumber(v) {
  if (v == null) return null;
  let s = String(v).trim();
  if (s === "" || s === "-" || s === "—") return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[¥$,%\s]/g, "");
  const n = parseFloat(s);
  if (Number.isNaN(n)) return null;
  return neg ? -n : n;
}

function normalizeSide(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (s.includes("売") || /sell|short|決済/.test(s)) return "sell";
  if (s.includes("買") || /buy|long|新規/.test(s)) return "buy";
  return null;
}

function parseDateLoose(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const d = new Date(s.replace(/\//g, "-"));
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

const fmtJPY = (n) =>
  n == null ? "—" : new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(n);
const fmtNum = (n, d = 2) => (n == null ? "—" : n.toLocaleString("ja-JP", { maximumFractionDigits: d }));

/* ---------------------------------------------------------------------- */
/*  Portfolio math                                                        */
/* ---------------------------------------------------------------------- */
function computeHoldings(txByExchange) {
  const book = {}; // symbol -> {qty, avgCost, realized}
  for (const ex of EXCHANGES) {
    if (ex.type !== "spot") continue;
    const txs = (txByExchange[ex.id] || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    for (const t of txs) {
      if (!t.symbol || !t.side || t.quantity == null || t.price == null) continue;
      const key = t.symbol;
      if (!book[key]) book[key] = { symbol: key, qty: 0, avgCost: 0, realized: 0 };
      const h = book[key];
      if (t.side === "buy") {
        const newQty = h.qty + t.quantity;
        const totalCost = h.avgCost * h.qty + t.price * t.quantity + (t.fee || 0);
        h.avgCost = newQty > 0 ? totalCost / newQty : 0;
        h.qty = newQty;
      } else {
        const pnl = t.realizedPnL != null ? t.realizedPnL : (t.price - h.avgCost) * t.quantity - (t.fee || 0);
        h.realized += pnl;
        h.qty -= t.quantity;
      }
    }
  }
  return Object.values(book).filter((h) => Math.abs(h.qty) > 1e-9);
}

function computePnlSeries(txByExchange) {
  const points = [];
  for (const ex of EXCHANGES) {
    const txs = txByExchange[ex.id] || [];
    if (ex.type === "margin") {
      for (const t of txs) {
        if (t.realizedPnL != null && t.date) points.push({ date: t.date, pnl: t.realizedPnL });
      }
    } else {
      const running = {};
      const sorted = txs.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
      for (const t of sorted) {
        if (!t.symbol || !t.side || t.quantity == null || t.price == null) continue;
        if (!running[t.symbol]) running[t.symbol] = { qty: 0, avgCost: 0 };
        const h = running[t.symbol];
        if (t.side === "buy") {
          const newQty = h.qty + t.quantity;
          h.avgCost = newQty > 0 ? (h.avgCost * h.qty + t.price * t.quantity) / newQty : 0;
          h.qty = newQty;
        } else {
          const pnl = t.realizedPnL != null ? t.realizedPnL : (t.price - h.avgCost) * t.quantity - (t.fee || 0);
          h.qty -= t.quantity;
          points.push({ date: t.date, pnl });
        }
      }
    }
  }
  points.sort((a, b) => (a.date < b.date ? -1 : 1));
  let cum = 0;
  const byDate = {};
  for (const p of points) {
    cum += p.pnl;
    byDate[p.date] = cum;
  }
  return Object.entries(byDate).map(([date, cumulative]) => ({ date, cumulative }));
}

function computeCashBalances(txByExchange, flowsByExchange) {
  const balances = {};
  for (const ex of EXCHANGES) {
    let cash = 0;
    for (const f of flowsByExchange[ex.id] || []) {
      if (f.type === "withdrawal") cash -= f.amount;
      else cash += f.amount; // treat unknown/deposit as inflow
    }
    for (const t of txByExchange[ex.id] || []) {
      if (t.quantity == null || t.price == null) continue;
      if (ex.type === "spot") {
        if (t.side === "buy") cash -= t.price * t.quantity + (t.fee || 0);
        else if (t.side === "sell") cash += t.price * t.quantity - (t.fee || 0);
      } else {
        if (t.realizedPnL != null) cash += t.realizedPnL - (t.fee || 0);
      }
    }
    balances[ex.id] = cash;
  }
  return balances;
}

const PIE_COLORS = [C.accent, C.gold, "#7C9EF2", "#E08FD0", "#84D9B0", "#F2A65A", "#6FB1E0", "#C7846B"];

/* ---------------------------------------------------------------------- */
/*  Storage helpers                                                       */
/* ---------------------------------------------------------------------- */
async function loadExchangeTxns(id) {
  try {
    const r = await window.storage.get(`txns:${id}`, false);
    return r ? JSON.parse(r.value) : [];
  } catch {
    return [];
  }
}
async function saveExchangeTxns(id, arr) {
  try { await window.storage.set(`txns:${id}`, JSON.stringify(arr), false); } catch {}
}
async function loadExchangeFlows(id) {
  try {
    const r = await window.storage.get(`flows:${id}`, false);
    return r ? JSON.parse(r.value) : [];
  } catch {
    return [];
  }
}
async function saveExchangeFlows(id, arr) {
  try { await window.storage.set(`flows:${id}`, JSON.stringify(arr), false); } catch {}
}

/* ---------------------------------------------------------------------- */
/*  UI atoms                                                              */
/* ---------------------------------------------------------------------- */
function Eyebrow({ children }) {
  return (
    <div className="text-xs uppercase font-bold mb-3" style={{ color: C.muted, letterSpacing: "0.14em" }}>
      — {children}
    </div>
  );
}

function TickerStat({ label, value, tone }) {
  const color = tone === "gain" ? C.gain : tone === "loss" ? C.loss : C.text;
  return (
    <div className="flex flex-col">
      <span className="text-xs uppercase mb-1" style={{ color: C.muted, letterSpacing: "0.12em" }}>{label}</span>
      <span className="text-2xl font-bold" style={{ fontFamily: MONO, color }}>{value}</span>
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, children }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 px-4 py-3 text-sm font-semibold transition-colors"
      style={{
        color: active ? C.text : C.muted,
        borderBottom: `2px solid ${active ? C.accent : "transparent"}`,
      }}
    >
      <Icon size={16} />
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------------- */
/*  Mapping modal                                                         */
/* ---------------------------------------------------------------------- */
function MappingModal({ draft, onCancel, onConfirm }) {
  const [mapping, setMapping] = useState(draft.mapping);
  const missing = draft.fieldDefs.filter((f) => f.required && !mapping[f.key]);

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ background: "rgba(0,0,0,0.6)" }}>
      <div className="w-full max-w-2xl rounded-lg p-6 max-h-[85vh] overflow-auto" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
        <Eyebrow>{draft.exchangeLabel} · 列の対応付け</Eyebrow>
        <p className="text-sm mb-4" style={{ color: C.muted }}>
          CSVの列を自動で推定しました。内容を確認し、必要であれば選び直してください。（{draft.rows.length}行を検出）
        </p>

        <div className="space-y-3 mb-4">
          {draft.fieldDefs.map((f) => (
            <div key={f.key} className="flex items-center gap-3">
              <div className="w-40 text-sm" style={{ color: C.text }}>
                {f.label}{f.required && <span style={{ color: C.loss }}> *</span>}
              </div>
              <select
                value={mapping[f.key] || ""}
                onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || null })}
                className="flex-1 rounded p-2 text-sm"
                style={{ background: C.surfaceAlt, color: C.text, border: `1px solid ${C.border}` }}
              >
                <option value="">— 使用しない —</option>
                {draft.headers.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
              <div className="w-32 text-xs truncate" style={{ color: C.muted, fontFamily: MONO }}>
                {mapping[f.key] ? String(draft.rows[0]?.[mapping[f.key]] ?? "") : ""}
              </div>
            </div>
          ))}
        </div>

        {missing.length > 0 && (
          <div className="flex items-center gap-2 text-sm mb-4" style={{ color: C.loss }}>
            <AlertCircle size={16} /> 必須項目が未設定です: {missing.map((m) => m.label).join(" / ")}
          </div>
        )}

        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm rounded" style={{ color: C.muted, border: `1px solid ${C.border}` }}>
            キャンセル
          </button>
          <button
            disabled={missing.length > 0}
            onClick={() => onConfirm(mapping)}
            className="px-4 py-2 text-sm rounded font-semibold flex items-center gap-2 disabled:opacity-40"
            style={{ background: C.accent, color: "#0F1115" }}
          >
            <Check size={16} /> 取り込む
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  Upload tab                                                            */
/* ---------------------------------------------------------------------- */
function UploadTab({ txByExchange, setTxByExchange, flowsByExchange, setFlowsByExchange, onDataImported }) {
  const [selectedExchange, setSelectedExchange] = useState(EXCHANGES[0].id);
  const [dataType, setDataType] = useState("trades"); // 'trades' | 'flows'
  const [draft, setDraft] = useState(null);
  const [status, setStatus] = useState(null);
  const [backupStatus, setBackupStatus] = useState(null);
  const fileRef = useRef(null);
  const backupFileRef = useRef(null);

  async function exportBackup() {
    const list = await window.storage.list("", false);
    const keys = list?.keys || [];
    const dump = {};
    for (const key of keys) {
      const r = await window.storage.get(key, false);
      if (r) dump[key] = r.value;
    }
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `portfolio-ledger-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function importBackup(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const dump = JSON.parse(reader.result);
        for (const [key, value] of Object.entries(dump)) {
          await window.storage.set(key, value, false);
        }
        await onDataImported?.();
        setBackupStatus({ type: "success", msg: `バックアップを読み込みました（${Object.keys(dump).length}件のキー）` });
      } catch (err) {
        setBackupStatus({ type: "error", msg: "読み込みに失敗しました: " + err.message });
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const fieldDefs = dataType === "trades" ? FIELD_DEFS : FLOW_FIELD_DEFS;
    const dict = dataType === "trades" ? GUESS_DICT : FLOW_GUESS_DICT;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const headers = res.meta.fields || [];
        setDraft({
          dataType,
          fieldDefs,
          exchangeId: selectedExchange,
          exchangeLabel: EXCHANGES.find((x) => x.id === selectedExchange).label,
          headers,
          rows: res.data,
          mapping: guessMapping(headers, fieldDefs, dict),
        });
      },
      error: (err) => setStatus({ type: "error", msg: "CSVの読み込みに失敗しました: " + err.message }),
    });
    e.target.value = "";
  }

  async function confirmImport(mapping) {
    if (draft.dataType === "trades") {
      const normalized = draft.rows.map((row) => ({
        exchange: draft.exchangeId,
        date: parseDateLoose(row[mapping.date]),
        symbol: mapping.symbol ? String(row[mapping.symbol] || "").trim() : null,
        side: normalizeSide(row[mapping.side]),
        quantity: parseNumber(row[mapping.quantity]),
        price: parseNumber(row[mapping.price]),
        fee: mapping.fee ? parseNumber(row[mapping.fee]) : null,
        realizedPnL: mapping.realizedPnL ? parseNumber(row[mapping.realizedPnL]) : null,
      })).filter((t) => t.date && t.symbol && t.side);

      const existing = txByExchange[draft.exchangeId] || [];
      const seen = new Set(existing.map((t) => `${t.date}|${t.symbol}|${t.side}|${t.quantity}|${t.price}`));
      const fresh = normalized.filter((t) => {
        const key = `${t.date}|${t.symbol}|${t.side}|${t.quantity}|${t.price}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const merged = [...existing, ...fresh];
      const next = { ...txByExchange, [draft.exchangeId]: merged };
      setTxByExchange(next);
      await saveExchangeTxns(draft.exchangeId, merged);
      setStatus({ type: "success", msg: `${draft.exchangeLabel}（取引）: ${fresh.length}件を取り込みました（重複${normalized.length - fresh.length}件は除外）` });
    } else {
      const normalized = draft.rows.map((row) => {
        const rawAmount = mapping.amount ? parseNumber(row[mapping.amount]) : null;
        let type = mapping.type ? normalizeFlowType(row[mapping.type]) : null;
        let amount = rawAmount;
        if (!type && rawAmount != null) {
          type = rawAmount < 0 ? "withdrawal" : "deposit";
          amount = Math.abs(rawAmount);
        }
        return {
          exchange: draft.exchangeId,
          date: parseDateLoose(row[mapping.date]),
          type,
          amount: amount != null ? Math.abs(amount) : null,
        };
      }).filter((f) => f.date && f.type && f.amount != null);

      const existing = flowsByExchange[draft.exchangeId] || [];
      const seen = new Set(existing.map((f) => `${f.date}|${f.type}|${f.amount}`));
      const fresh = normalized.filter((f) => {
        const key = `${f.date}|${f.type}|${f.amount}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const merged = [...existing, ...fresh];
      const next = { ...flowsByExchange, [draft.exchangeId]: merged };
      setFlowsByExchange(next);
      await saveExchangeFlows(draft.exchangeId, merged);
      setStatus({ type: "success", msg: `${draft.exchangeLabel}（入出金）: ${fresh.length}件を取り込みました（重複${normalized.length - fresh.length}件は除外）` });
    }
    setDraft(null);
  }

  async function clearExchange(id, which) {
    if (which === "trades") {
      const next = { ...txByExchange, [id]: [] };
      setTxByExchange(next);
      await saveExchangeTxns(id, []);
    } else {
      const next = { ...flowsByExchange, [id]: [] };
      setFlowsByExchange(next);
      await saveExchangeFlows(id, []);
    }
  }

  return (
    <div>
      <Eyebrow>データ取込</Eyebrow>
      <div className="grid grid-cols-2 gap-3 mb-6">
        {EXCHANGES.map((ex) => {
          const tradeCount = (txByExchange[ex.id] || []).length;
          const flowCount = (flowsByExchange[ex.id] || []).length;
          const active = selectedExchange === ex.id;
          return (
            <div
              key={ex.id}
              className="rounded-lg p-4 cursor-pointer"
              onClick={() => setSelectedExchange(ex.id)}
              style={{
                background: C.surface,
                border: `1px solid ${active ? C.accent : C.border}`,
              }}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-sm" style={{ color: C.text }}>{ex.label}</span>
                <span className="text-xs px-2 py-0.5 rounded" style={{ background: C.surfaceAlt, color: C.muted }}>
                  {ex.type === "spot" ? "現物" : "証拠金"}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs mb-1" style={{ color: C.muted }}>
                <span style={{ fontFamily: MONO }}>取引 {tradeCount}件</span>
                {tradeCount > 0 && (
                  <button onClick={(e) => { e.stopPropagation(); clearExchange(ex.id, "trades"); }} style={{ color: C.loss }}>
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
              <div className="flex items-center justify-between text-xs" style={{ color: C.muted }}>
                <span style={{ fontFamily: MONO }}>入出金 {flowCount}件</span>
                {flowCount > 0 && (
                  <button onClick={(e) => { e.stopPropagation(); clearExchange(ex.id, "flows"); }} style={{ color: C.loss }}>
                    <Trash2 size={12} />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex gap-1 mb-4">
        {[["trades", "取引履歴"], ["flows", "入出金履歴"]].map(([id, label]) => (
          <button
            key={id}
            onClick={() => setDataType(id)}
            className="px-4 py-2 text-sm rounded font-semibold"
            style={{
              background: dataType === id ? C.accent : C.surfaceAlt,
              color: dataType === id ? "#0F1115" : C.muted,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="rounded-lg p-6 flex flex-col items-center gap-3" style={{ background: C.surface, border: `1px dashed ${C.border}` }}>
        <Upload size={28} color={C.accent} />
        <div className="text-sm" style={{ color: C.text }}>
          <strong>{EXCHANGES.find((x) => x.id === selectedExchange).label}</strong> の
          <strong>{dataType === "trades" ? "取引履歴" : "入出金履歴"}</strong> CSVを選択してください
        </div>
        <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} className="text-sm" style={{ color: C.muted }} />
      </div>

      {status && (
        <div className="mt-4 text-sm flex items-center gap-2" style={{ color: status.type === "error" ? C.loss : C.gain }}>
          {status.type === "error" ? <AlertCircle size={16} /> : <Check size={16} />} {status.msg}
        </div>
      )}

      <p className="mt-6 text-xs leading-relaxed" style={{ color: C.muted }}>
        取引所ごとにCSVの列名が異なるため、取込時に列の対応付けを確認する画面が表示されます。
        通貨・金額はすべて円（JPY）建てとして扱います。「松井証券」は株式現物の取引履歴を想定しています。
        入出金CSVで「区分」列が無い場合は、金額の符号（マイナス＝出金）から自動判定します。
      </p>

      <div className="mt-8 pt-6" style={{ borderTop: `1px solid ${C.border}` }}>
        <Eyebrow>バックアップ（端末間の引き継ぎ）</Eyebrow>
        <p className="text-xs leading-relaxed mb-3" style={{ color: C.muted }}>
          このアプリのデータはブラウザ内（localStorage）にのみ保存され、他の端末とは自動的に同期されません。
          別の端末でも見たい場合は、ここからバックアップファイルを書き出し、別端末で読み込んでください。
        </p>
        <div className="flex gap-3">
          <button
            onClick={exportBackup}
            className="px-4 py-2 text-sm rounded font-semibold"
            style={{ background: C.surfaceAlt, color: C.text, border: `1px solid ${C.border}` }}
          >
            バックアップを書き出す
          </button>
          <button
            onClick={() => backupFileRef.current?.click()}
            className="px-4 py-2 text-sm rounded font-semibold"
            style={{ background: C.surfaceAlt, color: C.text, border: `1px solid ${C.border}` }}
          >
            バックアップを読み込む
          </button>
          <input ref={backupFileRef} type="file" accept=".json" onChange={importBackup} className="hidden" />
        </div>
        {backupStatus && (
          <div className="mt-3 text-sm flex items-center gap-2" style={{ color: backupStatus.type === "error" ? C.loss : C.gain }}>
            {backupStatus.type === "error" ? <AlertCircle size={16} /> : <Check size={16} />} {backupStatus.msg}
          </div>
        )}
      </div>

      {draft && <MappingModal draft={draft} onCancel={() => setDraft(null)} onConfirm={confirmImport} />}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  Portfolio tab                                                         */
/* ---------------------------------------------------------------------- */
function PortfolioTab({ holdings, cashBalances }) {
  const holdingsTotal = holdings.reduce((s, h) => s + h.qty * h.avgCost, 0);
  const cashRows = EXCHANGES
    .map((ex) => ({ label: ex.label, amount: cashBalances[ex.id] || 0 }))
    .filter((c) => Math.abs(c.amount) > 1);
  const cashTotal = cashRows.reduce((s, c) => s + c.amount, 0);
  const grandTotal = holdingsTotal + cashTotal;

  const pieData = [
    ...holdings.map((h) => ({ name: h.symbol, value: Math.max(h.qty * h.avgCost, 0), kind: "asset" })),
    ...cashRows.filter((c) => c.amount > 0).map((c) => ({ name: `現金・${c.label}`, value: c.amount, kind: "cash" })),
  ];

  if (holdings.length === 0 && cashRows.length === 0) {
    return (
      <div className="text-sm py-16 text-center" style={{ color: C.muted }}>
        データがまだありません。「データ取込」タブから取引・入出金のCSVを取り込んでください。
      </div>
    );
  }

  return (
    <div>
      <Eyebrow>ポートフォリオ構成（現金＋現物、取得原価ベース）</Eyebrow>
      <div className="grid grid-cols-2 gap-6">
        <div style={{ height: 300 }}>
          <ResponsiveContainer>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={60} outerRadius={110} paddingAngle={2}>
                {pieData.map((d, i) => (
                  <Cell key={i} fill={d.kind === "cash" ? C.gold : PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, color: C.text }}
                formatter={(v) => fmtJPY(v)}
              />
              <Legend wrapperStyle={{ color: C.muted, fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ color: C.muted }}>
                <th className="text-left font-normal pb-2">項目</th>
                <th className="text-right font-normal pb-2">数量</th>
                <th className="text-right font-normal pb-2">単価/内訳</th>
                <th className="text-right font-normal pb-2">評価額</th>
              </tr>
            </thead>
            <tbody style={{ fontFamily: MONO }}>
              {holdings.map((h) => (
                <tr key={h.symbol} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td className="py-2" style={{ color: C.text, fontFamily: "inherit" }}>{h.symbol}</td>
                  <td className="py-2 text-right" style={{ color: C.text }}>{fmtNum(h.qty, 4)}</td>
                  <td className="py-2 text-right" style={{ color: C.muted }}>{fmtJPY(h.avgCost)}</td>
                  <td className="py-2 text-right" style={{ color: C.text }}>{fmtJPY(h.qty * h.avgCost)}</td>
                </tr>
              ))}
              {cashRows.map((c) => (
                <tr key={c.label} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td className="py-2" style={{ color: C.gold, fontFamily: "inherit" }}>現金・{c.label}</td>
                  <td className="py-2 text-right" style={{ color: C.muted }}>—</td>
                  <td className="py-2 text-right" style={{ color: C.muted }}>—</td>
                  <td className="py-2 text-right" style={{ color: c.amount >= 0 ? C.text : C.loss }}>{fmtJPY(c.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 pt-3 space-y-1 text-sm" style={{ borderTop: `1px solid ${C.border}` }}>
            <div className="flex justify-between" style={{ color: C.muted }}>
              <span>現物評価額</span>
              <span style={{ fontFamily: MONO, color: C.text }}>{fmtJPY(holdingsTotal)}</span>
            </div>
            <div className="flex justify-between" style={{ color: C.muted }}>
              <span>現金合計</span>
              <span style={{ fontFamily: MONO, color: C.text }}>{fmtJPY(cashTotal)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span style={{ color: C.text }}>総資産</span>
              <span style={{ fontFamily: MONO, color: C.accent }}>{fmtJPY(grandTotal)}</span>
            </div>
          </div>
        </div>
      </div>
      <p className="mt-6 text-xs leading-relaxed" style={{ color: C.muted }}>
        現金残高は「入出金合計 ± 取引の買付・売却代金 ± 手数料（FX/CFDは決済損益）」から算出した概算です。
        入出金CSVを取り込んでいない取引所は現金の内訳に表示されません。
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  P&L tab                                                                */
/* ---------------------------------------------------------------------- */
function PnlTab({ series }) {
  if (series.length === 0) {
    return (
      <div className="text-sm py-16 text-center" style={{ color: C.muted }}>
        損益データがまだありません。決済（売却）取引を含むCSVを取り込むと表示されます。
      </div>
    );
  }
  const last = series[series.length - 1].cumulative;
  return (
    <div>
      <Eyebrow>実現損益の推移（累積・全取引所合算）</Eyebrow>
      <div style={{ height: 340 }}>
        <ResponsiveContainer>
          <ComposedChart data={series}>
            <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
            <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 11 }} minTickGap={30} />
            <YAxis tick={{ fill: C.muted, fontSize: 11 }} tickFormatter={(v) => fmtJPY(v)} width={90} />
            <Tooltip
              contentStyle={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, color: C.text }}
              formatter={(v) => fmtJPY(v)}
            />
            <Line type="monotone" dataKey="cumulative" stroke={last >= 0 ? C.gain : C.loss} strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 text-sm flex gap-2 items-baseline">
        <span style={{ color: C.muted }}>累積実現損益</span>
        <span className="text-xl font-bold" style={{ fontFamily: MONO, color: last >= 0 ? C.gain : C.loss }}>{fmtJPY(last)}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  Symbol chart tab (Yahoo Finance)                                      */
/* ---------------------------------------------------------------------- */
function ChartTab({ holdings, txByExchange }) {
  const symbols = holdings.map((h) => h.symbol);
  const [selected, setSelected] = useState(symbols[0] || "");
  const [yahooSymbol, setYahooSymbol] = useState(symbols[0] || "");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (symbols.length && !selected) { setSelected(symbols[0]); setYahooSymbol(symbols[0]); }
  }, [symbols.length]); // eslint-disable-line

  async function fetchChart() {
    if (!yahooSymbol) return;
    setLoading(true); setError(null); setData(null);
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=6mo&interval=1d`);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      if (!result) throw new Error(json?.chart?.error?.description || "データが見つかりません");
      const ts = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];
      const series = ts.map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: closes[i] })).filter((p) => p.close != null);

      const allTx = Object.values(txByExchange).flat().filter((t) => t.symbol === selected);
      const byDate = {};
      for (const p of series) byDate[p.date] = p;
      const buys = [], sells = [];
      for (const t of allTx) {
        const point = byDate[t.date];
        if (!point) continue;
        (t.side === "buy" ? buys : sells).push({ date: t.date, close: point.close });
      }
      setData({ series, buys, sells });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <Eyebrow>銘柄別チャート（Yahoo!ファイナンス）</Eyebrow>

      {symbols.length === 0 ? (
        <div className="text-sm mb-4" style={{ color: C.muted }}>
          保有銘柄がまだありません。先にCSVを取り込むと、ここから選択できます。
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 mb-4">
          {symbols.map((s) => (
            <button
              key={s}
              onClick={() => { setSelected(s); setYahooSymbol(s); setData(null); setError(null); }}
              className="px-3 py-1.5 text-xs rounded"
              style={{
                background: selected === s ? C.accent : C.surfaceAlt,
                color: selected === s ? "#0F1115" : C.muted,
                fontFamily: MONO,
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mb-5">
        <span className="text-xs" style={{ color: C.muted }}>Yahoo!ファイナンスのティッカー：</span>
        <input
          value={yahooSymbol}
          onChange={(e) => setYahooSymbol(e.target.value)}
          placeholder="例: 7203.T / BTC-JPY / USDJPY=X"
          className="text-sm rounded px-2 py-1"
          style={{ background: C.surfaceAlt, color: C.text, border: `1px solid ${C.border}`, fontFamily: MONO }}
        />
        <button
          onClick={fetchChart}
          disabled={!yahooSymbol || loading}
          className="px-3 py-1.5 text-sm rounded font-semibold flex items-center gap-2 disabled:opacity-40"
          style={{ background: C.accent, color: "#0F1115" }}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} 取得
        </button>
      </div>

      {error && (
        <div className="text-sm rounded p-4 mb-4 leading-relaxed" style={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, color: C.muted }}>
          <div className="flex items-center gap-2 mb-1" style={{ color: C.loss }}>
            <AlertCircle size={16} /> チャートを取得できませんでした（{error}）
          </div>
          ブラウザからYahoo!ファイナンスへ直接アクセスできない環境の可能性があります。
          お手数ですが
          <a
            href={`https://finance.yahoo.co.jp/quote/${encodeURIComponent(yahooSymbol)}`}
            target="_blank" rel="noreferrer"
            className="underline mx-1"
            style={{ color: C.accent }}
          >
            Yahoo!ファイナンスで直接確認
          </a>
          してください。ティッカー表記が違う場合もあるので、上の入力欄で調整してみてください。
        </div>
      )}

      {data && (
        <div style={{ height: 340 }}>
          <ResponsiveContainer>
            <ComposedChart data={data.series}>
              <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
              <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 11 }} minTickGap={30} />
              <YAxis tick={{ fill: C.muted, fontSize: 11 }} domain={["auto", "auto"]} width={70} />
              <Tooltip contentStyle={{ background: C.surfaceAlt, border: `1px solid ${C.border}`, color: C.text }} />
              <Legend wrapperStyle={{ color: C.muted, fontSize: 12 }} />
              <Line type="monotone" dataKey="close" name="終値" stroke={C.accent} strokeWidth={2} dot={false} />
              <Scatter data={data.buys} dataKey="close" name="買い" fill={C.gain} shape="circle" />
              <Scatter data={data.sells} dataKey="close" name="売り" fill={C.loss} shape="circle" />
            </ComposedChart>
          </ResponsiveContainer>
          <p className="text-xs mt-2" style={{ color: C.muted }}>
            ○ 印は保存済みの売買記録のうち、取得した価格データと日付が一致したものです（参考表示）。
          </p>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/*  App                                                                    */
/* ---------------------------------------------------------------------- */
export default function App() {
  const [tab, setTab] = useState("upload");
  const [txByExchange, setTxByExchange] = useState({});
  const [flowsByExchange, setFlowsByExchange] = useState({});
  const [ready, setReady] = useState(false);

  async function loadAllData() {
    const [txEntries, flowEntries] = await Promise.all([
      Promise.all(EXCHANGES.map(async (ex) => [ex.id, await loadExchangeTxns(ex.id)])),
      Promise.all(EXCHANGES.map(async (ex) => [ex.id, await loadExchangeFlows(ex.id)])),
    ]);
    setTxByExchange(Object.fromEntries(txEntries));
    setFlowsByExchange(Object.fromEntries(flowEntries));
  }

  useEffect(() => {
    (async () => {
      await loadAllData();
      setReady(true);
    })();
  }, []);

  const holdings = useMemo(() => computeHoldings(txByExchange), [txByExchange]);
  const pnlSeries = useMemo(() => computePnlSeries(txByExchange), [txByExchange]);
  const cashBalances = useMemo(() => computeCashBalances(txByExchange, flowsByExchange), [txByExchange, flowsByExchange]);

  const totalValue = holdings.reduce((s, h) => s + h.qty * h.avgCost, 0);
  const totalCash = Object.values(cashBalances).reduce((s, v) => s + v, 0);
  const grandTotal = totalValue + totalCash;
  const lastPnl = pnlSeries.length ? pnlSeries[pnlSeries.length - 1].cumulative : 0;

  if (!ready) {
    return (
      <div className="w-full h-screen flex items-center justify-center" style={{ background: C.bg, color: C.muted }}>
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }

  return (
    <div className="w-full min-h-screen" style={{ background: C.bg, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      {/* Ticker header */}
      <div className="px-6 pt-6 pb-4" style={{ borderBottom: `1px solid ${C.border}` }}>
        <div className="flex items-baseline justify-between mb-4">
          <h1 className="text-lg font-bold" style={{ color: C.text }}>Portfolio Ledger</h1>
          <span className="text-xs" style={{ color: C.muted, fontFamily: MONO }}>
            {new Date().toLocaleString("ja-JP")}
          </span>
        </div>
        <div className="grid grid-cols-4 gap-6">
          <TickerStat label="総資産（現金＋現物）" value={fmtJPY(grandTotal)} />
          <TickerStat label="現金残高" value={fmtJPY(totalCash)} tone={totalCash >= 0 ? undefined : "loss"} />
          <TickerStat label="現物評価額（原価）" value={fmtJPY(totalValue)} />
          <TickerStat label="累積実現損益" value={fmtJPY(lastPnl)} tone={lastPnl >= 0 ? "gain" : "loss"} />
        </div>
      </div>

      {/* Tabs */}
      <div className="px-6 flex gap-1" style={{ borderBottom: `1px solid ${C.border}`, background: C.surface }}>
        <TabButton active={tab === "upload"} onClick={() => setTab("upload")} icon={Upload}>データ取込</TabButton>
        <TabButton active={tab === "portfolio"} onClick={() => setTab("portfolio")} icon={PieIcon}>ポートフォリオ構成</TabButton>
        <TabButton active={tab === "pnl"} onClick={() => setTab("pnl")} icon={TrendingUp}>損益推移</TabButton>
        <TabButton active={tab === "chart"} onClick={() => setTab("chart")} icon={LineIcon}>銘柄チャート</TabButton>
      </div>

      <div className="p-6">
        {tab === "upload" && (
          <UploadTab
            txByExchange={txByExchange} setTxByExchange={setTxByExchange}
            flowsByExchange={flowsByExchange} setFlowsByExchange={setFlowsByExchange}
            onDataImported={loadAllData}
          />
        )}
        {tab === "portfolio" && <PortfolioTab holdings={holdings} cashBalances={cashBalances} />}
        {tab === "pnl" && <PnlTab series={pnlSeries} />}
        {tab === "chart" && <ChartTab holdings={holdings} txByExchange={txByExchange} />}
      </div>
    </div>
  );
}
