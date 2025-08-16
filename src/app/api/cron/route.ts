

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
  VOLUME_THRESHOLD_MULTIPLIER: 1.5, 
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
    const dogeChartData = await getChartData('DOGEUSDT');
    
    const requiredPeriods = Math.max(
      strategyConfig.EMA_SLOW_PERIOD, strategyConfig.RSI_PERIOD, strategyConfig.ATR_PERIOD, strategyConfig.EMA_LONG_PERIOD, strategyConfig.VOLUME_PERIOD, 26
    );

    if (!Array.isArray(dogeChartData) || dogeChartData.length < requiredPeriods + 1) { 
      log(`Not enough data. DOGE=${dogeChartData?.length ?? 0} Need>=${requiredPeriods + 1}`);
      return NextResponse.json({ message: 'Not enough data to calculate indicators.' });
    }
    
    const recentSignals = await getSignalHistoryFromFirestore();
    const lastSignal = recentSignals?.[0] ?? null;

    if (lastSignal) {
        const lastSignalTime = lastSignal.time;
        const latestCandleTime = dogeChartData[dogeChartData.length - 1].time;
        const timeSinceLastSignalMs = latestCandleTime - lastSignalTime;

        if (timeSinceLastSignalMs > 0 && timeSinceLastSignalMs < 5 * 60 * 1000) { // 5 minute cooldown
            log(`Still in active trade based on signal from ${new Date(lastSignalTime).toISOString()}. No new signals will be generated.`);
            return NextResponse.json({ message: 'In active trade cooldown. No new signal generated.' });
        }
    }

    section('Find New Signal');
    const dogeClose = dogeChartData.map(d => d.close);
    const dogeVolume = dogeChartData.map(d => d.volume);

    // DOGE indicators
    const emaFastArr = indicators.calculateEMA(dogeClose, strategyConfig.EMA_FAST_PERIOD);
    const emaSlowArr = indicators.calculateEMA(dogeClose, strategyConfig.EMA_SLOW_PERIOD);
    const rsiArr = indicators.calculateRSI(dogeClose, strategyConfig.RSI_PERIOD);
    const atrArr = indicators.calculateATR(dogeChartData, strategyConfig.ATR_PERIOD);
    const psarArr = indicators.calculateParabolicSAR(dogeChartData, strategyConfig.PARABOLIC_SAR_STEP, strategyConfig.PARABOLIC_SAR_MAX);
    const avgVolumeArr = indicators.calculateSMA(dogeVolume, strategyConfig.VOLUME_PERIOD);
    
    // We check for signals on the PREVIOUS candle (i-1) and execute on the CURRENT candle (i)
    const i = dogeChartData.length - 1; // Current, open candle
    const prev_i = i - 1; // Previous, closed candle

    const latest = dogeChartData[i];
    const prevCandle = dogeChartData[prev_i];

    log('Evaluating signal on previous candle:', {
      time: new Date(prevCandle.time).toISOString(),
      close: Number(prevCandle.close).toFixed(6),
    });

    const getValueAt = (arr: (number | null)[], idx: number) => arr[idx] ?? null;
    
    const cache = {
      emaFast: getValueAt(emaFastArr, prev_i),
      emaSlow: getValueAt(emaSlowArr, prev_i),
      rsi: getValueAt(rsiArr, prev_i),
      psar: getValueAt(psarArr, prev_i),
      volume: prevCandle.volume,
      avgVolume: getValueAt(avgVolumeArr, prev_i),
    };

    if (Object.values(cache).some(v => v === null || Number.isNaN(v))) {
      log('Indicator calculation incomplete on previous candle:', cache);
      return NextResponse.json({ message: 'Indicator calculation incomplete.' });
    }
    kv(cache);
    
    let signal: Omit<EnhancedSignal, 'displayTime' | 'serverTime'> | null = null;
    
    const emaFastPrev = getValueAt(emaFastArr, prev_i - 1);
    const emaSlowPrev = getValueAt(emaSlowArr, prev_i - 1);
    
    const volumeConfirmed = cache.volume > (cache.avgVolume as number) * strategyConfig.VOLUME_THRESHOLD_MULTIPLIER;
    logCond('Volume Confirmation', volumeConfirmed, `Vol: ${cache.volume?.toFixed(0)} > AvgVol: ${cache.avgVolume?.toFixed(0)} * ${strategyConfig.VOLUME_THRESHOLD_MULTIPLIER}`);

    const atrConfirmed = (getValueAt(atrArr, prev_i) as number) > (getValueAt(atrArr, prev_i - 1) as number) * strategyConfig.ATR_VOLATILITY_THRESHOLD; // Compare current ATR to previous ATR scaled
    logCond('ATR Confirmation (Volatility)', atrConfirmed, `ATR: ${getValueAt(atrArr, prev_i)?.toFixed(6)} > PrevATR: ${getValueAt(atrArr, prev_i - 1)?.toFixed(6)} * ${strategyConfig.ATR_VOLATILITY_THRESHOLD}`);

    // --- HIGH CONFIDENCE ---
    // BUY Logic (Crossover)
    const emaCrossedUp = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev <= emaSlowPrev && (cache.emaFast as number) > (cache.emaSlow as number);
    const rsiInRangeBuy = (cache.rsi as number) < strategyConfig.RSI_OVERBOUGHT_THRESHOLD;
    const psarConfirmBuy = (cache.psar as number) < prevCandle.close;
    logCond('High-Conf BUY Crossover', emaCrossedUp && rsiInRangeBuy && psarConfirmBuy && volumeConfirmed);
    if (emaCrossedUp && rsiInRangeBuy && psarConfirmBuy && volumeConfirmed && atrConfirmed) {
        signal = { type: 'BUY', level: 'High', price: latest.close, time: latest.time };
    }

    // SELL Logic (Crossover)
    const emaCrossedDown = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev >= emaSlowPrev && (cache.emaFast as number) < (cache.emaSlow as number);
    const rsiInRangeSell = (cache.rsi as number) > strategyConfig.RSI_OVERSOLD_THRESHOLD;
    const psarConfirmSell = (cache.psar as number) > prevCandle.close;
    logCond('High-Conf SELL Crossover', !signal && emaCrossedDown && rsiInRangeSell && psarConfirmSell && volumeConfirmed);
    if (!signal && emaCrossedDown && rsiInRangeSell && psarConfirmSell && volumeConfirmed && atrConfirmed) {
        signal = { type: 'SELL', level: 'High', price: latest.close, time: latest.time };
    }
    
    // --- MEDIUM CONFIDENCE ---
    if(!signal) {
        // BUY Logic (Pullback)
        const isPullbackBuy = prevCandle.low <= (cache.emaFast as number) && prevCandle.close > (cache.emaFast as number);
        const rsiPullbackOkBuy = (cache.rsi as number) > 40 && rsiInRangeBuy;
        logCond('Med-Conf BUY Pullback', isPullbackBuy && rsiPullbackOkBuy && psarConfirmBuy && volumeConfirmed);
        if (isPullbackBuy && rsiPullbackOkBuy && psarConfirmBuy && volumeConfirmed && atrConfirmed) {
            signal = { type: 'BUY', level: 'Medium', price: latest.close, time: latest.time };
        }

        // SELL Logic (Pullback)
        const isPullbackSell = prevCandle.high >= (cache.emaFast as number) && prevCandle.close < (cache.emaFast as number);
        const rsiPullbackOkSell = (cache.rsi as number) < 60 && rsiInRangeSell;
        logCond('Med-Conf SELL Pullback', !signal && isPullbackSell && rsiPullbackOkSell && psarConfirmSell && volumeConfirmed && atrConfirmed);
        if (!signal && isPullbackSell && rsiPullbackOkSell && psarConfirmSell && volumeConfirmed && atrConfirmed) {
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
        const capital = 1000; 
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