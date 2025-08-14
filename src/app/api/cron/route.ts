
import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore } from '@/app/actions';
import type { Signal } from '@/lib/types';
import { db } from '@/lib/firebase';
import * as indicators from '@/lib/indicators'; 
import { collection, query, orderBy, limit, getDocs } from 'firebase/firestore';


// Extend Signal type to include new fields
interface EnhancedSignal extends Signal {
  suggestedLeverage?: number;
  stopBuffer?: number;
}

// STRATEGY CONFIGURATION
const DEBUG = true;

// System 1: Core Trend-Following (High Probability)
let EMA_FAST_PERIOD = 5;
let EMA_SLOW_PERIOD = 10;
let EMA_MEDIUM_PERIOD = 15;
let EMA_LONG_PERIOD = 30;
let PARABOLIC_SAR_STEP = 0.02;
let PARABOLIC_SAR_MAX = 0.2;

// System 2: Momentum-Reversal (Medium Probability)
let RSI_PERIOD = 7;
let RSI_OVERSOLD_THRESHOLD = 35;
let RSI_OVERBOUGHT_THRESHOLD = 65;
let DEEP_RSI_THRESHOLD = 30;
let DEEP_RSI_OVERBOUGHT = 70;
let BBANDS_DEEP_MULTIPLIER = 2.0;
let BBANDS_PERIOD = 10;
let BBANDS_STD_DEV = 1.5;
let VOLUME_SPIKE_FACTOR = 1.5;  // Increased from 1.2
let MIN_CANDLE_BODY = 0.0001;

// System 3: Momentum Shift (Low Probability)
let RSI_CENTERLINE = 50;
let MIN_VOL_CHANGE = 1.5;

// Volatility Filter
let ATR_PERIOD = 7;
let MIN_ATR_THRESHOLD = 0.00015;
let LOW_VOL_THRESHOLD = 0.0008;
let AVG_ATR_MULTIPLIER = 1.0;  // Reduced from 1.2

// Filters
let VOLUME_CONFIRMATION_FACTOR = 1.0;  // Reduced from 1.2
let PRICE_POSITION_FILTER = 0.20;
let RSI_BUY_MAX = 60;
let RSI_SELL_MIN = 40;
let PSAR_BUFFER_FACTOR = 0.2;

export const revalidate = 0;

// Logging helpers

// Define types for systems for clarity
type TradingSystem = 'Core Trend-Following' | 'Momentum-Reversal-Deep' | 'Momentum-Reversal-Moderate' | 'Momentum-Shift';

let dynamicPriority: Record<TradingSystem, number> = {
    'Core Trend-Following': 4,
    'Momentum-Reversal-Deep': 3,
    'Momentum-Reversal-Moderate': 2,
    'Momentum-Shift': 1
} as Record<TradingSystem, number>;

