import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore } from '@/app/actions';
import type { Signal } from '@/lib/types';
import * as indicators from '@/lib/indicators';

// Extend Signal type to include new fields
interface EnhancedSignal extends Signal {
  suggestedLeverage?: number;
  stopBuffer?: number;
}

// STRATEGY CONFIGURATION
const DEBUG = true;

// System 1: Core Trend-Following (High Probability)
const EMA_FAST_PERIOD = 3;
const EMA_SLOW_PERIOD = 8;
const EMA_MEDIUM_PERIOD = 12;
const EMA_LONG_PERIOD = 21;
const PARABOLIC_SAR_STEP = 0.02;
const PARABOLIC_SAR_MAX = 0.2;
const TREND_CONFIRMATION_PERIOD = 2;

// System 2: Momentum-Reversal (Medium Probability)
const RSI_PERIOD = 8;
const RSI_OVERSOLD_THRESHOLD = 50;
const RSI_OVERBOUGHT_THRESHOLD = 70;
const DEEP_RSI_THRESHOLD = 28;
const DEEP_RSI_OVERBOUGHT = 100 - DEEP_RSI_THRESHOLD; // Added for symmetry: 72
const BBANDS_DEEP_MULTIPLIER = 2.0;
const BBANDS_PERIOD = 10;
const BBANDS_STD_DEV = 1.5;
const VOLUME_SPIKE_FACTOR = 1.2;
const MIN_CANDLE_BODY = 0.0001;

// System 3: Momentum Shift (Low Probability)
const RSI_CENTERLINE = 50;
const MIN_VOL_CHANGE = 1.5;

// Volatility Filter
const ATR_PERIOD = 5;
const MIN_ATR_THRESHOLD = 0.0002;
const LOW_VOL_THRESHOLD = 0.0008;
const AVG_ATR_MULTIPLIER = 1.03;

// Filters
const VOLUME_CONFIRMATION_FACTOR = 0.7;
const PRICE_POSITION_FILTER = 0.20;
const RSI_BUY_MAX = 60;
const RSI_SELL_MIN = 40;
const PSAR_BUFFER_FACTOR = 0.2;

export const revalidate = 0;

// Logging helpers
function log(...args: any[]) { if (DEBUG) console.log(...args); }
function section(title: string) { log(`\n=== ${title} ===`); }
function kv(obj: Record<string, any>) { log(JSON.stringify(obj, null, 2)); }
function logCond(name: string, passed: boolean, details?: string) {
  log(`  ${passed ? '✔' : '✘'} ${name}${details ? ` → ${details}` : ''}`);
}

