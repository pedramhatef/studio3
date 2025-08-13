import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore } from '@/app/actions';
import type { Signal } from '@/lib/types';
import * as indicators from '@/lib/indicators';

// =================================================================================
// STRATEGY CONFIGURATION
// =================================================================================

// System 1: Core Trend-Following (High Probability)
const EMA_FAST_PERIOD = 5;
const EMA_SLOW_PERIOD = 13;
const EMA_MEDIUM_PERIOD = 20;
const EMA_LONG_PERIOD = 50;
const PARABOLIC_SAR_STEP = 0.02;
const PARABOLIC_SAR_MAX = 0.2;
const TREND_CONFIRMATION_PERIOD = 3;

// System 2: Momentum-Reversal (Medium Probability)
const RSI_PERIOD = 14;
const RSI_OVERSOLD_THRESHOLD = 30;
const RSI_OVERBOUGHT_THRESHOLD = 70;
const DEEP_RSI_THRESHOLD = 25;
const BBANDS_DEEP_MULTIPLIER = 2.0;
const BBANDS_PERIOD = 20;
const BBANDS_STD_DEV = 1.5;
const VOLUME_SPIKE_FACTOR = 1.8;
const MIN_CANDLE_BODY = 0.0003;

// System 3: Momentum Shift (Low Probability)
const RSI_CENTERLINE = 50;
const MIN_VOL_CHANGE = 1.5;

// Volatility Filter
const ATR_PERIOD = 14;
const MIN_ATR_THRESHOLD = 0.00015; // slightly loosened
const LOW_VOL_THRESHOLD = 0.0004;  // slightly loosened

// Filters
const VOLUME_CONFIRMATION_FACTOR = 0.7;
const PRICE_POSITION_FILTER = 0.25; // Loosened from 0.3
const RSI_BUY_MAX = 55;
const RSI_SELL_MIN = 45;
const PSAR_BUFFER_FACTOR = 0.3;

