
import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore, getLatestOptimizationParams } from '@/app/actions';
import type { Signal } from '@/lib/types';
import * as indicators from '@/lib/indicators'; 

// Extend Signal type to include new fields
interface EnhancedSignal extends Signal {
  suggestedLeverage?: number;
  stopBuffer?: number;
}

// STRATEGY CONFIGURATION
const DEBUG = true;

// This object holds the default parameters.
// These will be used as a fallback if fetching from Firestore fails.
// This now includes ALL parameters that the optimizer uses.
let strategyConfig = {
  // Core Trend-Following
  EMA_FAST_PERIOD: 5,
  EMA_SLOW_PERIOD: 10,
  EMA_LONG_PERIOD: 50,
  PARABOLIC_SAR_STEP: 0.02,
  PARABOLIC_SAR_MAX: 0.2,

  // Momentum
  RSI_PERIOD: 14,
  RSI_OVERSOLD_THRESHOLD: 35,
  RSI_OVERBOUGHT_THRESHOLD: 65,
  RSI_BREAKOUT_THRESHOLD: 55, // For breakout signals
  RSI_BREAKDOWN_THRESHOLD: 45, // For breakdown signals


  // Volatility Filter
  ATR_PERIOD: 14,
  ATR_VOLATILITY_THRESHOLD: 1.2,
  
  // Volume Filter
  VOLUME_PERIOD: 20,
  VOLUME_THRESHOLD_MULTIPLIER: 2.0, // e.g., Volume must be 2x the average
  
  // Backtesting-related parameters that are optimized but not directly used in live signal generation.
  // They are included here so the config object matches the one in Firestore.
  TAKE_PROFIT_ATR_MULTIPLIER: 2.0,
  STOP_LOSS_ATR_MULTIPLIER: 1.5,
};


export const revalidate = 0;