// Main handler
export async function GET() {
  const ts = new Date().toISOString();
  section(`CRON RUN @ ${ts}`);

  try {
    // 1) Fetch data
    const chartData = await getChartData();
    const requiredPeriods = Math.max(
      EMA_SLOW_PERIOD, BBANDS_PERIOD, RSI_PERIOD, ATR_PERIOD, EMA_LONG_PERIOD
    );

    if (!Array.isArray(chartData) || chartData.length < requiredPeriods) {
      log(`Not enough data to calculate indicators. Have=${chartData?.length ?? 0} Need>=${requiredPeriods}`);
      return NextResponse.json({ message: 'Not enough data to calculate indicators.' });
    }

    // 2) Compute indicators once on full data for efficiency
    section('Compute Indicators (Full Data)');
    const closeSlice = chartData.map(d => d.close);
    const highSlice = chartData.map(d => d.high);
    const lowSlice = chartData.map(d => d.low);

    const emaFastArr = indicators.calculateEMA(closeSlice, EMA_FAST_PERIOD);
    const emaSlowArr = indicators.calculateEMA(closeSlice, EMA_SLOW_PERIOD);
    const emaMedArr = indicators.calculateEMA(closeSlice, EMA_MEDIUM_PERIOD);
    const emaLongArr = indicators.calculateEMA(closeSlice, EMA_LONG_PERIOD);
    const psarArr = indicators.calculateParabolicSAR(chartData, PARABOLIC_SAR_STEP, PARABOLIC_SAR_MAX);
    const vwapArr = indicators.calculateVWAP(chartData);
    const rsiArr = indicators.calculateRSI(closeSlice, RSI_PERIOD);
    const bb = indicators.calculateBollingerBands(closeSlice, BBANDS_PERIOD, BBANDS_STD_DEV);
    const deepBB = indicators.calculateBollingerBands(closeSlice, BBANDS_PERIOD, BBANDS_STD_DEV * BBANDS_DEEP_MULTIPLIER);
    const atrArr = indicators.calculateATR(highSlice, lowSlice, closeSlice, ATR_PERIOD);

    // Evaluate last 3 candles for signals
    type Cand = Omit<EnhancedSignal, 'displayTime' | 'serverTime'>;
    const candidates: Cand[] = [];
    let filterRejections = 0;

    for (let i = 0; i < Math.min(3, chartData.length); i++) {
      const currentIndex = chartData.length - 1 - i;
      const latest = chartData[currentIndex];
      const prev = chartData[currentIndex - 1] ?? latest;

      log('Latest candle:', {
        time: new Date(latest.time).toISOString(),
        open: Number(latest.open).toFixed(6),
        high: Number(latest.high).toFixed(6),
        low: Number(latest.low).toFixed(6),
        close: Number(latest.close).toFixed(6),
        volume: latest.volume
      });

      const getValueAt = (arr: (number | null)[], idx: number) => arr[idx] ?? null;
      const getPrevValueAt = (arr: (number | null)[], idx: number) => arr[idx - 1] ?? null;

      const cache = {
        emaFast: getValueAt(emaFastArr, currentIndex),
        emaSlow: getValueAt(emaSlowArr, currentIndex),
        emaMedium: getValueAt(emaMedArr, currentIndex),
        emaLong: getValueAt(emaLongArr, currentIndex),
        pSar: getValueAt(psarArr, currentIndex),
        vwap: getValueAt(vwapArr, currentIndex),
        rsi: getValueAt(rsiArr, currentIndex),
        prevRsi: getPrevValueAt(rsiArr, currentIndex),
        lowerBB: getValueAt(bb.lower, currentIndex),
        upperBB: getValueAt(bb.upper, currentIndex),
        deepLowerBB: getValueAt(deepBB.lower, currentIndex),
        deepUpperBB: getValueAt(deepBB.upper, currentIndex), // Added for deep sell
        atr: getValueAt(atrArr, currentIndex),
      };

      if (Object.values(cache).some(v => v === null || Number.isNaN(v))) {
        log('Indicator calculation incomplete:', cache);
        continue;
      }

      kv({
        emaFast: cache.emaFast, emaSlow: cache.emaSlow, emaMedium: cache.emaMedium, emaLong: cache.emaLong,
        pSar: cache.pSar, vwap: cache.vwap,
        rsi: cache.rsi, prevRsi: cache.prevRsi,
        lowerBB: cache.lowerBB, upperBB: cache.upperBB, deepLowerBB: cache.deepLowerBB, deepUpperBB: cache.deepUpperBB,
        atr: cache.atr
      });

      const isUptrend = latest.close > (cache.emaLong as number);
      const isDowntrend = latest.close < (cache.emaLong as number);
      const isLowVol = (cache.atr as number) < LOW_VOL_THRESHOLD;
      log('Trend/Volatility:', { isUptrend, isDowntrend, isLowVol });

      // Compute average ATR (using last 5 up to current)
      const recentAtrStart = Math.max(0, currentIndex - 4);
      const recentAtr = atrArr.slice(recentAtrStart, currentIndex + 1).filter(v => v !== null) as number[];
      const avgAtr = recentAtr.length > 0 ? recentAtr.reduce((s, v) => s + v, 0) / recentAtr.length : 0;
      log('ATR Debug:', { currentAtr: Number(cache.atr).toFixed(6), avgAtr: avgAtr.toFixed(6), threshold: (avgAtr * AVG_ATR_MULTIPLIER).toFixed(6) });

      // Volatility filter
      if ((cache.atr as number) < MIN_ATR_THRESHOLD && !isLowVol) {
        section('VOLATILITY FILTER');
        log(`✘ Market too flat: ATR ${Number(cache.atr).toFixed(6)} < ${MIN_ATR_THRESHOLD}`);
        filterRejections++;
        continue;
      }
      if ((cache.atr as number) < avgAtr * AVG_ATR_MULTIPLIER && !isLowVol) {
        section('VOLATILITY FILTER');
        log(`✘ Market too flat: ATR ${Number(cache.atr).toFixed(6)} < ${avgAtr * AVG_ATR_MULTIPLIER}`);
        filterRejections++;
        continue;
      }

      // Trend helpers
      const isIncreasing = (arr: (number | null)[], idx: number) => {
        const start = Math.max(0, idx - TREND_CONFIRMATION_PERIOD + 1);
        const slice = arr.slice(start, idx + 1);
        if (slice.some(v => v === null)) return false;
        for (let k = 1; k < slice.length; k++) if ((slice[k] as number) <= (slice[k - 1] as number)) return false;
        return true;
      };
      const isDecreasing = (arr: (number | null)[], idx: number) => {
        const start = Math.max(0, idx - TREND_CONFIRMATION_PERIOD + 1);
        const slice = arr.slice(start, idx + 1);
        if (slice.some(v => v === null)) return false;
        for (let k = 1; k < slice.length; k++) if ((slice[k] as number) >= (slice[k - 1] as number)) return false;
        return true;
      };

      // Volume average (last 5 up to current)
      const volStart = Math.max(0, currentIndex - 4);
      const recentVol = chartData.slice(volStart, currentIndex + 1);
      const volumeAvg = recentVol.reduce((s, d) => s + d.volume, 0) / recentVol.length;

      // EMA crossover checks
      const emaFastPrev = getPrevValueAt(emaFastArr, currentIndex);
      const emaSlowPrev = getPrevValueAt(emaSlowArr, currentIndex);
      const emaFastCrossedSlowUp = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev <= emaSlowPrev && (cache.emaFast as number) > (cache.emaSlow as number);
      const emaFastCrossedSlowDown = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev >= emaSlowPrev && (cache.emaFast as number) < (cache.emaSlow as number);

      // System 2: Momentum-Reversal
      section('System 2: Momentum-Reversal');

      // Deep Buy (Oversold Reversal in Downtrend)
      const deepBuyC1 = (cache.rsi as number) <= DEEP_RSI_THRESHOLD;
      const deepBuyC2 = latest.low <= (cache.deepLowerBB as number);
      const deepBuyC3 = (latest.close - latest.open) > MIN_CANDLE_BODY;
      const deepBuyC4 = latest.volume > (prev.volume ?? 0) * VOLUME_SPIKE_FACTOR;
      const deepBuyC5 = latest.close > (cache.pSar as number);
      const deepBuyC6 = isDowntrend; // Fixed: Require downtrend for reversal buy
      const deepBuyC7 = latest.close > (cache.emaFast as number);
      logCond(`RSI <= ${DEEP_RSI_THRESHOLD}`, deepBuyC1, `${Number(cache.rsi).toFixed(2)}`);
      logCond('Low <= DeepLowerBB', deepBuyC2, `${latest.low.toFixed(6)} vs ${(cache.deepLowerBB as number).toFixed(6)}`);
      logCond('Bullish body > MIN_CANDLE_BODY', deepBuyC3, `${(latest.close - latest.open).toFixed(6)} > ${MIN_CANDLE_BODY}`);
      logCond(`Volume > ${VOLUME_SPIKE_FACTOR}x prev`, deepBuyC4, `${latest.volume} vs ${prev.volume}`);
      logCond('Close > PSAR', deepBuyC5, `${latest.close.toFixed(6)} vs ${(cache.pSar as number).toFixed(6)}`);
      logCond('Downtrend (for reversal)', deepBuyC6);
      logCond('Close > EMA Fast', deepBuyC7, `${latest.close.toFixed(6)} > ${(cache.emaFast as number).toFixed(6)}`);
      const deepBuyTrueCount = [deepBuyC1, deepBuyC2, deepBuyC3, deepBuyC4, deepBuyC5, deepBuyC6, deepBuyC7].filter(Boolean).length;
      if (deepBuyTrueCount >= 6) { // Tightened to >=6 for more accuracy
        log('→ Candidate: HIGH BUY (Deep Oversold Reversal)');
        candidates.push({ type: 'BUY', level: 'High', price: latest.close, time: latest.time });
      }

      // Added: Deep Sell (Overbought Reversal in Uptrend) for symmetry
      const deepSellC1 = (cache.rsi as number) >= DEEP_RSI_OVERBOUGHT;
      const deepSellC2 = latest.high >= (cache.deepUpperBB as number);
      const deepSellC3 = (latest.open - latest.close) > MIN_CANDLE_BODY;
      const deepSellC4 = latest.volume > (prev.volume ?? 0) * VOLUME_SPIKE_FACTOR;
      const deepSellC5 = latest.close < (cache.pSar as number);
      const deepSellC6 = isUptrend; // Require uptrend for reversal sell
      const deepSellC7 = latest.close < (cache.emaFast as number);
      logCond(`RSI >= ${DEEP_RSI_OVERBOUGHT}`, deepSellC1, `${Number(cache.rsi).toFixed(2)}`);
      logCond('High >= DeepUpperBB', deepSellC2, `${latest.high.toFixed(6)} vs ${(cache.deepUpperBB as number).toFixed(6)}`);
      logCond('Bearish body > MIN_CANDLE_BODY', deepSellC3, `${(latest.open - latest.close).toFixed(6)} > ${MIN_CANDLE_BODY}`);
      logCond(`Volume > ${VOLUME_SPIKE_FACTOR}x prev`, deepSellC4, `${latest.volume} vs ${prev.volume}`);
      logCond('Close < PSAR', deepSellC5, `${latest.close.toFixed(6)} < ${(cache.pSar as number).toFixed(6)}`);
      logCond('Uptrend (for reversal)', deepSellC6);
      logCond('Close < EMA Fast', deepSellC7, `${latest.close.toFixed(6)} < ${(cache.emaFast as number).toFixed(6)}`);
      const deepSellTrueCount = [deepSellC1, deepSellC2, deepSellC3, deepSellC4, deepSellC5, deepSellC6, deepSellC7].filter(Boolean).length;
      if (deepSellTrueCount >= 6) {
        log('→ Candidate: HIGH SELL (Deep Overbought Reversal)');
        candidates.push({ type: 'SELL', level: 'High', price: latest.close, time: latest.time });
      }

      // Moderate Buy (Moderate Reversal in Downtrend)
      const modBuyC1 = (cache.prevRsi as number) < RSI_OVERSOLD_THRESHOLD;
      const modBuyC2 = (cache.rsi as number) > RSI_OVERSOLD_THRESHOLD;
      const modBuyC3 = latest.low <= (cache.lowerBB as number);
      const modBuyC4 = latest.close > (cache.vwap as number);
      const modBuyC5 = latest.close > (cache.lowerBB as number) * 1.001;
      const modBuyC6 = isDowntrend; // Fixed: Require downtrend for reversal buy
      const modBuyC7 = latest.close > (cache.emaFast as number);
      logCond(`Prev RSI < ${RSI_OVERSOLD_THRESHOLD}`, modBuyC1, `${Number(cache.prevRsi).toFixed(2)}`);
      logCond(`Curr RSI > ${RSI_OVERSOLD_THRESHOLD}`, modBuyC2, `${Number(cache.rsi).toFixed(2)}`);
      logCond('Low <= LowerBB', modBuyC3, `${latest.low.toFixed(6)} <= ${(cache.lowerBB as number).toFixed(6)}`);
      logCond('Close > VWAP', modBuyC4, `${latest.close.toFixed(6)} > ${(cache.vwap as number).toFixed(6)}`);
      logCond('Close > LowerBB + 0.1%', modBuyC5, `${latest.close.toFixed(6)} > ${((cache.lowerBB as number) * 1.001).toFixed(6)}`);
      logCond('Downtrend (for reversal)', modBuyC6);
      logCond('Close > EMA Fast', modBuyC7, `${latest.close.toFixed(6)} > ${(cache.emaFast as number).toFixed(6)}`);
      const modBuyTrueCount = [modBuyC1, modBuyC2, modBuyC3, modBuyC4, modBuyC5, modBuyC6, modBuyC7].filter(Boolean).length;
      if (modBuyTrueCount >= 6) { // Tightened to >=6
        log('→ Candidate: MEDIUM BUY (Moderate Reversal)');
        candidates.push({ type: 'BUY', level: 'Medium', price: latest.close, time: latest.time });
      }

      // Moderate Sell (Reversal in Uptrend)
      const revSellC1 = (cache.prevRsi as number) > RSI_OVERBOUGHT_THRESHOLD;
      const revSellC2 = (cache.rsi as number) < RSI_OVERBOUGHT_THRESHOLD;
      const revSellC3 = latest.high >= (cache.upperBB as number);
      const revSellC4 = latest.close < (cache.vwap as number);
      const revSellC5 = latest.close < (cache.upperBB as number) * 0.999;
      const revSellC6 = isUptrend; // Fixed: Require uptrend for reversal sell
      logCond('Prev RSI > Overbought', revSellC1, `${Number(cache.prevRsi).toFixed(2)} > ${RSI_OVERBOUGHT_THRESHOLD}`);
      logCond('Curr RSI < Overbought', revSellC2, `${Number(cache.rsi).toFixed(2)} < ${RSI_OVERBOUGHT_THRESHOLD}`);
      logCond('High >= UpperBB', revSellC3, `${latest.high.toFixed(6)} >= ${(cache.upperBB as number).toFixed(6)}`);
      logCond('Close < VWAP', revSellC4, `${latest.close.toFixed(6)} < ${(cache.vwap as number).toFixed(6)}`);
      logCond('Close < UpperBB - 0.1%', revSellC5, `${latest.close.toFixed(6)} < ${((cache.upperBB as number) * 0.999).toFixed(6)}`);
      logCond('Uptrend (for reversal)', revSellC6);
      const revSellTrueCount = [revSellC1, revSellC2, revSellC3, revSellC4, revSellC5, revSellC6].filter(Boolean).length;
      if (revSellTrueCount >= 5) {
        log('→ Candidate: MEDIUM SELL (Moderate Reversal)');
        candidates.push({ type: 'SELL', level: 'Medium', price: latest.close, time: latest.time });
      }

      // System 1: Core Trend-Following
      section('System 1: Core Trend-Following');
      const volumeOK = latest.volume > volumeAvg * VOLUME_CONFIRMATION_FACTOR;
      const volumeOK1 = latest.volume > volumeAvg * 1.2;
      const bbWidth = (cache.upperBB as number) - (cache.lowerBB as number);
      const pricePos = (latest.close - (cache.lowerBB as number)) / bbWidth;
      const priceInMiddle = pricePos > PRICE_POSITION_FILTER && pricePos < (1 - PRICE_POSITION_FILTER);
      const psarBuffer = (cache.atr as number) * PSAR_BUFFER_FACTOR;
      logCond(`Volume > ${VOLUME_CONFIRMATION_FACTOR*100}% of avg`, volumeOK, `${latest.volume} vs ${volumeAvg.toFixed(0)}`);
      logCond('Price in middle BB range', priceInMiddle, `pos ${(pricePos*100).toFixed(1)}%`);
      logCond('PSAR Buffer', true, `${psarBuffer.toFixed(6)} (${(PSAR_BUFFER_FACTOR*100).toFixed(0)}% ATR)`);
      logCond(`Volume > 1.2x avg`, volumeOK1, `${latest.volume} vs ${volumeAvg.toFixed(0)}`);

      let coreBuyC1: boolean;
      if (isLowVol) {
        coreBuyC1 = (cache.emaFast as number) > (cache.emaSlow as number) && emaFastCrossedSlowUp;
        logCond('LowVol: EMA(3) > EMA(8) + Crossover', coreBuyC1, `${(cache.emaFast as number).toFixed(6)} > ${(cache.emaSlow as number).toFixed(6)}`);
      } else {
        coreBuyC1 = (cache.emaFast as number) > (cache.emaSlow as number) && (cache.emaSlow as number) > (cache.emaMedium as number) && emaFastCrossedSlowUp;
        logCond('EMA(3) > EMA(8) > EMA(12) + Crossover', coreBuyC1, `${(cache.emaFast as number).toFixed(6)} > ${(cache.emaSlow as number).toFixed(6)} > ${(cache.emaMedium as number).toFixed(6)}`);
      }
      const coreBuyC2 = latest.close > (cache.vwap as number);
      const coreBuyC3 = latest.close > ((cache.pSar as number) + psarBuffer);
      const coreBuyC4 = (cache.rsi as number) < RSI_BUY_MAX;
      const coreBuyC5 = isIncreasing(emaFastArr, currentIndex) && isIncreasing(emaSlowArr, currentIndex);
      const coreBuyC6 = isUptrend;
      logCond('Close > VWAP', coreBuyC2, `${latest.close.toFixed(6)} > ${(cache.vwap as number).toFixed(6)}`);
      logCond('Close > PSAR + buffer', coreBuyC3, `${latest.close.toFixed(6)} > ${((cache.pSar as number)+psarBuffer).toFixed(6)}`);
      logCond(`RSI < ${RSI_BUY_MAX}`, coreBuyC4, `${(cache.rsi as number).toFixed(2)}`);
      logCond(`EMA uptrend last ${TREND_CONFIRMATION_PERIOD}`, coreBuyC5);
      logCond('Uptrend (price > EMA21)', coreBuyC6);

      let coreSellC1: boolean;
      if (isLowVol) {
        coreSellC1 = (cache.emaFast as number) < (cache.emaSlow as number) && emaFastCrossedSlowDown;
        logCond('LowVol: EMA(3) < EMA(8) + Crossover', coreSellC1, `${(cache.emaFast as number).toFixed(6)} < ${(cache.emaSlow as number).toFixed(6)}`);
      } else {
        coreSellC1 = (cache.emaFast as number) < (cache.emaSlow as number) && (cache.emaSlow as number) < (cache.emaMedium as number) && emaFastCrossedSlowDown;
        logCond('EMA(3) < EMA(8) < EMA(12) + Crossover', coreSellC1, `${(cache.emaFast as number).toFixed(6)} < ${(cache.emaSlow as number).toFixed(6)} < ${(cache.emaMedium as number).toFixed(6)}`);
      }
      const coreSellC2 = latest.close < (cache.vwap as number);
      const coreSellC3 = latest.close < ((cache.pSar as number) - psarBuffer);
      const coreSellC4 = (cache.rsi as number) > RSI_SELL_MIN;
      const coreSellC5 = isDecreasing(emaFastArr, currentIndex) && isDecreasing(emaSlowArr, currentIndex);
      const coreSellC6 = isDowntrend;
      logCond('Close < VWAP', coreSellC2, `${latest.close.toFixed(6)} < ${(cache.vwap as number).toFixed(6)}`);
      logCond('Close < PSAR - buffer', coreSellC3, `${latest.close.toFixed(6)} < ${((cache.pSar as number)-psarBuffer).toFixed(6)}`);
      logCond(`RSI > ${RSI_SELL_MIN}`, coreSellC4, `${(cache.rsi as number).toFixed(2)}`);
      logCond(`EMA downtrend last ${TREND_CONFIRMATION_PERIOD}`, coreSellC5);
      logCond('Downtrend (price < EMA21)', coreSellC6);

      if (coreBuyC1 && coreBuyC2 && coreBuyC3 && coreBuyC4 && coreBuyC5 && coreBuyC6 && volumeOK && volumeOK1 && priceInMiddle) {
        log('→ Candidate: HIGH BUY (Core Trend-Following)');
        candidates.push({ type: 'BUY', level: 'High', price: latest.close, time: latest.time });
      }
      if (coreSellC1 && coreSellC2 && coreSellC3 && coreSellC4 && coreSellC5 && coreSellC6 && volumeOK && volumeOK1 && priceInMiddle) {
        log('→ Candidate: HIGH SELL (Core Trend-Following)');
        candidates.push({ type: 'SELL', level: 'High', price: latest.close, time: latest.time });
      }

      // System 3: Momentum Shift
      section('System 3: Momentum Shift');
      const volUp = latest.volume > (prev.volume ?? 0) * MIN_VOL_CHANGE;
      const shiftBuyC1 = (cache.prevRsi as number) < RSI_CENTERLINE;
      const shiftBuyC2 = (cache.rsi as number) > RSI_CENTERLINE;
      const shiftBuyC3 = volUp;
      const shiftBuyC4 = latest.close > (cache.vwap as number);
      const shiftBuyC5 = isUptrend;
      logCond('Prev RSI < 50', shiftBuyC1, `${Number(cache.prevRsi).toFixed(2)}`);
      logCond('Curr RSI > 50', shiftBuyC2, `${Number(cache.rsi).toFixed(2)}`);
      logCond(`Volume > ${MIN_VOL_CHANGE}x prev`, shiftBuyC3, `${latest.volume} vs ${prev.volume}`);
      logCond('Close > VWAP', shiftBuyC4, `${latest.close.toFixed(6)} > ${(cache.vwap as number).toFixed(6)}`);
      logCond('Uptrend', shiftBuyC5);
      if (shiftBuyC1 && shiftBuyC2 && shiftBuyC3 && shiftBuyC4 && shiftBuyC5) {
        log('→ Candidate: LOW BUY (RSI Centerline Cross)');
        candidates.push({ type: 'BUY', level: 'Low', price: latest.close, time: latest.time });
      }

      const shiftSellC1 = (cache.prevRsi as number) > RSI_CENTERLINE;
      const shiftSellC2 = (cache.rsi as number) < RSI_CENTERLINE;
      const shiftSellC3 = volUp;
      const shiftSellC4 = latest.close < (cache.vwap as number);
      const shiftSellC5 = isDowntrend;
      logCond('Prev RSI > 50', shiftSellC1, `${Number(cache.prevRsi).toFixed(2)}`);
      logCond('Curr RSI < 50', shiftSellC2, `${Number(cache.rsi).toFixed(2)}`);
      logCond(`Volume > ${MIN_VOL_CHANGE}x prev`, shiftSellC3, `${latest.volume} vs ${prev.volume}`);
      logCond('Close < VWAP', shiftSellC4, `${latest.close.toFixed(6)} < ${(cache.vwap as number).toFixed(6)}`);
      logCond('Downtrend', shiftSellC5);
      if (shiftSellC1 && shiftSellC2 && shiftSellC3 && shiftSellC4 && shiftSellC5) {
        log('→ Candidate: LOW SELL (RSI Centerline Cross)');
        candidates.push({ type: 'SELL', level: 'Low', price: latest.close, time: latest.time });
      }

      // BB Width Filter
      section('BB Width Filter');
      const atrThreshold = (cache.atr as number) * 1.5;
      if (bbWidth < atrThreshold) {
        log(`✘ BB Width too tight: ${bbWidth.toFixed(6)} < ${atrThreshold.toFixed(6)}`);
        continue;
      }
    }

    // Log filter rejections
    log(`Volatility filter rejections: ${filterRejections}`);

    // Selection & Post filters
    section('Selection');
    if (!candidates.length) {
      log('No candidates from any system.');
      return NextResponse.json({ message: 'No signal generated.' });
    }

    const priority = { High: 3, Medium: 2, Low: 1 } as const;
    candidates.sort((a, b) => priority[b.level as keyof typeof priority] - priority[a.level as keyof typeof priority]);
    log('Candidates sorted (best first):', candidates);
    let newSignal = candidates[0];
    log('Selected:', newSignal);

    // Use the most recent candle and cache for final checks
    const latest = chartData.at(-1)!;
    const prev = chartData.at(-2) ?? latest;
    const currentIndex = chartData.length - 1;
    const cache = {
      emaFast: emaFastArr[currentIndex],
      emaSlow: emaSlowArr[currentIndex],
      emaMedium: emaMedArr[currentIndex],
      emaLong: emaLongArr[currentIndex],
      pSar: psarArr[currentIndex],
      vwap: vwapArr[currentIndex],
      rsi: rsiArr[currentIndex],
      prevRsi: rsiArr[currentIndex - 1] ?? null,
      lowerBB: bb.lower[currentIndex],
      upperBB: bb.upper[currentIndex],
      deepLowerBB: deepBB.lower[currentIndex],
      deepUpperBB: deepBB.upper[currentIndex],
      atr: atrArr[currentIndex],
    };

    const recentAtr = atrArr.slice(-5).filter(v => v !== null) as number[];
    const avgAtr = recentAtr.length > 0 ? recentAtr.reduce((s, v) => s + v, 0) / recentAtr.length : 0;

    if (Object.values(cache).some(v => v === null || Number.isNaN(v))) {
      log('Final indicator calculation incomplete:', cache);
      return NextResponse.json({ message: 'Final indicator calculation incomplete.' });
    }

    // Price Action Confirmation
    section('Price Action Confirmation');
    if (newSignal.type === 'BUY') {
      const ok = latest.close > prev.close * 1.0001;
      logCond('BUY must exceed prev close + 0.01%', ok, `${latest.close.toFixed(6)} > ${(prev.close * 1.0001).toFixed(6)}`); // Fixed log to match condition
      if (!ok) return NextResponse.json({ message: 'Signal unconfirmed by price action (BUY).' });
    } else {
      const ok = latest.close < prev.close * 0.9999;
      logCond('SELL must break prev close - 0.01%', ok, `${latest.close.toFixed(6)} < ${(prev.close * 0.9999).toFixed(6)}`); // Fixed log
      if (!ok) return NextResponse.json({ message: 'Signal unconfirmed by price action (SELL).' });
    }

    // Duplicate Prevention
    section('Duplicate Prevention');
    const lastSignals = await getSignalHistoryFromFirestore();
    const lastSignal = lastSignals?.[0] ?? null;
    if (lastSignal) {
      const priceBps = Math.abs(lastSignal.price - newSignal.price) / newSignal.price * 10000;
      const timeDeltaMin = Math.abs(Number(newSignal.time) - Number(lastSignal.time)) / 60000;
      const isOpposite = lastSignal.type !== newSignal.type;
      const atrAvgOk = (cache.atr as number) > avgAtr;
      log('Last signal:', lastSignal);
      log('New vs Last:', { priceBps: priceBps.toFixed(2), timeDeltaMin: timeDeltaMin.toFixed(2), isOpposite, atrAvgOk });
      if (lastSignal.type === newSignal.type && lastSignal.level === newSignal.level && priceBps < 1 && timeDeltaMin < 3) {
        log('✘ Duplicate skipped (same direction+level, <1 bps diff, <3 min).');
        return NextResponse.json({ message: 'Duplicate signal skipped.' });
      }
      if (isOpposite && timeDeltaMin < 10 && !atrAvgOk) {
        log('✘ Opposite signal skipped (within 10 min, ATR not above avg).');
        return NextResponse.json({ message: 'Opposite signal skipped due to low volatility.' });
      }
    } else {
      log('No previous signals found.');
    }

    // Save Signal
    const suggestedLeverage = Math.min(20, 1 / ((cache.atr as number) / latest.close * 100));
    const stopBuffer = (cache.atr as number) * 1.5;
    const enhancedSignal: EnhancedSignal = { ...newSignal, suggestedLeverage, stopBuffer };
    section('Save Signal');
    await saveSignalToFirestore(enhancedSignal);
    log('✓ Signal saved:', enhancedSignal);
    return NextResponse.json({ signal: enhancedSignal });

  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: String(err) });
  }
}