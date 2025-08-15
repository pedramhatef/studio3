
import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore, getLatestOptimizationParams } from '@/app/actions';
import type { Signal } from '@/lib/types';
import * as indicators from '@/lib/indicators'; 

interface EnhancedSignal extends Signal {
  suggestedLeverage?: number;
  stopBuffer?: number;
}

const DEBUG = true;

let strategyConfig = {
  EMA_FAST_PERIOD: 5,
  EMA_SLOW_PERIOD: 10,
  EMA_LONG_PERIOD: 50,
  PARABOLIC_SAR_STEP: 0.02,
  PARABOLIC_SAR_MAX: 0.2,
  RSI_PERIOD: 14,
  RSI_OVERSOLD_THRESHOLD: 35,
  RSI_OVERBOUGHT_THRESHOLD: 65,
  RSI_BREAKOUT_THRESHOLD: 55,
  RSI_BREAKDOWN_THRESHOLD: 45,
  ATR_PERIOD: 14,
  ATR_VOLATILITY_THRESHOLD: 1.2,
  VOLUME_PERIOD: 20,
  VOLUME_THRESHOLD_MULTIPLIER: 2.0, 
  TAKE_PROFIT_ATR_MULTIPLIER: 2.0,
  STOP_LOSS_ATR_MULTIPLIER: 1.5,
};