function log(message: string, ...args: any[]) {
  if (DEBUG) {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} [info] ${message}`, ...args);
  }
}
function section(title: string) {
  log(`=== ${title} ===`);
}
function kv(obj: Record<string, any>) {
  log(JSON.stringify(obj, null, 2));
}
function logCond(name: string, passed: boolean, details?: string) {
  log(`${passed ? '✔' : '✘'} ${name}${details ? ` → ${details}` : ''}`);
}

export async function GET() {
  const ts = new Date().toISOString();

  // 0) Fetch Optimal Parameters and Dynamic Priority from Firestore
  section('Fetch Optimal Parameters and Dynamic Priority');
  try {
    const optimizationResultsCol = collection(db, 'optimizationResults');
    const q = query(optimizationResultsCol, orderBy('timestamp', 'desc'), limit(1));
    const latestResultSnapshot = await getDocs(q);

    if (!latestResultSnapshot.empty) {
      const latestResult = latestResultSnapshot.docs[0].data();
      log('Latest optimization results fetched:', latestResult);

      if (latestResult.bestParams) {
        const params = latestResult.bestParams;
        EMA_FAST_PERIOD = params.EMA_FAST_PERIOD ?? EMA_FAST_PERIOD;
        EMA_SLOW_PERIOD = params.EMA_SLOW_PERIOD ?? EMA_SLOW_PERIOD;
        RSI_PERIOD = params.RSI_PERIOD ?? RSI_PERIOD;
        // ... apply other parameters
        log('Applied optimal parameters from Firestore.');
      }
      
      if (latestResult.bestPerformance) {
        const perf = latestResult.bestPerformance; 
        dynamicPriority = {
            'Core Trend-Following': (perf.systemPerformance['Core Trend-Following']?.totalProfitLoss || 0) > 0 ? 4 : 1,
            'Momentum-Reversal-Deep': (perf.systemPerformance['Momentum-Reversal-Deep']?.totalProfitLoss || 0) > 0 ? 3 : 1,
            'Momentum-Reversal-Moderate': (perf.systemPerformance['Momentum-Reversal-Moderate']?.totalProfitLoss || 0) > 0 ? 2 : 1,
            'Momentum-Shift': (perf.systemPerformance['Momentum-Shift']?.totalProfitLoss || 0) > 0 ? 1 : 0,
        };
        log('Dynamic Priority set:', dynamicPriority);
      }
    } else {
      log('No optimization results found in Firestore. Using default parameters and priority.');
    }
  } catch (error) {
    console.error(`Error fetching optimization results:`, error);
    log('Using default parameters and priority due to fetch error.');
  }
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
    section('Compute Indicators');
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

    // Evaluate latest candle
    const currentIndex = chartData.length - 1;
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

    const getValueAt = (arr: (number | null)[], idx: number) => {
      if (idx < 0 || idx >= arr.length) return null;
      return arr[idx] ?? arr.slice(0, idx + 1).reverse().find(v => v !== null) ?? null;
    };
    const getPrevValueAt = (arr: (number | null)[], idx: number) => {
      if (idx <= 0 || idx >= arr.length) return null;
      return arr[idx - 1] ?? arr.slice(0, idx).reverse().find(v => v !== null) ?? null;
    };    
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
      deepUpperBB: getValueAt(deepBB.upper, currentIndex),
      atr: getValueAt(atrArr, currentIndex),
    };

    if (Object.values(cache).some(v => v === null || Number.isNaN(v))) {
      log('Indicator calculation incomplete:', cache);
      return NextResponse.json({ message: 'Indicator calculation incomplete.' });
    }

    kv(cache);

    const isUptrend = latest.close > (cache.emaLong as number);
    const isDowntrend = latest.close < (cache.emaLong as number);
    const isLowVol = (cache.atr as number) < LOW_VOL_THRESHOLD;
    log('Trend/Volatility:', { isUptrend, isDowntrend, isLowVol });

    // Compute average ATR (last 5 up to current)
    const recentAtrStart = Math.max(0, currentIndex - 4);
    const recentAtr = atrArr.slice(recentAtrStart, currentIndex + 1).filter(v => v !== null) as number[];
    const avgAtr = recentAtr.length > 0 ? recentAtr.reduce((s, v) => s + v, 0) / recentAtr.length : 0;
    log('ATR Debug:', { currentAtr: Number(cache.atr).toFixed(6), avgAtr: avgAtr.toFixed(6), threshold: (avgAtr * AVG_ATR_MULTIPLIER).toFixed(6) });

    // Volatility filter
    const volFilterMin = (cache.atr as number) >= MIN_ATR_THRESHOLD || isLowVol;
    logCond(`Vol Filter: ATR >= ${MIN_ATR_THRESHOLD} or LowVol`, volFilterMin, `${Number(cache.atr).toFixed(6)}`);
    if (!volFilterMin) {
      section('VOLATILITY FILTER');
      log(`✘ Market too flat`);
      return NextResponse.json({ message: 'Market too flat for signal generation.' });
    }

    // Volume average (last 5 up to current)
    const volStart = Math.max(0, currentIndex - 4);
    const recentVol = chartData.slice(volStart, currentIndex + 1);
    const volumeAvg = recentVol.reduce((s, d) => s + d.volume, 0) / recentVol.length;

    // EMA crossover checks
    const emaFastPrev = getPrevValueAt(emaFastArr, currentIndex);
    const emaSlowPrev = getPrevValueAt(emaSlowArr, currentIndex);
    const emaFastCrossedSlowUp = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev <= emaSlowPrev && (cache.emaFast as number) > (cache.emaSlow as number);
    const emaFastCrossedSlowDown = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev >= emaSlowPrev && (cache.emaFast as number) < (cache.emaSlow as number);
    logCond('EMA Fast Crossed Slow Up', emaFastCrossedSlowUp);
    logCond('EMA Fast Crossed Slow Down', emaFastCrossedSlowDown);

    // Calculate trend strength
    const trendStrength = Math.abs(
      (cache.emaFast as number) - (cache.emaLong as number)
    ) / (cache.atr as number);
    const isStrongTrend = trendStrength > 1.5;
    log('Trend Strength:', { trendStrength: trendStrength.toFixed(2), isStrongTrend });

    // System 2: Momentum-Reversal (Simplified)
    section('System 2: Momentum-Reversal');
    
    // Deep Oversold Reversal (BUY)
    const deepBuyConditions = [
      (cache.rsi as number) <= DEEP_RSI_THRESHOLD,
      latest.low <= (cache.deepLowerBB as number),
      (latest.close - latest.open) > MIN_CANDLE_BODY,
      latest.volume > volumeAvg * VOLUME_SPIKE_FACTOR,
      latest.close > (cache.pSar as number)
    ];
    deepBuyConditions.forEach((cond, i) => logCond(`Deep Buy Condition ${i+1}`, cond));
    const deepBuyTrueCount = deepBuyConditions.filter(Boolean).length;
    log(`Deep Buy Conditions Met: ${deepBuyTrueCount}/${deepBuyConditions.length}`);
    
    // Deep Overbought Reversal (SELL)
    const deepSellConditions = [
      (cache.rsi as number) >= DEEP_RSI_OVERBOUGHT,
      latest.high >= (cache.deepUpperBB as number),
      (latest.open - latest.close) > MIN_CANDLE_BODY,
      latest.volume > volumeAvg * VOLUME_SPIKE_FACTOR,
      latest.close < (cache.pSar as number)
    ];
    deepSellConditions.forEach((cond, i) => logCond(`Deep Sell Condition ${i+1}`, cond));
    const deepSellTrueCount = deepSellConditions.filter(Boolean).length;
    log(`Deep Sell Conditions Met: ${deepSellTrueCount}/${deepSellConditions.length}`);

    // Moderate Reversal (BUY)
    const modBuyConditions = [
      (cache.prevRsi as number) < RSI_OVERSOLD_THRESHOLD,
      (cache.rsi as number) > RSI_OVERSOLD_THRESHOLD,
      latest.low <= (cache.lowerBB as number),
      latest.close > (cache.vwap as number),
      isDowntrend
    ];
    modBuyConditions.forEach((cond, i) => logCond(`Mod Buy Condition ${i+1}`, cond));
    const modBuyTrueCount = modBuyConditions.filter(Boolean).length;
    log(`Mod Buy Conditions Met: ${modBuyTrueCount}/${modBuyConditions.length}`);
    
    // Moderate Reversal (SELL)
    const modSellConditions = [
      (cache.prevRsi as number) > RSI_OVERBOUGHT_THRESHOLD,
      (cache.rsi as number) < RSI_OVERBOUGHT_THRESHOLD,
      latest.high >= (cache.upperBB as number),
      latest.close < (cache.vwap as number),
      isUptrend
    ];
    modSellConditions.forEach((cond, i) => logCond(`Mod Sell Condition ${i+1}`, cond));
    const modSellTrueCount = modSellConditions.filter(Boolean).length;
    log(`Mod Sell Conditions Met: ${modSellTrueCount}/${modSellConditions.length}`);

    // System 1: Core Trend-Following
    section('System 1: Core Trend-Following');
    const psarBuffer = (cache.atr as number) * PSAR_BUFFER_FACTOR;
    log('PSAR Buffer:', `${psarBuffer.toFixed(6)} (${(PSAR_BUFFER_FACTOR*100).toFixed(0)}% ATR)`);
    
    const emaFast = cache.emaFast as number;
    const emaSlow = cache.emaSlow as number;
    const pSar = cache.pSar as number;
    const rsi = cache.rsi as number;

    // Core Trend BUY
    const coreBuyConditions = [
      emaFast > emaSlow,
      emaFastCrossedSlowUp, // This is already a boolean
      latest.close > pSar + psarBuffer,
      isUptrend,
      rsi < RSI_BUY_MAX
    ];
    coreBuyConditions.forEach((cond, i) => logCond(`Core Buy Condition ${i+1}`, cond));
    const coreBuyTrueCount = coreBuyConditions.filter(Boolean).length;
    log(`Core Buy Conditions Met: ${coreBuyTrueCount}/${coreBuyConditions.length}`);
    const coreBuyTrue = coreBuyTrueCount >= 4;

    const coreSellConditions = [
      emaFast < emaSlow,
      emaFastCrossedSlowDown, // This is already a boolean
      latest.close < pSar - psarBuffer,
      isDowntrend,
      rsi > RSI_SELL_MIN
    ];
    logCond(`Core Sell Condition 1: EMA Fast < EMA Slow`, coreSellConditions[0], `${emaFast.toFixed(6)} < ${emaSlow.toFixed(6)}`);
    logCond(`Core Sell Condition 2: EMA Fast Crossed Slow Down`, coreSellConditions[1]);
    logCond(`Core Sell Condition 3: Close < PSAR - Buffer`, coreSellConditions[2], `${latest.close.toFixed(6)} < ${(pSar - psarBuffer).toFixed(6)}`);
    logCond(`Core Sell Condition 4: Is Downtrend (Close < EMA Long)`, coreSellConditions[3], `${latest.close.toFixed(6)} < ${(cache.emaLong as number).toFixed(6)}`);
    logCond(`Core Sell Condition 5: RSI > RSI_SELL_MIN`, coreSellConditions[4], `${rsi.toFixed(2)} > ${RSI_SELL_MIN}`);

    const coreSellTrue = coreSellConditions.filter(Boolean).length >= 4;


    // System 3: Momentum Shift
    section('System 3: Momentum Shift');
    const volUp = latest.volume > (prev.volume ?? 0) * MIN_VOL_CHANGE;
    
    // Momentum Shift BUY
    const shiftBuyConditions = [
      (cache.prevRsi as number) < RSI_CENTERLINE,
      (cache.rsi as number) > RSI_CENTERLINE,
      volUp,
      latest.close > (cache.vwap as number),
      isUptrend
    ];
    shiftBuyConditions.forEach((cond, i) => logCond(`Shift Buy Condition ${i+1}`, cond));
    const shiftBuyTrue = shiftBuyConditions.filter(Boolean).length >= 4;
    
    // Momentum Shift SELL
    const shiftSellConditions = [
      (cache.prevRsi as number) > RSI_CENTERLINE,
      (cache.rsi as number) < RSI_CENTERLINE,
      volUp,
      latest.close < (cache.vwap as number),
      isDowntrend
    ];
    shiftSellConditions.forEach((cond, i) => logCond(`Shift Sell Condition ${i+1}`, cond));
    const shiftSellTrue = shiftSellConditions.filter(Boolean).length >= 4;

    // BB Width Filter
    section('BB Width Filter');
    const bbWidth = (cache.upperBB as number) - (cache.lowerBB as number);
    const atrThreshold = (cache.atr as number);
    const bbWidthOK = bbWidth >= atrThreshold * 0.8;  // Reduced threshold
    logCond(`BB Width >= ATR * 0.8`, bbWidthOK, `${bbWidth.toFixed(6)} >= ${(atrThreshold * 0.8).toFixed(6)}`);
    if (!bbWidthOK) {
      log(`✘ BB Width too tight: ${bbWidth.toFixed(6)} < ${(atrThreshold * 0.8).toFixed(6)}`);
      return NextResponse.json({ message: 'BB Width too tight for signal generation.' });
    }

    // Candidates
    type Cand = Omit<EnhancedSignal, 'displayTime' | 'serverTime'> & { system: TradingSystem };
    const candidates: Cand[] = [];

    // Add candidates with priority weighting
    if (deepBuyTrueCount >= 3) {  // Reduced threshold
      log('→ Candidate: HIGH BUY (Deep Oversold Reversal)');
      candidates.push({ type: 'BUY', level: 'High', price: latest.close, time: latest.time, system: 'Momentum-Reversal-Deep' });
    }
    if (deepSellTrueCount >= 3) {  // Reduced threshold
      log('→ Candidate: HIGH SELL (Deep Overbought Reversal)');
      candidates.push({ type: 'SELL', level: 'High', price: latest.close, time: latest.time, system: 'Momentum-Reversal-Deep' });

    }
    if (modBuyTrueCount >= 3 && !candidates.some(c => c.type === 'BUY' && c.level === 'High')) { // Add only if no High BUY signal exists
      log('→ Candidate: MEDIUM BUY (Moderate Reversal)');
      candidates.push({ type: 'BUY', level: 'Medium', price: latest.close, time: latest.time, system: 'Momentum-Reversal-Moderate' });

    }
    if (modSellTrueCount >= 3 && !candidates.some(c => c.type === 'SELL' && c.level === 'High')) { // Add only if no High SELL signal exists
      log('→ Candidate: MEDIUM SELL (Moderate Reversal)');
      candidates.push({ type: 'SELL', level: 'Medium', price: latest.close, time: latest.time, system: 'Momentum-Reversal-Moderate' });
    }
    if (coreBuyTrue) {
      log('→ Candidate: HIGH BUY (Core Trend-Following)');
      candidates.push({ type: 'BUY', level: 'High', price: latest.close, time: latest.time, system: 'Core Trend-Following' });

    }
    if (coreSellTrue) {
      log('→ Candidate: HIGH SELL (Core Trend-Following)');
      candidates.push({ type: 'SELL', level: 'High', price: latest.close, time: latest.time, system: 'Core Trend-Following' });

    }
    if (shiftBuyTrue && !candidates.some(c => c.type === 'BUY' && c.level !== 'Low')) { // Add only if no higher confidence BUY signal exists
      log('→ Candidate: LOW BUY (RSI Centerline Cross)');
      candidates.push({ type: 'BUY', level: 'Low', price: latest.close, time: latest.time, system: 'Momentum-Shift' });

    }
    if (shiftSellTrue && !candidates.some(c => c.type === 'SELL' && c.level !== 'Low')) { // Add only if no higher confidence SELL signal exists
      log('→ Candidate: LOW SELL (RSI Centerline Cross)');
      candidates.push({ type: 'SELL', level: 'Low', price: latest.close, time: latest.time, system: 'Momentum-Shift' });

    }

    // Selection & Post filters
    section('Selection');
    if (!candidates.length) {
      log('No candidates from any system.');
      return NextResponse.json({ message: 'No signal generated.' });
    }

    // Prioritize signals based on dynamic priority, level, and trend strength
    const priority = { High: 3, Medium: 2, Low: 1 } as const;
    candidates.sort((a, b) => {
      const dynamicPriorityA = dynamicPriority[a.system] ?? 0;
      const dynamicPriorityB = dynamicPriority[b.system] ?? 0;

      const dynamicPriorityDiff = dynamicPriorityB - dynamicPriorityA;
      if (dynamicPriorityDiff !== 0) return dynamicPriorityDiff;

      const priorityDiff = priority[b.level as keyof typeof priority] - priority[a.level as keyof typeof priority];
      if (priorityDiff !== 0) return priorityDiff;
      
      return (b.type === 'BUY' ? trendStrength : -trendStrength) - (a.type === 'BUY' ? trendStrength : -trendStrength);
    });
    
    log('Candidates sorted (best first):', candidates);
    let newSignal = candidates[0];
    log('Selected:', newSignal);

    // Price Action Confirmation
    section('Price Action Confirmation');
    const priceConfirmationThreshold = isStrongTrend ? 0.0002 : 0.0005; // Dynamic threshold
    
    if (newSignal.type === 'BUY') {
      const ok = latest.close > prev.close * (1 + priceConfirmationThreshold);
      logCond(`BUY must exceed prev close + ${(priceConfirmationThreshold * 100).toFixed(2)}%`, 
        ok, 
        `${latest.close.toFixed(6)} > ${(prev.close * (1 + priceConfirmationThreshold)).toFixed(6)}`
      );
      if (!ok) return NextResponse.json({ message: 'Signal unconfirmed by price action (BUY).' });
    } else {
      const ok = latest.close < prev.close * (1 - priceConfirmationThreshold);
      logCond(`SELL must break prev close - ${(priceConfirmationThreshold * 100).toFixed(2)}%`, 
        ok, 
        `${latest.close.toFixed(6)} < ${(prev.close * (1 - priceConfirmationThreshold)).toFixed(6)}`
      );
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
      
      if (lastSignal.type === newSignal.type && priceBps < 1.5 && timeDeltaMin < 5) {
        log('✘ Duplicate skipped (same direction, <1.5 bps diff, <5 min).');
        return NextResponse.json({ message: 'Duplicate signal skipped.' });
      }
      
      if (isOpposite && timeDeltaMin < 5 && !atrAvgOk) {
        log('✘ Opposite signal skipped (within 5 min, ATR not above avg).');
        return NextResponse.json({ message: 'Opposite signal skipped due to low volatility.' });
      }
    } else {
      log('No previous signals found.');
    }

    // Save Signal
    const enhancedSignal: EnhancedSignal = { ...newSignal };
    await saveSignalToFirestore(enhancedSignal);
    log('✓ Signal saved:', enhancedSignal);
    return NextResponse.json({ signal: enhancedSignal });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    log(`Error: ${errorMessage}`, errorStack ? `\nStack: ${errorStack}`: '');
    return NextResponse.json({ error: errorMessage });
  }
}

    