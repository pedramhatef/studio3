
'use server';

import type {
  ChartDataPoint, StrategyParams, TradeResult, InTradeState, PerformanceMetrics
} from '@/lib/types';
import * as indicators from '@/lib/indicators';
import { generateSignal } from '@/lib/signal-generator';


// --- Tunables (safe defaults for 1m DOGE perp) ---
const COOLDOWN_BARS = 3;                     // avoid immediate churn after an exit
const MAX_ATR_PCT = 0.08;                    // skip hyper-volatility bars (8% of price)
const BREAKEVEN_AFTER_R_MULT = 0.8;          // move SL to BE after 0.8R in favor
const TRAILING_AFTER_R_MULT = 1.2;           // start trailing after 1.2R in favor
const TRAILING_ATR_MULT = 0.6;               // trail distance in ATRs once trailing starts

const POPULATION_SIZE = 30;
const GENERATIONS = 20;
const MUTATION_RATE = 0.2;
const ELITISM_RATE = 0.1;
const CONVERGENCE_THRESHOLD = 5;

export function calculatePerformanceMetrics(trades: TradeResult[], initialCapital: number): PerformanceMetrics {
  const numTrades = trades.length;
  if (numTrades === 0) {
    return {
      numberOfTrades: 0,
      totalProfit: 0,
      profitFactor: 0,
      winRate: 0,
      maxDrawdown: 0,
      expectancy: 0,
      sharpeRatio: 0,
      totalProfitPercentage: 0,
      winningTrades: 0,
      losingTrades: 0,
      lossRate: 0,
      averageWin: 0,
      averageLoss: 0,
    };
  }

  let totalProfit = 0;
  let winningTrades = 0;
  let totalWinningProfit = 0;
  let totalLosingProfit = 0; 
  let peakCapital = initialCapital;
  let maxDrawdown = 0;
  const capitalCurve = [initialCapital];

  for (const trade of trades) {
    totalProfit += trade.profit;
    if (trade.profit > 0) {
      winningTrades++;
      totalWinningProfit += trade.profit;
    } else {
      totalLosingProfit += trade.profit;
    }

    const currentCapital = capitalCurve[capitalCurve.length - 1] + trade.profit;
    capitalCurve.push(currentCapital);

    peakCapital = Math.max(peakCapital, currentCapital);
    const drawdown = ((peakCapital - currentCapital) / peakCapital) * 100;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  const profitFactor = totalLosingProfit === 0 ? (totalWinningProfit > 0 ? 999 : 0) : Math.abs(totalWinningProfit / totalLosingProfit);
  const winRate = (winningTrades / numTrades) * 100;
  const expectancy = (totalProfit / numTrades / initialCapital) * 100;

  const averageTradeProfit = totalProfit / numTrades;
  const stdDevProfit = Math.sqrt(trades.map(trade => Math.pow(trade.profit - averageTradeProfit, 2)).reduce((a, b) => a + b, 0) / numTrades);
  const sharpeRatio = stdDevProfit === 0 ? (totalProfit > 0 ? 999 : 0) : averageTradeProfit / stdDevProfit;
  const totalProfitPercentage = (totalProfit / initialCapital) * 100;
  const losingTrades = numTrades - winningTrades;
  const lossRate = (losingTrades / numTrades) * 100;
  const averageWin = winningTrades > 0 ? totalWinningProfit / winningTrades : 0;
  const averageLoss = losingTrades > 0 ? Math.abs(totalLosingProfit / losingTrades) : 0;

  return {
    numberOfTrades: numTrades,
    totalProfit: totalProfit,
    profitFactor: profitFactor,
    winRate: winRate,
    maxDrawdown: maxDrawdown,
    expectancy: expectancy,
    sharpeRatio: sharpeRatio,
    totalProfitPercentage,
    winningTrades,
    losingTrades,
    lossRate,
    averageWin,
    averageLoss,
  };
}

// ----------------- helpers -----------------
const applySpread = (price: number, side: 'BUY'|'SELL', spreadPercent: number) => {
  const s = price * (spreadPercent / 100);
  return side === 'BUY' ? price + s : price - s;
};

function intrabarExitPrice(
  open: number, high: number, low: number,
  tp: number, sl: number, side: 'BUY' | 'SELL'
): { price: number; reason: TradeResult['exitReason'] } | null {
  const tpHit = side === 'BUY' ? high >= tp : low <= tp;
  const slHit = side === 'BUY' ? low <= sl : high >= sl;

  if (tpHit && slHit) {
    const distToTP = Math.abs(tp - open);
    const distToSL = Math.abs(sl - open);
    return distToTP <= distToSL
      ? { price: tp, reason: 'Take Profit' }
      : { price: sl, reason: 'Stop Loss' };
  }
  if (tpHit) return { price: tp, reason: 'Take Profit' };
  if (slHit) return { price: sl, reason: 'Stop Loss' };
  return null;
}

// ----------------- backtest -----------------
export async function runBacktest(
  dogeData: ChartDataPoint[], params: StrategyParams, initialCapital = 10000
): Promise<TradeResult[]> {
  const trades: TradeResult[] = [];
  let capital = initialCapital;
  let inTrade: (InTradeState & {
    highestSinceEntry?: number;
    lowestSinceEntry?: number;
    rDistance?: number;          
  }) | null = null;

  const requiredPeriods =
    Math.max(params.EMA_SLOW_PERIOD, params.RSI_PERIOD, params.ATR_PERIOD, params.VOLUME_PERIOD) + 15;
  if (dogeData.length < requiredPeriods) return trades;

  const closes = dogeData.map(d => d.close);
  const vols   = dogeData.map(d => d.volume);
  const emaFast = indicators.calculateEMA(closes, params.EMA_FAST_PERIOD);
  const emaSlow = indicators.calculateEMA(closes, params.EMA_SLOW_PERIOD);
  const rsi     = indicators.calculateRSI(closes, params.RSI_PERIOD);
  const atr     = indicators.calculateATR(dogeData, params.ATR_PERIOD);
  const psar    = indicators.calculateParabolicSAR(dogeData, params.PARABOLIC_SAR_STEP, params.PARABOLIC_SAR_MAX);
  const vSMA    = indicators.calculateSMA(vols, params.VOLUME_PERIOD);

  const signals: (Awaited<ReturnType<typeof generateSignal>> | null)[] = new Array(dogeData.length).fill(null);
  const getSignal = async (i: number) => {
    if (signals[i] !== null) return signals[i];
    const s = await generateSignal(i, dogeData, params, emaFast, emaSlow, rsi, psar, vSMA, atr);
    signals[i] = s || null;
    return signals[i];
  };

  let lastExitIndex = -Infinity;

  for (let i = requiredPeriods; i < dogeData.length; i++) {
    const c = dogeData[i];
    const prevClose = closes[i - 1];
    const atrVal = atr[i - 1] ?? 0;

    if (atrVal <= 0) continue;
    const atrPct = atrVal / Math.max(1e-9, prevClose);
    if (atrPct > MAX_ATR_PCT) {
        continue;
    }

    if (inTrade) {
      inTrade.highestSinceEntry = Math.max(inTrade.highestSinceEntry ?? -Infinity, c.high);
      inTrade.lowestSinceEntry  = Math.min(inTrade.lowestSinceEntry ?? Infinity, c.low);

      let curSL = inTrade.stopLossPrice;
      let curTP = inTrade.takeProfitPrice;

      if (!inTrade.rDistance) inTrade.rDistance = Math.abs(inTrade.takeProfitPrice - inTrade.entryPrice);

      const favorableMove =
        inTrade.type === 'BUY'
          ? (c.high - inTrade.entryPrice)
          : (inTrade.entryPrice - c.low);

      if (favorableMove >= BREAKEVEN_AFTER_R_MULT * (inTrade.rDistance ?? 0)) {
        curSL = inTrade.type === 'BUY'
          ? Math.max(curSL, inTrade.entryPrice)
          : Math.min(curSL, inTrade.entryPrice);
      }

      if (favorableMove >= TRAILING_AFTER_R_MULT * (inTrade.rDistance ?? 0)) {
        const trail = TRAILING_ATR_MULT * atrVal;
        if (inTrade.type === 'BUY') {
          const candidate = (inTrade.highestSinceEntry ?? c.high) - trail;
          curSL = Math.max(curSL, candidate);
        } else {
          const candidate = (inTrade.lowestSinceEntry ?? c.low) + trail;
          curSL = Math.min(curSL, candidate);
        }
      }

      const hit = intrabarExitPrice(c.open, c.high, c.low, curTP, curSL, inTrade.type);
      let exitPrice: number | null = null;
      let exitReason: TradeResult['exitReason'] | null = null;

      if (hit) {
        exitPrice = hit.price;
        exitReason = hit.reason;
      } else {
        const opp = await getSignal(i);
        if (opp && opp.type !== inTrade.type) {
          exitPrice = c.open;
          exitReason = 'Opposite Signal';
        }
      }

      if (exitPrice !== null && exitReason) {
        const effExit = applySpread(exitPrice, inTrade.type === 'BUY' ? 'SELL' : 'BUY', params.SPREAD_PERCENT);
        const profit = (inTrade.type === 'BUY')
          ? effExit - inTrade.entryPrice
          : inTrade.entryPrice - effExit;
        const profitPct = (profit / inTrade.entryPrice) * 100;
        const finalCap = capital + profit;

        trades.push({
          entryPrice: inTrade.entryPrice,
          exitPrice: effExit,
          entryTime: inTrade.entryTime,
          exitTime: c.time,
          type: inTrade.type,
          profit,
          profitPercentage: profitPct,
          entryCandleIndex: inTrade.entryCandleIndex,
          exitCandleIndex: i,
          initialCapital: capital,
          finalCapital: finalCap,
          exitReason,
        });

        capital = finalCap;
        inTrade = null;
        lastExitIndex = i;
        continue;
      }
    }

    if (!inTrade) {
      if (i - lastExitIndex <= COOLDOWN_BARS) continue;

      const atrOk = atrPct >= (params.NOISE_FILTER_RATIO ?? 0);
      if (!atrOk) continue;

      const signal = await getSignal(i);
      if (!signal) continue;

      const entry = applySpread(signal.price, signal.type, params.SPREAD_PERCENT);
      const r = atrVal > 0 ? atrVal : 0;

      const sl = signal.type === 'BUY'
        ? entry - (r * params.STOP_LOSS_ATR_MULTIPLIER)
        : entry + (r * params.STOP_LOSS_ATR_MULTIPLIER);

      const tp = signal.type === 'BUY'
        ? entry + (r * params.TAKE_PROFIT_ATR_MULTIPLIER)
        : entry - (r * params.TAKE_PROFIT_ATR_MULTIPLIER);

      inTrade = {
        entryPrice: entry,
        entryTime: signal.time,
        type: signal.type,
        entryCandleIndex: i,
        initialCapital: capital,
        stopLossPrice: sl,
        takeProfitPrice: tp,
        highestSinceEntry: c.high,
        lowestSinceEntry: c.low,
        rDistance: Math.abs(tp - entry),
      };
    }
  }

  if (inTrade) {
    const last = dogeData[dogeData.length - 1];
    const effExit = applySpread(last.close, inTrade.type === 'BUY' ? 'SELL' : 'BUY', params.SPREAD_PERCENT);
    const profit = (inTrade.type === 'BUY') ? effExit - inTrade.entryPrice : inTrade.entryPrice - effExit;
    const profitPct = (profit / inTrade.entryPrice) * 100;
    const finalCap = capital + profit;
    trades.push({
      ...inTrade,
      exitPrice: effExit,
      exitTime: last.time,
      exitCandleIndex: dogeData.length - 1,
      profit,
      profitPercentage: profitPct,
      finalCapital: finalCap,
      exitReason: 'End of Data',
    });
  }

  return trades;
}

// ---------- fitness helpers ----------
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function calculateFitness(p: PerformanceMetrics): number {
  if (!p || p.numberOfTrades < 10) return -1e9;

  const net = p.totalProfit;
  const pf = p.profitFactor;
  const wr = p.winRate / 100;
  const dd = p.maxDrawdown;
  const ex = p.expectancy;

  const pfBonus = pf >= 1.3 ? 1 + (pf - 1.3) * 0.25 : pf / 1.3;
  const ddPenalty = Math.exp(-clamp(25 - dd, -50, 25) / 12);
  const tradeCount = 1 - Math.exp(-p.numberOfTrades / 60);
  const wrCurve = Math.pow(wr, 0.8);

  const churnPenalty = (ex < 0.3 && p.numberOfTrades > 400) ? 0.7 : 1;
  const sharpe = p.sharpeRatio;

  let score =
    net * 0.40 +
    sharpe * 0.15 +
    wrCurve * 0.10 +
    pf * 0.15 +
    ex * 0.20;

  score *= pfBonus * ddPenalty * tradeCount * churnPenalty;
  return isFinite(score) ? score : -1e9;
}

// ---------- GA utilities ----------
function pickNeighbor<T extends number>(arr: T[], current: T): T {
  const idx = Math.max(0, arr.indexOf(current));
  const left = Math.max(0, idx - 1), right = Math.min(arr.length - 1, idx + 1);
  const neighborhood = Array.from(new Set([arr[left], arr[idx], arr[right]])).filter(v => v !== undefined) as T[];
  return neighborhood[Math.floor(Math.random() * neighborhood.length)];
}

function tournamentSelect(pop: any[], fitnesses: number[], k = 3): any {
  let bestIdx = -1, bestFit = -Infinity;
  for (let i = 0; i < k; i++) {
    const idx = Math.floor(Math.random() * pop.length);
    if (fitnesses[idx] > bestFit) { bestFit = fitnesses[idx]; bestIdx = idx; }
  }
  return pop[bestIdx];
}

function crossover(p1: any, p2: any): any {
  const c: any = {};
  for (const key of Object.keys(p1)) {
    c[key] = Math.random() < 0.5 ? p1[key] : p2[key];
  }
  return c;
}

function mutate(ind: any, paramRanges: any): any {
  const m: any = { ...ind };
  for (const key of Object.keys(m)) {
    if (Math.random() < MUTATION_RATE) {
      const range: number[] = paramRanges[key];
      m[key] = Math.random() < 0.8 ? pickNeighbor(range, m[key]) : range[Math.floor(Math.random() * range.length)];
    }
  }
  if (m.EMA_FAST_PERIOD >= m.EMA_SLOW_PERIOD) {
    const ok = paramRanges.EMA_FAST_PERIOD.filter((p: number) => p < m.EMA_SLOW_PERIOD);
    m.EMA_FAST_PERIOD = ok.length ? ok[Math.floor(Math.random() * ok.length)] : Math.min(...paramRanges.EMA_FAST_PERIOD);
  }
  if (m.RSI_OVERSOLD_THRESHOLD >= m.RSI_OVERBOUGHT_THRESHOLD) {
    const overS = paramRanges.RSI_OVERSOLD_THRESHOLD.filter((x: number) => x < m.RSI_OVERBOUGHT_THRESHOLD);
    m.RSI_OVERSOLD_THRESHOLD = overS.length ? overS[Math.floor(Math.random() * overS.length)] : Math.min(...paramRanges.RSI_OVERSOLD_THRESHOLD);
  }
  return m;
}

function createIndividual(ranges: { [k: string]: number[] }): any {
  const ind: any = {};
  for (const k of Object.keys(ranges)) {
    const arr = ranges[k];
    ind[k] = arr[Math.floor(Math.random() * arr.length)];
  }
  if (ind.EMA_FAST_PERIOD >= ind.EMA_SLOW_PERIOD) {
    const ok = ranges.EMA_FAST_PERIOD.filter((p: number) => p < ind.EMA_SLOW_PERIOD);
    ind.EMA_FAST_PERIOD = ok.length ? ok[Math.floor(Math.random() * ok.length)] : Math.min(...ranges.EMA_FAST_PERIOD);
  }
  if (ind.RSI_OVERSOLD_THRESHOLD >= ind.RSI_OVERBOUGHT_THRESHOLD) {
    const overS = ranges.RSI_OVERSOLD_THRESHOLD.filter((x: number) => x < ind.RSI_OVERBOUGHT_THRESHOLD);
    ind.RSI_OVERSOLD_THRESHOLD = overS.length ? overS[Math.floor(Math.random() * overS.length)] : Math.min(...ranges.RSI_OVERSOLD_THRESHOLD);
  }
  return ind;
}

function seedPopulation(ranges: { [k: string]: number[] }, n: number) {
  const pop: any[] = [];
  const mid: any = {};
  for (const k of Object.keys(ranges)) {
    const arr = ranges[k];
    mid[k] = arr[Math.floor(arr.length / 2)];
  }
  pop.push(mid);

  const lo: any = {}, hi: any = {};
  for (const k of Object.keys(ranges)) {
    const arr = ranges[k];
    lo[k] = arr[0]; hi[k] = arr[arr.length - 1];
  }
  pop.push(lo, hi);

  while (pop.length < n) pop.push(createIndividual(ranges));
  return pop;
}

export async function optimizeParameters(
  dogeData: ChartDataPoint[],
  paramRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]?: number[] }
): Promise<{ bestParams: StrategyParams | null; bestPerformance: PerformanceMetrics | null; bestTrades: TradeResult[] }> {
  console.log('Starting genetic algorithm optimization...');
  (global as any).ENABLE_DETAILED_LOGS = false;

  const initialCapital = 10000;
  let population = seedPopulation(paramRanges as any, POPULATION_SIZE);

  let bestInd: any = null;
  let bestFit = -Infinity;
  let bestPerf: PerformanceMetrics | null = null;
  let bestTrades: TradeResult[] = [];
  let noImpr = 0;

  for (let gen = 0; gen < GENERATIONS; gen++) {
    const evals = await Promise.all(population.map(async (ind) => {
      const params: StrategyParams = { ...ind, SPREAD_PERCENT: 0.02 };
      const trades = await runBacktest(dogeData, params, initialCapital);
      const perf = await calculatePerformanceMetrics(trades, initialCapital);
      const fit = calculateFitness(perf);
      return { ind, perf, fit, trades };
    }));

    evals.sort((a, b) => b.fit - a.fit);
    const elite = evals.slice(0, Math.floor(POPULATION_SIZE * ELITISM_RATE)).map(e => e.ind);

    if (evals[0].fit > bestFit) {
      bestFit = evals[0].fit;
      bestInd = evals[0].ind;
      bestPerf = evals[0].perf;
      bestTrades = evals[0].trades;
      noImpr = 0;
      if (bestPerf) console.log(`New best Gen ${gen + 1}: fit=${bestFit.toFixed(3)} trades=${bestPerf.numberOfTrades} PF=${bestPerf.profitFactor.toFixed(2)} WR=${bestPerf.winRate.toFixed(1)} DD=${bestPerf.maxDrawdown.toFixed(1)}%`);
    } else {
      noImpr++;
    }

    if (noImpr >= CONVERGENCE_THRESHOLD && bestPerf && bestPerf.numberOfTrades > 10) {
      console.log('Early stop: converged.');
      break;
    }

    const fitnesses = evals.map(e => e.fit);
    const next: any[] = [...elite];
    while (next.length < POPULATION_SIZE) {
      const p1 = tournamentSelect(population, fitnesses, 3);
      const p2 = tournamentSelect(population, fitnesses, 3);
      let child = crossover(p1, p2);
      child = mutate(child, paramRanges);
      next.push(child);
    }
    population = next;
  }

  if (bestInd) {
    console.log('Optimization complete.');
    const bestParams: StrategyParams = { ...bestInd, SPREAD_PERCENT: 0.0 };
    return { bestParams, bestPerformance: bestPerf, bestTrades };
  } else {
    console.warn('GA did not find a suitable strategy.');
    return { bestParams: null, bestPerformance: null, bestTrades: [] };
  }
}

    