export const revalidate = 0;

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
    const chartData = await getChartData();
    const requiredPeriods = Math.max(
      strategyConfig.EMA_SLOW_PERIOD, strategyConfig.RSI_PERIOD, strategyConfig.ATR_PERIOD, strategyConfig.EMA_LONG_PERIOD, strategyConfig.VOLUME_PERIOD, 26
    );

    if (!Array.isArray(chartData) || chartData.length < requiredPeriods) {
      log(`Not enough data to calculate indicators. Have=${chartData?.length ?? 0} Need>=${requiredPeriods}`);
      return NextResponse.json({ message: 'Not enough data to calculate indicators.' });
    }
    
    const recentSignals = await getSignalHistoryFromFirestore();
    const lastSignal = recentSignals?.[0] ?? null;

    if (lastSignal) {
        const timeSinceLastSignal = chartData[chartData.length - 1].time - lastSignal.time;
        // If last signal was less than 2 minutes ago, don't generate a new one to prevent conflicts.
        if (timeSinceLastSignal < 2 * 60 * 1000) { 
            log(`Still in active trade based on signal from ${new Date(lastSignal.time).toISOString()}. No new signals will be generated.`);
            return NextResponse.json({ message: 'In active trade. No new signal generated.' });
        }
    }


    section('Find New Signal');
    const closeSlice = chartData.map(d => d.close);
    const volumeSlice = chartData.map(d => d.volume);

    const emaFastArr = indicators.calculateEMA(closeSlice, strategyConfig.EMA_FAST_PERIOD);
    const emaSlowArr = indicators.calculateEMA(closeSlice, strategyConfig.EMA_SLOW_PERIOD);
    const emaLongArr = indicators.calculateEMA(closeSlice, strategyConfig.EMA_LONG_PERIOD);
    const psarArr = indicators.calculateParabolicSAR(chartData, strategyConfig.PARABOLIC_SAR_STEP, strategyConfig.PARABOLIC_SAR_MAX);
    const rsiArr = indicators.calculateRSI(closeSlice, strategyConfig.RSI_PERIOD);
    const atrArr = indicators.calculateATR(chartData, strategyConfig.ATR_PERIOD);
    const avgVolumeArr = indicators.calculateSMA(volumeSlice, strategyConfig.VOLUME_PERIOD);
    const macd = indicators.calculateMACD(closeSlice, 12, 26, 9);

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
    
    const recentAtrSlice = atrArr.slice(-10).filter(v => v !== null) as number[];
    const avgAtr = recentAtrSlice.length > 0 ? recentAtrSlice.reduce((s,v) => s + v, 0) / recentAtrSlice.length : 0;
    const isVolatileEnough = (cache.atr as number) > (avgAtr * strategyConfig.ATR_VOLATILITY_THRESHOLD);
    logCond(`Is Volatile`, isVolatileEnough);

    let signal: Omit<EnhancedSignal, 'displayTime' | 'serverTime'> | null = null;

    if (!isVolatileEnough) {
        log('Market not volatile enough, no signal generated.');
        return NextResponse.json({ message: 'Market not volatile enough.' });
    }

    const emaFastPrev = getValueAt(emaFastArr, currentIndex - 1);
    const emaSlowPrev = getValueAt(emaSlowArr, currentIndex - 1);
    const volumeOk = latest.volume > (cache.avgVolume as number) * strategyConfig.VOLUME_THRESHOLD_MULTIPLIER;
    const macdConfirmBuy = (cache.macdHistogram as number) > 0;
    const macdConfirmSell = (cache.macdHistogram as number) < 0;
    
    const emaCrossedUp = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev <= emaSlowPrev && (cache.emaFast as number) > (cache.emaSlow as number);
    const emaCrossedDown = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev >= emaSlowPrev && (cache.emaFast as number) < (cache.emaSlow as number);

    // BUY Logic
    logCond('BUY Crossover', emaCrossedUp && (cache.rsi as number) < strategyConfig.RSI_OVERBOUGHT_THRESHOLD && volumeOk && macdConfirmBuy);
    if (emaCrossedUp && (cache.rsi as number) < strategyConfig.RSI_OVERBOUGHT_THRESHOLD && volumeOk && macdConfirmBuy) {
        signal = { type: 'BUY', level: 'High', price: latest.close, time: latest.time };
    }

    const isPullbackBuy = latest.low <= (cache.emaSlow as number) && latest.close > (cache.emaSlow as number);
    const rsiPullbackOkBuy = (cache.rsi as number) > 40 && (cache.rsi as number) < strategyConfig.RSI_OVERBOUGHT_THRESHOLD;
    logCond('BUY Pullback', !signal && isPullbackBuy && rsiPullbackOkBuy);
    if (!signal && isPullbackBuy && rsiPullbackOkBuy) {
        signal = { type: 'BUY', level: 'Medium', price: latest.close, time: latest.time };
    }
    
    // SELL Logic
    logCond('SELL Crossover', emaCrossedDown && (cache.rsi as number) > strategyConfig.RSI_OVERSOLD_THRESHOLD && volumeOk && macdConfirmSell);
    if (emaCrossedDown && (cache.rsi as number) > strategyConfig.RSI_OVERSOLD_THRESHOLD && volumeOk && macdConfirmSell) {
        signal = { type: 'SELL', level: 'High', price: latest.close, time: latest.time };
    }

    const isPullbackSell = latest.high >= (cache.emaSlow as number) && latest.close < (cache.emaSlow as number);
    const rsiPullbackOkSell = (cache.rsi as number) < 60 && (cache.rsi as number) > strategyConfig.RSI_OVERSOLD_THRESHOLD;
    logCond('SELL Pullback', !signal && isPullbackSell && rsiPullbackOkSell);
    if (!signal && isPullbackSell && rsiPullbackOkSell) {
        signal = { type: 'SELL', level: 'Medium', price: latest.close, time: latest.time };
    }

    if (!signal) {
        log('No signal generated based on entry conditions.');
        return NextResponse.json({ message: 'No signal generated.' });
    }
    
    // Prevent creating a new signal if the last one was of the same type and very recent
    if (lastSignal && lastSignal.type === signal.type) {
      log(`Duplicate signal type (${signal.type}) detected. No new signal will be saved.`);
      return NextResponse.json({ message: 'Duplicate signal detected.' });
    }

    // Enhance and Save
    const atrAsVolatility = (cache.atr as number) / latest.close;
    signal.suggestedLeverage = Math.max(1, Math.min(10, Math.round(1 / atrAsVolatility)));
    signal.stopBuffer = (cache.atr as number) * strategyConfig.STOP_LOSS_ATR_MULTIPLIER;
    
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
