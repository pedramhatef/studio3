import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore } from '@/app/actions';
import type { Signal } from '@/lib/types';
import * as indicators from '@/lib/indicators';

// =================================================================================
// STRATEGY CONFIGURATION (same systems preserved) + VERBOSE DEBUG LOGGING
// =================================================================================

// Toggle verbose logging
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
const RSI_OVERSOLD_THRESHOLD = 35;
const RSI_OVERBOUGHT_THRESHOLD = 65;
const DEEP_RSI_THRESHOLD = 28;
const BBANDS_DEEP_MULTIPLIER = 2.0;
const BBANDS_PERIOD = 10;
const BBANDS_STD_DEV = 1.5;
const VOLUME_SPIKE_FACTOR = 1.5;
const MIN_CANDLE_BODY = 0.00015;

// System 3: Momentum Shift (Low Probability)
const RSI_CENTERLINE = 50;
const MIN_VOL_CHANGE = 1.3;

// Volatility Filter
const ATR_PERIOD = 7;
const MIN_ATR_THRESHOLD = 0.0002; // slightly loosened
const LOW_VOL_THRESHOLD = 0.0003;  // slightly loosened

// Filters
const VOLUME_CONFIRMATION_FACTOR = 0.85;
const PRICE_POSITION_FILTER = 0.20; // Loosened from 0.30
const RSI_BUY_MAX = 60;
const RSI_SELL_MIN = 40;
const PSAR_BUFFER_FACTOR = 0.2; // 30% of ATR

export const revalidate = 0;

// =================================================================================
// Logging helpers
// =================================================================================
function log(...args: any[]) { if (DEBUG) console.log(...args); }
function section(title: string) { log(`\n=== ${title} ===`); }
function kv(obj: Record<string, any>) { log(JSON.stringify(obj, null, 2)); }
function logCond(name: string, passed: boolean, details?: string) {
  log(`  ${passed ? '✔' : '✘'} ${name}${details ? ` → ${details}` : ''}`);
}