// Logging helpers
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

  // 0) Fetch Optimal Parameters from Firestore
  section('Fetch Optimal Parameters');
  try {
    const latestParams = await getLatestOptimizationParams();
    if (latestParams) {
        strategyConfig = { ...strategyConfig, ...latestParams };
        log('Applied optimal parameters from Firestore.');
        kv(strategyConfig);
    } else {
        log('No optimization results found in Firestore. Using default parameters.');
    }
  } catch (error) {
    console.error(`Error fetching optimization results:`, error);
    log('Using default parameters due to fetch error.');
  }

  section(`CRON RUN @ ${ts}`);

  try {
    // 1) Fetch data
    const chartData = await getChartData();
    const requiredPeriods = Math.max(
      strategyConfig.EMA_SLOW_PERIOD, strategyConfig.RSI_PERIOD, strategyConfig.ATR_PERIOD, strategyConfig.EMA_LONG_PERIOD, strategyConfig.VOLUME_PERIOD, 26 // MACD slow period
    );

    if (!Array.isArray(chartData) || chartData.length < requiredPeriods) {
      log(`Not enough data to calculate indicators. Have=${chartData?.length ?? 0} Need>=${requiredPeriods}`);
      return NextResponse.json({ message: 'Not enough data to calculate indicators.' });
    }

    // 2) Compute indicators
    section('Compute Indicators');
    const closeSlice = chartData.map(d => d.close);
    const highSlice = chartData.map(d => d.high);
    const lowSlice = chartData.map(d => d.low);
    const volumeSlice = chartData.map(d => d.volume);


    const emaFastArr = indicators.calculateEMA(closeSlice, strategyConfig.EMA_FAST_PERIOD);
    const emaSlowArr = indicators.calculateEMA(closeSlice, strategyConfig.EMA_SLOW_PERIOD);
    const emaLongArr = indicators.calculateEMA(closeSlice, strategyConfig.EMA_LONG_PERIOD);
    const psarArr = indicators.calculateParabolicSAR(chartData, strategyConfig.PARABOLIC_SAR_STEP, strategyConfig.PARABOLIC_SAR_MAX);
    const rsiArr = indicators.calculateRSI(closeSlice, strategyConfig.RSI_PERIOD);
    const atrArr = indicators.calculateATR(chartData, strategyConfig.ATR_PERIOD);
    const avgVolumeArr = indicators.calculateSMA(volumeSlice, strategyConfig.VOLUME_PERIOD);
    const macd = indicators.calculateMACD(closeSlice, 12, 26, 9);


    // Evaluate latest candle
    const currentIndex = chartData.length - 1;
    const latest = chartData[currentIndex];
    
    log('Latest candle:', {
      time: new Date(latest.time).toISOString(),
      close: Number(latest.close).toFixed(6),
      volume: latest.volume
    });

    const getValueAt = (arr: (number | null)[], idx: number) => arr[idx] ?? null;
    
    const cache = {
      emaFast: getValueAt(emaFastArr, currentIndex),
      emaSlow: getValueAt(emaSlowArr, currentIndex),
      emaLong: getValueAt(emaLongArr, currentIndex),
      pSar: getValueAt(psarArr, currentIndex),
      rsi: getValueAt(rsiArr, currentIndex),
      atr: getValueAt(atrArr, currentIndex),
      avgVolume: getValueAt(avgVolumeArr, currentIndex),
      macdHistogram: getValueAt(macd.histogram, currentIndex),
    };

    if (Object.values(cache).some(v => v === null || Number.isNaN(v))) {
      log('Indicator calculation incomplete:', cache);
      return NextResponse.json({ message: 'Indicator calculation incomplete.' });
    }
    kv(cache);
    
    // 3) Trend Determination (Primary Filter)
    section('Primary Trend Filter');
    const isUptrend = latest.close > (cache.emaLong as number);
    const isDowntrend = latest.close < (cache.emaLong as number);
    const trendDirection = isUptrend ? 'UPTREND' : isDowntrend ? 'DOWNTREND' : 'SIDEWAYS';
    log(`Overall Trend: ${trendDirection} → Close: ${latest.close.toFixed(5)}, EMA Long: ${(cache.emaLong as number).toFixed(5)}`);


    // 4) Volatility Filter
    section('Volatility Filter');
    const recentAtrSlice = atrArr.slice(-10).filter(v => v !== null) as number[];
    const avgAtr = recentAtrSlice.length > 0 ? recentAtrSlice.reduce((s,v) => s + v, 0) / recentAtrSlice.length : 0;
    const isVolatileEnough = (cache.atr as number) > (avgAtr * strategyConfig.ATR_VOLATILITY_THRESHOLD);
    logCond(`ATR > Avg ATR * ${strategyConfig.ATR_VOLATILITY_THRESHOLD}`, isVolatileEnough, `ATR: ${cache.atr?.toFixed(6)}, Avg ATR: ${avgAtr.toFixed(6)}`);


    // 5) Entry Conditions
    section('Entry Signal Logic');
    let signal: Omit<EnhancedSignal, 'displayTime' | 'serverTime'> | null = null;

    const emaFastPrev = getValueAt(emaFastArr, currentIndex - 1);
    const emaSlowPrev = getValueAt(emaSlowArr, currentIndex - 1);
    const volumeOk = latest.volume > (cache.avgVolume as number) * strategyConfig.VOLUME_THRESHOLD_MULTIPLIER;


    // BUY Signal Logic (Only in an uptrend)
    if (isUptrend) {
        log('Mode: UPTREND');
        
        const macdConfirm = (cache.macdHistogram as number) > 0;
        
        // A) Crossover Signal (High confidence)
        const emaCrossedUp = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev <= emaSlowPrev && (cache.emaFast as number) > (cache.emaSlow as number);
        logCond('BUY Crossover: EMA Fast crossed Slow Up & MACD Confirmed', emaCrossedUp && macdConfirm);
        if (emaCrossedUp && (cache.rsi as number) < strategyConfig.RSI_OVERBOUGHT_THRESHOLD && macdConfirm) {
            signal = { type: 'BUY', level: 'High', price: latest.close, time: latest.time };
            log('→ Candidate: HIGH BUY (Crossover)');
        }

        // B) Pullback Signal (Medium confidence, relaxed conditions)
        if (!signal) {
            const isPullback = latest.low <= (cache.emaFast as number) && latest.close > (cache.emaFast as number);
            logCond('BUY Pullback: Price touched EMA Fast & RSI in range', isPullback && (cache.rsi as number) > 40 && (cache.rsi as number) < strategyConfig.RSI_OVERBOUGHT_THRESHOLD);
            if(isPullback && (cache.rsi as number) > 40 && (cache.rsi as number) < strategyConfig.RSI_OVERBOUGHT_THRESHOLD) {
                signal = { type: 'BUY', level: 'Medium', price: latest.close, time: latest.time };
                log('→ Candidate: MEDIUM BUY (Pullback)');
            }
        }
        
        // C) Breakout Signal (High confidence, requires volume)
        if (!signal && volumeOk) {
             const psarOk = latest.close > (cache.pSar as number);
             const rsiOk = (cache.rsi as number) > strategyConfig.RSI_BREAKOUT_THRESHOLD;
             logCond('BUY Breakout: Volume & RSI & PSAR & MACD Confirmed', volumeOk && psarOk && rsiOk && macdConfirm);
             if(psarOk && rsiOk && macdConfirm) {
                signal = { type: 'BUY', level: 'High', price: latest.close, time: latest.time };
                log('→ Candidate: HIGH BUY (Volume Breakout)');
             }
        }
    }
    // SELL Signal Logic (Only in a downtrend)
    else if (isDowntrend) {
        log('Mode: DOWNTREND');
        
        const macdConfirm = (cache.macdHistogram as number) < 0;

        // A) Crossover Signal (High confidence)
        const emaCrossedDown = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev >= emaSlowPrev && (cache.emaFast as number) < (cache.emaSlow as number);
        logCond('SELL Crossover: EMA Fast crossed Slow Down & MACD Confirmed', emaCrossedDown && macdConfirm);
        if (emaCrossedDown && (cache.rsi as number) > strategyConfig.RSI_OVERSOLD_THRESHOLD && macdConfirm) {
            signal = { type: 'SELL', level: 'High', price: latest.close, time: latest.time };
            log('→ Candidate: HIGH SELL (Crossover)');
        }

        // B) Pullback Signal (Medium confidence, relaxed conditions)
        if (!signal) {
            const isPullback = latest.high >= (cache.emaFast as number) && latest.close < (cache.emaFast as number);
            logCond('SELL Pullback: Price touched EMA Fast & RSI in range', isPullback && (cache.rsi as number) < 60 && (cache.rsi as number) > strategyConfig.RSI_OVERSOLD_THRESHOLD);
            if(isPullback && (cache.rsi as number) < 60 && (cache.rsi as number) > strategyConfig.RSI_OVERSOLD_THRESHOLD) {
                signal = { type: 'SELL', level: 'Medium', price: latest.close, time: latest.time };
                log('→ Candidate: MEDIUM SELL (Pullback)');
            }
        }
        
        // C) Breakdown Signal (High confidence, requires volume)
        if (!signal && volumeOk) {
            const psarOk = latest.close < (cache.pSar as number);
            const rsiOk = (cache.rsi as number) < strategyConfig.RSI_BREAKDOWN_THRESHOLD;
            logCond('SELL Breakdown: Volume & RSI & PSAR & MACD Confirmed', volumeOk && psarOk && rsiOk && macdConfirm);
            if(psarOk && rsiOk && macdConfirm) {
               signal = { type: 'SELL', level: 'High', price: latest.close, time: latest.time };
               log('→ Candidate: HIGH SELL (Volume Breakdown)');
            }
       }
    }
    
    // Check if volatility filter should block the signal
    if (signal && !isVolatileEnough) {
        // Allow pullback signals even in lower volatility
        if (signal.level !== 'Medium') {
            log(`Volatility filter blocked ${signal.level} signal. No signal.`);
            signal = null;
        } else {
            log('Volatility filter bypassed for Medium confidence pullback signal.');
        }
    }


    if (!signal) {
        log('No signal generated based on entry conditions.');
        return NextResponse.json({ message: 'No signal generated.' });
    }

    // 6) Duplicate Prevention Filter
    section('Duplicate Prevention');
    const lastSignals = await getSignalHistoryFromFirestore();
    const lastSignal = lastSignals?.[0] ?? null;
    if (lastSignal) {
        const timeDeltaMin = Math.abs(Number(signal.time) - Number(lastSignal.time)) / 60000;
        if (lastSignal.type === signal.type && timeDeltaMin < 5) {
          log(`✘ Duplicate skipped (same direction, < 5 min).`);
          return NextResponse.json({ message: 'Duplicate signal skipped.' });
        }
        if (lastSignal.type !== signal.type && timeDeltaMin < 2) {
          log(`✘ Opposite signal skipped (whipsaw prevention, < 2 min).`);
          return NextResponse.json({ message: 'Opposite signal skipped due to whipsaw.' });
        }
    } else {
        log('No previous signals found.');
    }

    // 7) Enhance Signal with Risk Management Data
    const atrAsVolatility = (cache.atr as number) / latest.close;
    // Cap leverage at 10x for safety
    signal.suggestedLeverage = Math.max(1, Math.min(10, Math.round(1 / atrAsVolatility)));
    signal.stopBuffer = (cache.atr as number) * strategyConfig.STOP_LOSS_ATR_MULTIPLIER;


    // 8) Save Signal
    await saveSignalToFirestore(signal);
    log('✓ Signal saved:', signal);
    return NextResponse.json({ signal });

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : undefined;
    log(`Error: ${errorMessage}`, errorStack ? `\nStack: ${errorStack}`: '');
    return NextResponse.json({ error: errorMessage });
  }
}

    