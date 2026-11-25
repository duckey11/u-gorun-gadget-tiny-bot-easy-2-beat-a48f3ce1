// Tiny trend-following bot — bars-replay/v1 (long-only, SMA crossover + stop loss).
// Deterministic: no randomness, no clock, no network, no file reads.
// Reads all parameters (symbols, scales, capital, caps, fees, warmup) from hello.
import * as readline from "node:readline";

const FAST = 5; // SMA cepat (bar)
const SLOW = 12; // SMA lambat (bar)
const STOP_BPS = 800; // stop loss 8% di bawah harga masuk
const WEIGHT_BPS = 2000; // 20% ekuitas per posisi

let cfg: any = null;
const closes = new Map<string, bigint[]>();
const entryPrice = new Map<string, bigint>();
let barCount = 0;

function sma(arr: bigint[], n: number): bigint | null {
  if (arr.length < n) return null;
  let s = 0n;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / BigInt(n);
}

function handleBatch(msg: any): any {
  barCount++;
  const bars: any[] = msg.bars ?? [];
  for (const b of bars) {
    const hist = closes.get(b.symbol) ?? [];
    hist.push(BigInt(b.c));
    closes.set(b.symbol, hist);
  }

  const account = msg.account ?? {};
  const positions = new Map<string, bigint>();
  for (const p of account.positions ?? []) {
    const q = BigInt(p.qty);
    if (q > 0n) positions.set(p.symbol, q);
  }

  // Catat harga masuk: saat posisi baru terlihat, pakai close bar berjalan
  // (fill terjadi di open bar ini, jadi close bar ini pendekatan yang wajar).
  // Bersihkan entri simbol yang posisinya sudah tertutup.
  const latestClose = new Map<string, bigint>();
  for (const b of bars) latestClose.set(b.symbol, BigInt(b.c));
  for (const sym of [...entryPrice.keys()]) {
    if (!positions.has(sym)) entryPrice.delete(sym);
  }
  for (const sym of positions.keys()) {
    if (!entryPrice.has(sym) && latestClose.has(sym)) {
      entryPrice.set(sym, latestClose.get(sym)!);
    }
  }

  const orders: any[] = [];
  const warmup: number = cfg?.warmup_bars ?? 0;
  if (barCount > warmup) {
    const equity = BigInt(account.equity_quote_units ?? "0");
    const maxWeightBps: number = cfg?.caps?.max_weight_bps ?? 2500;
    const maxOpen: number = cfg?.caps?.max_open_positions ?? 10;
    const maxOrders: number = cfg?.caps?.max_orders_per_bar ?? 16;
    const minNotional = BigInt(cfg?.fees?.min_notional_quote_units ?? "0");
    const slippage: number = cfg?.fees?.slippage_bps ?? 5;

    let notional = (equity * BigInt(WEIGHT_BPS)) / 10000n;
    const maxNotional = (equity * BigInt(maxWeightBps)) / 10000n;
    if (notional > maxNotional) notional = maxNotional;

    let plannedBuys = 0;
    const symbols = [...closes.keys()].sort();
    for (const sym of symbols) {
      if (orders.length >= maxOrders) break;
      const hist = closes.get(sym)!;
      if (hist.length < SLOW + 1) continue;
      const fast = sma(hist, FAST)!;
      const slow = sma(hist, SLOW)!;
      const prev = hist.slice(0, -1);
      const prevFast = sma(prev, FAST)!;
      const prevSlow = sma(prev, SLOW)!;
      const close = hist[hist.length - 1];
      const hasPos = positions.has(sym);

      const crossUp = prevFast <= prevSlow && fast > slow;
      const crossDown = prevFast >= prevSlow && fast < slow;

      if (hasPos) {
        const entry = entryPrice.get(sym);
        const stopped =
          entry !== undefined &&
          close * 10000n < entry * BigInt(10000 - STOP_BPS);
        if (crossDown || stopped) {
          orders.push({
            side: "sell",
            client_id: `${msg.seq}-${sym}-sell`,
            symbol: sym,
            qty: positions.get(sym)!.toString(),
            max_slippage_bps: slippage,
          });
        }
      } else if (crossUp) {
        if (positions.size + plannedBuys >= maxOpen) continue;
        if (notional < minNotional || notional <= 0n) continue;
        orders.push({
          side: "buy",
          client_id: `${msg.seq}-${sym}-buy`,
          symbol: sym,
          notional_quote_units: notional.toString(),
          max_slippage_bps: slippage,
        });
        plannedBuys++;
      }
    }
  }

  return { type: "reply", seq: msg.seq, orders };
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line: string) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (msg.type === "hello") {
    cfg = msg;
  } else if (msg.type === "batch") {
    const reply = handleBatch(msg);
    process.stdout.write(JSON.stringify(reply) + "\n");
  } else if (msg.type === "done") {
    process.exit(0);
  }
});