// =================================================================================
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

    const close = chartData.map(d => d.close);
    const high = chartData.map(d => d.high);
    const low  = chartData.map(d => d.low);
    const latest = chartData.at(-1)!;
    const prev   = chartData.at(-2)!;

    log('Latest candle:', {
      time: new Date(latest.time).toISOString(),
      open: Number(latest.open).toFixed(6),
      high: Number(latest.high).toFixed(6),
      low:  Number(latest.low).toFixed(6),
      close:Number(latest.close).toFixed(6),
      volume: latest.volume
    });

    // 2) Indicators (cached)
    section('Compute Indicators');
    const emaFastArr   = indicators.calculateEMA(close, EMA_FAST_PERIOD);
    const emaSlowArr   = indicators.calculateEMA(close, EMA_SLOW_PERIOD);
    const emaMedArr    = indicators.calculateEMA(close, EMA_MEDIUM_PERIOD);
    const emaLongArr   = indicators.calculateEMA(close, EMA_LONG_PERIOD);
    const psarArr      = indicators.calculateParabolicSAR(chartData, PARABOLIC_SAR_STEP, PARABOLIC_SAR_MAX);
    const vwapArr      = indicators.calculateVWAP(chartData);
    const rsiArr       = indicators.calculateRSI(close, RSI_PERIOD);
    const bb           = indicators.calculateBollingerBands(close, BBANDS_PERIOD, BBANDS_STD_DEV);
    const deepBB       = indicators.calculateBollingerBands(close, BBANDS_PERIOD, BBANDS_STD_DEV * BBANDS_DEEP_MULTIPLIER);
    const atrArr       = indicators.calculateATR(high, low, close, ATR_PERIOD);

    const getLastValue = (arr: (number|null)[]) => arr.at(-1) ?? null;
    const getPrevValue = (arr: (number|null)[]) => arr.at(-2) ?? null;
    
    const cache = {
      emaFast:  getLastValue(emaFastArr),
      emaSlow:  getLastValue(emaSlowArr),
      emaMedium:getLastValue(emaMedArr),
      emaLong:  getLastValue(emaLongArr),
      pSar:     getLastValue(psarArr),
      vwap:     getLastValue(vwapArr),
      rsi:      getLastValue(rsiArr),
      prevRsi:  getPrevValue(rsiArr),
      lowerBB:  getLastValue(bb.lower),
      upperBB:  getLastValue(bb.upper),
      deepLowerBB: getLastValue(deepBB.lower),
      atr:      getLastValue(atrArr),
    };
    

    if (Object.values(cache).some(v => v === null || Number.isNaN(v))) {
      log('Indicator calculation incomplete:', cache);
      return NextResponse.json({ message: 'Indicator calculation incomplete.' });
    }

    kv({
      emaFast: cache.emaFast, emaSlow: cache.emaSlow, emaMedium: cache.emaMedium, emaLong: cache.emaLong,
      pSar: cache.pSar, vwap: cache.vwap,
      rsi: cache.rsi, prevRsi: cache.prevRsi,
      lowerBB: cache.lowerBB, upperBB: cache.upperBB, deepLowerBB: cache.deepLowerBB,
      atr: cache.atr
    });

    const isUptrend = latest.close > (cache.emaLong as number);
    const isDowntrend = latest.close < (cache.emaLong as number);
    const isLowVol = (cache.atr as number) < LOW_VOL_THRESHOLD;
    log('Trend/Volatility:', { isUptrend, isDowntrend, isLowVol });

    // Optional global low ATR kill-switch
    if ((cache.atr as number) < MIN_ATR_THRESHOLD) {
      section('VOLATILITY FILTER');
      log(`✘ Market too flat: ATR ${Number(cache.atr).toFixed(6)} < ${MIN_ATR_THRESHOLD}`);
      return NextResponse.json({ message: 'No signal generated due to low volatility (ATR).' });
    }

    // Trend helpers
    const isIncreasing = (arr: (number|null)[]) => {
      const slice = arr.slice(-TREND_CONFIRMATION_PERIOD);
      if (slice.some(v => v === null)) return false;
      for (let i = 1; i < slice.length; i++) if ((slice[i] as number) <= (slice[i-1] as number)) return false;
      return true;
    };
    const isDecreasing = (arr: (number|null)[]) => {
      const slice = arr.slice(-TREND_CONFIRMATION_PERIOD);
      if (slice.some(v => v === null)) return false;
      for (let i = 1; i < slice.length; i++) if ((slice[i] as number) >= (slice[i-1] as number)) return false;
      return true;
    };

    const volumeAvg = chartData.slice(-5).reduce((s, d) => s + d.volume, 0) / 5;

    // =================================================================
    // Evaluate ALL systems with full logging
    // =================================================================
    type Cand = Omit<Signal, 'displayTime' | 'serverTime'>;
    const candidates: Cand[] = [];

    // ---------------------------
    section('System 2: Momentum-Reversal');
    // Deep Oversold Reversal (High)
    const deepBuyC1 = (cache.rsi as number) <= DEEP_RSI_THRESHOLD;
    const deepBuyC2 = latest.low <= (cache.deepLowerBB as number);
    const deepBuyC3 = (latest.close - latest.open) > MIN_CANDLE_BODY;
    const deepBuyC4 = latest.volume > (prev?.volume ?? 0) * VOLUME_SPIKE_FACTOR;
    const deepBuyC5 = latest.close > (cache.pSar as number);
    
    logCond(`RSI <= ${DEEP_RSI_THRESHOLD}`, deepBuyC1, `${Number(cache.rsi).toFixed(2)}`);
    logCond('Low <= DeepLowerBB', deepBuyC2, `${latest.low.toFixed(6)} vs ${(cache.deepLowerBB as number).toFixed(6)}`);
    logCond('Bullish body > MIN_CANDLE_BODY', deepBuyC3, `${(latest.close - latest.open).toFixed(6)} > ${MIN_CANDLE_BODY}`);
    logCond(`Volume > ${VOLUME_SPIKE_FACTOR}x prev`, deepBuyC4, `${latest.volume} vs ${prev?.volume}`);
    logCond('Close > PSAR', deepBuyC5, `${latest.close.toFixed(6)} vs ${(cache.pSar as number).toFixed(6)}`);

    if (deepBuyC1 && deepBuyC2 && deepBuyC3 && deepBuyC4 && deepBuyC5 ) {
      log('→ Candidate: HIGH BUY (Deep Oversold Reversal)');
      candidates.push({ type: 'BUY', level: 'High', price: latest.close, time: latest.time });
    }

    // Moderate Reversal BUY (Medium)
    const modBuyC1 = (cache.prevRsi as number) < RSI_OVERSOLD_THRESHOLD;
    const modBuyC2 = (cache.rsi as number) > RSI_OVERSOLD_THRESHOLD;
    const modBuyC3 = latest.low <= (cache.lowerBB as number);
    const modBuyC4 = latest.close > (cache.vwap as number);
    const modBuyC5 = latest.close > (cache.lowerBB as number) * 1.001;

    logCond(`Prev RSI < ${RSI_OVERSOLD_THRESHOLD}`, modBuyC1, `${Number(cache.prevRsi).toFixed(2)}`);
    logCond(`Curr RSI > ${RSI_OVERSOLD_THRESHOLD}`, modBuyC2, `${Number(cache.rsi).toFixed(2)}`);
    logCond('Low <= LowerBB', modBuyC3, `${latest.low.toFixed(6)} <= ${(cache.lowerBB as number).toFixed(6)}`);
    logCond('Close > VWAP', modBuyC4, `${latest.close.toFixed(6)} > ${(cache.vwap as number).toFixed(6)}`);
    logCond('Close > LowerBB + 0.1%', modBuyC5, `${latest.close.toFixed(6)} > ${((cache.lowerBB as number) * 1.001).toFixed(6)}`);

    if (modBuyC1 && modBuyC2 && modBuyC3 && modBuyC4 && modBuyC5 ) {
      log('→ Candidate: MEDIUM BUY (Moderate Reversal)');
      candidates.push({ type: 'BUY', level: 'Medium', price: latest.close, time: latest.time });
    }

    // Reversal SELL (Medium)
    const revSellC1 = (cache.prevRsi as number) > RSI_OVERBOUGHT_THRESHOLD;
    const revSellC2 = (cache.rsi as number) < RSI_OVERBOUGHT_THRESHOLD;
    const revSellC3 = latest.high >= (cache.upperBB as number);
    const revSellC4 = latest.close < (cache.vwap as number);
    const revSellC5 = latest.close < (cache.upperBB as number) * 0.999;
    const revSellC6 = isDowntrend;

    logCond('Prev RSI > Overbought', revSellC1, `${Number(cache.prevRsi).toFixed(2)} > ${RSI_OVERBOUGHT_THRESHOLD}`);
    logCond('Curr RSI < Overbought', revSellC2, `${Number(cache.rsi).toFixed(2)} < ${RSI_OVERBOUGHT_THRESHOLD}`);
    logCond('High >= UpperBB', revSellC3, `${latest.high.toFixed(6)} >= ${(cache.upperBB as number).toFixed(6)}`);
    logCond('Close < VWAP', revSellC4, `${latest.close.toFixed(6)} < ${(cache.vwap as number).toFixed(6)}`);
    logCond('Close < UpperBB - 0.1%', revSellC5, `${latest.close.toFixed(6)} < ${((cache.upperBB as number) * 0.999).toFixed(6)}`);
    logCond('Downtrend', revSellC6);
    if (revSellC1 && revSellC2 && revSellC3 && revSellC4 && revSellC5 && revSellC6) {
      log('→ Candidate: MEDIUM SELL (Reversal)');
      candidates.push({ type: 'SELL', level: 'Medium', price: latest.close, time: latest.time });
    }

    // ---------------------------
    section('System 1: Core Trend-Following');
    const volumeOK = latest.volume > volumeAvg * VOLUME_CONFIRMATION_FACTOR;
    const volumeOK1 = latest.volume > volumeAvg * 1.2
    const bbWidth = (cache.upperBB as number) - (cache.lowerBB as number);
    const pricePos = (latest.close - (cache.lowerBB as number)) / bbWidth;
    const priceInMiddle = pricePos > PRICE_POSITION_FILTER && pricePos < (1 - PRICE_POSITION_FILTER);
    const psarBuffer = (cache.atr as number) * PSAR_BUFFER_FACTOR;
    logCond(`Volume > ${VOLUME_CONFIRMATION_FACTOR*100}% of avg`, volumeOK, `${latest.volume} vs ${volumeAvg.toFixed(0)}`);
    logCond('Price in middle BB range', priceInMiddle, `pos ${(pricePos*100).toFixed(1)}%`);
    logCond('PSAR Buffer', true, `${psarBuffer.toFixed(6)} (${(PSAR_BUFFER_FACTOR*100).toFixed(0)}% ATR)`);
    logCond(`Volume > ${1.2}% of avg`, volumeOK1, `${latest.volume} vs ${volumeAvg.toFixed(0)}`);


    let coreBuyC1: boolean;
    if (isLowVol) {
      coreBuyC1 = (cache.emaFast as number) > (cache.emaSlow as number);
      logCond('LowVol: EMA(5) > EMA(13)', coreBuyC1, `${(cache.emaFast as number).toFixed(6)} > ${(cache.emaSlow as number).toFixed(6)}`);
    } else {
      coreBuyC1 = (cache.emaFast as number) > (cache.emaSlow as number) && (cache.emaSlow as number) > (cache.emaMedium as number);
      logCond('EMA(5) > EMA(13) > EMA(20)', coreBuyC1, `${(cache.emaFast as number).toFixed(6)} > ${(cache.emaSlow as number).toFixed(6)} > ${(cache.emaMedium as number).toFixed(6)}`);
    }
    const coreBuyC2 = latest.close > (cache.vwap as number);
    const coreBuyC3 = latest.close > ((cache.pSar as number) + psarBuffer);
    const coreBuyC4 = (cache.rsi as number) < RSI_BUY_MAX;
    const coreBuyC5 = isIncreasing(emaFastArr) && isIncreasing(emaSlowArr);
    const coreBuyC6 = isUptrend;
    logCond('Close > VWAP', coreBuyC2, `${latest.close.toFixed(6)} > ${(cache.vwap as number).toFixed(6)}`);
    logCond('Close > PSAR + buffer', coreBuyC3, `${latest.close.toFixed(6)} > ${((cache.pSar as number)+psarBuffer).toFixed(6)}`);
    logCond(`RSI < ${RSI_BUY_MAX}`, coreBuyC4, `${(cache.rsi as number).toFixed(2)}`);
    logCond(`EMA uptrend last ${TREND_CONFIRMATION_PERIOD}`, coreBuyC5);
    logCond('Uptrend (price > EMA50)', coreBuyC6);

    let coreSellC1: boolean;
    if (isLowVol) {
      coreSellC1 = (cache.emaFast as number) < (cache.emaSlow as number);
      logCond('LowVol: EMA(5) < EMA(13)', coreSellC1, `${(cache.emaFast as number).toFixed(6)} < ${(cache.emaSlow as number).toFixed(6)}`);
    } else {
      coreSellC1 = (cache.emaFast as number) < (cache.emaSlow as number) && (cache.emaSlow as number) < (cache.emaMedium as number);
      logCond('EMA(5) < EMA(13) < EMA(20)', coreSellC1, `${(cache.emaFast as number).toFixed(6)} < ${(cache.emaSlow as number).toFixed(6)} < ${(cache.emaMedium as number).toFixed(6)}`);
    }
    const coreSellC2 = latest.close < (cache.vwap as number);
    const coreSellC3 = latest.close < ((cache.pSar as number) - psarBuffer);
    const coreSellC4 = (cache.rsi as number) > RSI_SELL_MIN;
    const coreSellC5 = isDecreasing(emaFastArr) && isDecreasing(emaSlowArr);
    const coreSellC6 = isDowntrend;
    logCond('Close < VWAP', coreSellC2, `${latest.close.toFixed(6)} < ${(cache.vwap as number).toFixed(6)}`);
    logCond('Close < PSAR - buffer', coreSellC3, `${latest.close.toFixed(6)} < ${((cache.pSar as number)-psarBuffer).toFixed(6)}`);
    logCond(`RSI > ${RSI_SELL_MIN}`, coreSellC4, `${(cache.rsi as number).toFixed(2)}`);
    logCond(`EMA downtrend last ${TREND_CONFIRMATION_PERIOD}`, coreSellC5);
    logCond('Downtrend (price < EMA50)', coreSellC6);

    if (coreBuyC1 && coreBuyC2 && coreBuyC3 && coreBuyC4 && coreBuyC5 && coreBuyC6 && volumeOK && volumeOK1 && priceInMiddle) {
      log('→ Candidate: HIGH BUY (Core Trend-Following)');
      candidates.push({ type: 'BUY', level: 'High', price: latest.close, time: latest.time });
    }
    if (coreSellC1 && coreSellC2 && coreSellC3 && coreSellC4 && coreSellC5 && coreSellC6 && volumeOK && volumeOK1 && priceInMiddle) {
      log('→ Candidate: HIGH SELL (Core Trend-Following)');
      candidates.push({ type: 'SELL', level: 'High', price: latest.close, time: latest.time });
    }

    // ---------------------------
    section('System 3: Momentum Shift');
    const volUp = latest.volume > (prev?.volume ?? 0) * MIN_VOL_CHANGE;
    const shiftBuyC1 = (cache.prevRsi as number) < RSI_CENTERLINE;
    const shiftBuyC2 = (cache.rsi as number) > RSI_CENTERLINE;
    const shiftBuyC3 = volUp;
    const shiftBuyC4 = latest.close > (cache.vwap as number);
    const shiftBuyC5 = isUptrend;
    logCond('Prev RSI < 50', shiftBuyC1, `${Number(cache.prevRsi).toFixed(2)}`);
    logCond('Curr RSI > 50', shiftBuyC2, `${Number(cache.rsi).toFixed(2)}`);
    logCond(`Volume > ${MIN_VOL_CHANGE}x prev`, shiftBuyC3, `${latest.volume} vs ${prev?.volume}`);
    logCond('Close > VWAP', shiftBuyC4, `${latest.close.toFixed(6)} > ${(cache.vwap as number).toFixed(6)}`);
    logCond('Uptrend', shiftBuyC5);
    if (shiftBuyC1 && shiftBuyC2 && shiftBuyC3 && shiftBuyC4 && shiftBuyC5) {
      log('→ Candidate: LOW BUY (RSI Centerline Cross)');
      candidates.push({ type: 'BUY', level: 'Low', price: latest.close, time: latest.time });
    }

    const shiftSellC1 = (cache.prevRsi as number) > RSI_CENTERLINE;
    const shiftSellC2 = (cache.rsi as number) < RSI_CENTERLINE;
    const shiftSellC4 = latest.close < (cache.vwap as number);
    const shiftSellC5 = isDowntrend;
    logCond('Prev RSI > 50', shiftSellC1, `${Number(cache.prevRsi).toFixed(2)}`);
    logCond('Curr RSI < 50', shiftSellC2, `${Number(cache.rsi).toFixed(2)}`);
    logCond('Close < VWAP', shiftSellC4, `${latest.close.toFixed(6)} < ${(cache.vwap as number).toFixed(6)}`);
    logCond('Downtrend', shiftSellC5);
    if (shiftSellC1 && shiftSellC2 && shiftSellC4 && shiftSellC5) {
      log('→ Candidate: LOW SELL (RSI Centerline Cross)');
      candidates.push({ type: 'SELL', level: 'Low', price: latest.close, time: latest.time });
    }

    // =================================================================
    // Selection & Post filters
    // =================================================================
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

    // Price action confirmation (same rule you had)
    section('Price Action Confirmation');
    if (newSignal.type === 'BUY') {
      const ok = latest.close > prev.high * 1.0005;
      logCond('BUY must break prev high', ok, `${latest.close.toFixed(6)} > ${prev.high.toFixed(6)}`);
      if (!ok) return NextResponse.json({ message: 'Signal unconfirmed by price action (BUY).' });
    } else {
      const ok = latest.close < prev.low * 1.0005;
      logCond('SELL must break prev low', ok, `${latest.close.toFixed(6)} < ${prev.low.toFixed(6)}`);
      if (!ok) return NextResponse.json({ message: 'Signal unconfirmed by price action (SELL).' });
    }

    // Duplicate prevention (type+level+price proximity+time window)
    section('Duplicate Prevention');
    const lastSignals = await getSignalHistoryFromFirestore();
    const lastSignal = lastSignals?.[0] ?? null; // Renamed to lastSignal
    if (lastSignal) {
      // Use lastSignal instead of last
      const priceBps = Math.abs(lastSignal.price - newSignal.price) / newSignal.price * 10000;
      const timeDeltaMin = Math.abs(Number(newSignal.time) - Number(lastSignal.time)) / 60000;
      
      log('Last signal:', lastSignal);
      log('New vs Last:', { priceBps: priceBps.toFixed(2), timeDeltaMin: timeDeltaMin.toFixed(2) });
      
      if (lastSignal.type === newSignal.type && 
          lastSignal.level === newSignal.level && 
          priceBps < 1 && 
          timeDeltaMin < 3 && 
          bbWidth < ATR_PERIOD * 1.5) {
        log('✘ Duplicate skipped (same direction+level, <1 bps diff, <3 min, bbWidth < ATR_PERIOD * 1.5 ).');
        return NextResponse.json({ message: 'Duplicate signal skipped.' });
      }
    } else {
      log('No previous signals found.');
    }
    

    // Save
    section('Save Signal');
    await saveSignalToFirestore(newSignal);
    log('✓ Signal saved:', newSignal);
    return NextResponse.json({ signal: newSignal });

  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: String(err) });
  }
}