// =================================================================================
export async function GET() {
  console.log(`\n--- Cron job triggered at ${new Date().toISOString()} ---`);

  try {
    // 1. Fetch Market Data
    const chartData = await getChartData();
    const requiredPeriods = Math.max(
      EMA_SLOW_PERIOD, BBANDS_PERIOD, RSI_PERIOD, ATR_PERIOD, EMA_LONG_PERIOD
    );

    if (chartData.length < requiredPeriods) {
      return NextResponse.json({ message: 'Not enough data to calculate indicators.' });
    }

    // Price arrays
    const closePrices = chartData.map(d => d.close);
    const highPrices = chartData.map(d => d.high);
    const lowPrices = chartData.map(d => d.low);
    const latest = chartData.at(-1)!;
    const prev = chartData.at(-2)!;

    // 2. Cache indicators to avoid recomputation
    const emaFast = indicators.calculateEMA(closePrices, EMA_FAST_PERIOD);
    const emaSlow = indicators.calculateEMA(closePrices, EMA_SLOW_PERIOD);
    const emaMedium = indicators.calculateEMA(closePrices, EMA_MEDIUM_PERIOD);
    const emaLong = indicators.calculateEMA(closePrices, EMA_LONG_PERIOD);
    const pSar = indicators.calculateParabolicSAR(chartData, PARABOLIC_SAR_STEP, PARABOLIC_SAR_MAX);
    const vwap = indicators.calculateVWAP(chartData);
    const rsi = indicators.calculateRSI(closePrices, RSI_PERIOD);
    const bb = indicators.calculateBollingerBands(closePrices, BBANDS_PERIOD, BBANDS_STD_DEV);
    const deepBB = indicators.calculateBollingerBands(closePrices, BBANDS_PERIOD, BBANDS_STD_DEV * BBANDS_DEEP_MULTIPLIER);
    const atr = indicators.calculateATR(highPrices, lowPrices, closePrices, ATR_PERIOD);

    // Extract latest values safely
    const val = (arr: (number | null)[]) => arr.at(-1) ?? null;
    const prevVal = (arr: (number | null)[]) => arr.at(-2) ?? null;

    const cache = {
      emaFast: val(emaFast),
      emaSlow: val(emaSlow),
      emaMedium: val(emaMedium),
      emaLong: val(emaLong),
      pSar: val(pSar),
      vwap: val(vwap),
      rsi: val(rsi),
      prevRsi: prevVal(rsi),
      lowerBB: val(bb.lower),
      upperBB: val(bb.upper),
      deepLowerBB: val(deepBB.lower),
      atr: val(atr)
    };

    // Null safety check
    if (Object.values(cache).some(v => v === null)) {
      return NextResponse.json({ message: 'Indicator calculation incomplete.' });
    }

    const isUptrend = latest.close > cache.emaLong!;
    const isDowntrend = latest.close < cache.emaLong!;
    const isLowVol = cache.atr! < LOW_VOL_THRESHOLD;

    // Helper functions
    const isIncreasing = (arr: (number|null)[]) => arr.slice(-TREND_CONFIRMATION_PERIOD).every((v,i,a) => v !== null && (i===0 || v > (a[i-1] as number)));
    const isDecreasing = (arr: (number|null)[]) => arr.slice(-TREND_CONFIRMATION_PERIOD).every((v,i,a) => v !== null && (i===0 || v < (a[i-1] as number)));
    const volumeAvg = chartData.slice(-5).reduce((sum, d) => sum + d.volume, 0) / 5;

    // =================================================================
    // Evaluate all systems in parallel
    // =================================================================
    const candidates: Omit<Signal, 'displayTime' | 'serverTime'>[] = [];

    // ---- System 2: Momentum-Reversal ----
    if (
      cache.rsi! <= DEEP_RSI_THRESHOLD &&
      latest.low <= cache.deepLowerBB! &&
      (latest.close - latest.open) > MIN_CANDLE_BODY &&
      latest.volume > prev.volume * VOLUME_SPIKE_FACTOR &&
      latest.close > cache.pSar! &&
      isUptrend
    ) {
      candidates.push({ type: 'BUY', level: 'High', price: latest.close, time: latest.time });
    } else if (
      cache.prevRsi! < RSI_OVERSOLD_THRESHOLD &&
      cache.rsi! > RSI_OVERSOLD_THRESHOLD &&
      latest.low <= cache.lowerBB! &&
      latest.close > cache.vwap! &&
      latest.close > cache.lowerBB! * 1.001 &&
      isUptrend
    ) {
      candidates.push({ type: 'BUY', level: 'Medium', price: latest.close, time: latest.time });
    } else if (
      cache.prevRsi! > RSI_OVERBOUGHT_THRESHOLD &&
      cache.rsi! < RSI_OVERBOUGHT_THRESHOLD &&
      latest.high >= cache.upperBB! &&
      latest.close < cache.vwap! &&
      latest.close < cache.upperBB! * 0.999 &&
      isDowntrend
    ) {
      candidates.push({ type: 'SELL', level: 'Medium', price: latest.close, time: latest.time });
    }

    // ---- System 1: Core Trend-Following ----
    const volumeOK = latest.volume > volumeAvg * VOLUME_CONFIRMATION_FACTOR;
    const bbWidth = cache.upperBB! - cache.lowerBB!;
    const pricePos = (latest.close - cache.lowerBB!) / bbWidth;
    const priceInMiddle = pricePos > PRICE_POSITION_FILTER && pricePos < (1 - PRICE_POSITION_FILTER);
    const psarBuffer = cache.atr! * PSAR_BUFFER_FACTOR;

    const coreBuy = (isLowVol ? (cache.emaFast! > cache.emaSlow!) : (cache.emaFast! > cache.emaSlow! && cache.emaSlow! > cache.emaMedium!))
      && latest.close > cache.vwap!
      && latest.close > (cache.pSar! + psarBuffer)
      && cache.rsi! < RSI_BUY_MAX
      && isIncreasing(emaFast) && isIncreasing(emaSlow)
      && isUptrend && volumeOK && priceInMiddle;

    const coreSell = (isLowVol ? (cache.emaFast! < cache.emaSlow!) : (cache.emaFast! < cache.emaSlow! && cache.emaSlow! < cache.emaMedium!))
      && latest.close < cache.vwap!
      && latest.close < (cache.pSar! - psarBuffer)
      && cache.rsi! > RSI_SELL_MIN
      && isDecreasing(emaFast) && isDecreasing(emaSlow)
      && isDowntrend && volumeOK && priceInMiddle;

    if (coreBuy) candidates.push({ type: 'BUY', level: 'High', price: latest.close, time: latest.time });
    if (coreSell) candidates.push({ type: 'SELL', level: 'High', price: latest.close, time: latest.time });

    // ---- System 3: Momentum Shift ----
    const volUp = latest.volume > prev.volume * MIN_VOL_CHANGE;
    if (cache.prevRsi! < RSI_CENTERLINE && cache.rsi! > RSI_CENTERLINE && volUp && latest.close > cache.vwap! && isUptrend) {
      candidates.push({ type: 'BUY', level: 'Low', price: latest.close, time: latest.time });
    }
    if (cache.prevRsi! > RSI_CENTERLINE && cache.rsi! < RSI_CENTERLINE && volUp && latest.close < cache.vwap! && isDowntrend) {
      candidates.push({ type: 'SELL', level: 'Low', price: latest.close, time: latest.time });
    }

    // =================================================================
    // Select strongest signal
    // =================================================================
    if (!candidates.length) {
      return NextResponse.json({ message: 'No signal generated.' });
    }

    const priority = { High: 3, Medium: 2, Low: 1 };
    candidates.sort((a, b) => priority[b.level] - priority[a.level]);
    const newSignal = candidates[0];

    // Price action confirmation (optional)
    if (newSignal.type === 'BUY' && latest.close <= prev.high) {
      return NextResponse.json({ message: 'Signal unconfirmed by price action (BUY)' });
    }
    if (newSignal.type === 'SELL' && latest.close >= prev.low) {
      return NextResponse.json({ message: 'Signal unconfirmed by price action (SELL)' });
    }

    // Duplicate prevention
    const lastSignals = await getSignalHistoryFromFirestore();
    const lastSignal = lastSignals[0] || null;
    if (lastSignal &&
        lastSignal.type === newSignal.type &&
        lastSignal.level === newSignal.level &&
        Math.abs(lastSignal.price - newSignal.price) / newSignal.price < 0.0002 &&
        Math.abs(newSignal.time - lastSignal.time) < 1000 * 60 * 5) {
      return NextResponse.json({ message: 'Duplicate signal skipped.' });
    }

    // Save
    await saveSignalToFirestore(newSignal);
    return NextResponse.json({ signal: newSignal });

  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: String(err) });
  }
}
