

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

    if (!Array.isArray(chartData) || chartData.length < requiredPeriods + 1) { // Need +1 for lookback
      log(`Not enough data to calculate indicators. Have=${chartData?.length ?? 0} Need>=${requiredPeriods + 1}`);
      return NextResponse.json({ message: 'Not enough data to calculate indicators.' });
    }
    
    const recentSignals = await getSignalHistoryFromFirestore();
    const lastSignal = recentSignals?.[0] ?? null;

    if (lastSignal) {
        const lastSignalTime = lastSignal.time;
        const latestCandleTime = chartData[chartData.length - 1].time;
        const timeSinceLastSignalMs = latestCandleTime - lastSignalTime;

        if (timeSinceLastSignalMs > 0 && timeSinceLastSignalMs < 5 * 60 * 1000) { // 5 minute cooldown
            log(`Still in active trade based on signal from ${new Date(lastSignalTime).toISOString()}. No new signals will be generated.`);
            return NextResponse.json({ message: 'In active trade cooldown. No new signal generated.' });
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

    // We check for signals on the PREVIOUS candle (i-1) and execute on the CURRENT candle (i)
    const i = chartData.length - 1; // Current, open candle
    const prev_i = i - 1; // Previous, closed candle

    const latest = chartData[i];
    const prevCandle = chartData[prev_i];

    log('Evaluating signal on previous candle:', {
      time: new Date(prevCandle.time).toISOString(),
      close: Number(prevCandle.close).toFixed(6),
    });

    const getValueAt = (arr: (number | null)[], idx: number) => arr[idx] ?? null;
    
    const cache = {
      emaFast: getValueAt(emaFastArr, prev_i),
      emaSlow: getValueAt(emaSlowArr, prev_i),
      emaLong: getValueAt(emaLongArr, prev_i),
      pSar: getValueAt(psarArr, prev_i),
      rsi: getValueAt(rsiArr, prev_i),
      avgVolume: getValueAt(avgVolumeArr, prev_i)
    };

    if (Object.values(cache).some(v => v === null || Number.isNaN(v))) {
      log('Indicator calculation incomplete on previous candle:', cache);
      return NextResponse.json({ message: 'Indicator calculation incomplete.' });
    }
    kv(cache);
    
    let signal: Omit<EnhancedSignal, 'displayTime' | 'serverTime'> | null = null;
    
    const emaFastPrev = getValueAt(emaFastArr, prev_i - 1);
    const emaSlowPrev = getValueAt(emaSlowArr, prev_i - 1);

    const isUptrend = prevCandle.close > (cache.emaLong as number);
    const isDowntrend = prevCandle.close < (cache.emaLong as number);
    const volumeConfirmation = prevCandle.volume > (cache.avgVolume as number) * strategyConfig.VOLUME_THRESHOLD_MULTIPLIER;


    // --- HIGH CONFIDENCE ---
    // BUY Logic (Crossover)
    const emaCrossedUp = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev <= emaSlowPrev && (cache.emaFast as number) > (cache.emaSlow as number);
    const rsiInRangeBuy = (cache.rsi as number) < strategyConfig.RSI_OVERBOUGHT_THRESHOLD;
    const psarConfirmBuy = prevCandle.close > (cache.pSar as number);
    logCond('High-Conf BUY Crossover', emaCrossedUp && rsiInRangeBuy && psarConfirmBuy && isUptrend && volumeConfirmation);
    if (emaCrossedUp && rsiInRangeBuy && psarConfirmBuy && isUptrend && volumeConfirmation) {
        signal = { type: 'BUY', level: 'High', price: latest.close, time: latest.time };
    }

    // SELL Logic (Crossover)
    const emaCrossedDown = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev >= emaSlowPrev && (cache.emaFast as number) < (cache.emaSlow as number);
    const rsiInRangeSell = (cache.rsi as number) > strategyConfig.RSI_OVERSOLD_THRESHOLD;
    const psarConfirmSell = prevCandle.close < (cache.pSar as number);
    logCond('High-Conf SELL Crossover', !signal && emaCrossedDown && rsiInRangeSell && psarConfirmSell && isDowntrend && volumeConfirmation);
    if (!signal && emaCrossedDown && rsiInRangeSell && psarConfirmSell && isDowntrend && volumeConfirmation) {
        signal = { type: 'SELL', level: 'High', price: latest.close, time: latest.time };
    }
    
    // --- MEDIUM CONFIDENCE ---
    if(!signal) {
        // BUY Logic (Pullback)
        const isPullbackBuy = isUptrend && prevCandle.low <= (cache.emaFast as number) && prevCandle.close > (cache.emaFast as number);
        const rsiPullbackOkBuy = (cache.rsi as number) > 40 && rsiInRangeBuy;
        logCond('Med-Conf BUY Pullback', isPullbackBuy && rsiPullbackOkBuy);
        if (isPullbackBuy && rsiPullbackOkBuy) {
            signal = { type: 'BUY', level: 'Medium', price: latest.close, time: latest.time };
        }

        // SELL Logic (Pullback)
        const isPullbackSell = isDowntrend && prevCandle.high >= (cache.emaFast as number) && prevCandle.close < (cache.emaFast as number);
        const rsiPullbackOkSell = (cache.rsi as number) < 60 && rsiInRangeSell;
        logCond('Med-Conf SELL Pullback', !signal && isPullbackSell && rsiPullbackOkSell);
        if (!signal && isPullbackSell && rsiPullbackOkSell) {
            signal = { type: 'SELL', level: 'Medium', price: latest.close, time: latest.time };
        }
    }


    if (!signal) {
        log('No signal generated based on entry conditions.');
        return NextResponse.json({ message: 'No signal generated.' });
    }

    // Enhance and Save
    const atrValue = getValueAt(atrArr, i); // Use current ATR for buffer
     if (atrValue) {
        const capital = 1000; // Assume a constant capital for leverage calculation for now
        const riskPercent = 1;
        const dollarRisk = capital * (riskPercent / 100);
        const positionSize = dollarRisk / (atrValue * strategyConfig.STOP_LOSS_ATR_MULTIPLIER);
        const leverage = (positionSize * latest.close) / capital;

        signal.suggestedLeverage = Math.max(1, Math.min(10, Math.round(leverage)));
        signal.stopBuffer = atrValue * strategyConfig.STOP_LOSS_ATR_MULTIPLIER;
     }
    
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
