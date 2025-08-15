

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
        const cooldownMinutes = lastSignal?.level === 'High' ? 3 : 5; // Dynamic Cooldown

        if (timeSinceLastSignalMs > 0 && timeSinceLastSignalMs < cooldownMinutes * 60 * 1000) {
            log(`In active trade cooldown (${cooldownMinutes} mins). No new signals will be generated.`);
            return NextResponse.json({ message: 'In active trade cooldown. No new signal generated.' });
        }
    }

    section('Find New Signal');
    const dogeClose = dogeChartData.map(d => d.close);
    const dogeVolume = dogeChartData.map(d => d.volume);

    // DOGE indicators
    const emaFastArr = indicators.calculateEMA(dogeClose, strategyConfig.EMA_FAST_PERIOD);
    const emaSlowArr = indicators.calculateEMA(dogeClose, strategyConfig.EMA_SLOW_PERIOD);
    const emaLongArr = indicators.calculateEMA(dogeClose, strategyConfig.EMA_LONG_PERIOD);
    const rsiArr = indicators.calculateRSI(dogeClose, strategyConfig.RSI_PERIOD);
    const atrArr = indicators.calculateATR(dogeChartData, strategyConfig.ATR_PERIOD);
    const psarArr = indicators.calculateParabolicSAR(dogeChartData, strategyConfig.PARABOLIC_SAR_STEP, strategyConfig.PARABOLIC_SAR_MAX);
    const avgVolumeArr = indicators.calculateSMA(dogeVolume, strategyConfig.VOLUME_PERIOD);
    
    const i = dogeChartData.length - 1; // Current, open candle
    const prev_i = i - 1; // Previous, closed candle

    const latest = dogeChartData[i];
    const prevCandle = dogeChartData[prev_i];

    log('Evaluating signal on previous candle:', {
      time: new Date(prevCandle.time).toISOString(),
      close: Number(prevCandle.close).toFixed(6),
    });
    
    // --- Volatility Filter ---
    const validAtrValues = atrArr.filter((v): v is number => v !== null);
    const currentAtr = indicators.calculateSMA(validAtrValues.slice(-5), 5).pop(); 
    const historicalAtr = indicators.calculateSMA(validAtrValues, 100).pop();
    if(currentAtr && historicalAtr && (currentAtr / historicalAtr < 0.7)){
        log(`Low volatility detected (ATR ratio: ${currentAtr/historicalAtr}). Skipping trade.`);
        return NextResponse.json({ message: 'Low volatility, no signal generated.' });
    }


    const getValueAt = (arr: (number | null)[], idx: number) => arr[idx] ?? null;
    
    const cache = {
      emaFast: getValueAt(emaFastArr, prev_i),
      emaSlow: getValueAt(emaSlowArr, prev_i),
      emaLong: getValueAt(emaLongArr, prev_i),
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
    
    const volumeConfirmed = cache.volume > (cache.avgVolume as number) * strategyConfig.VOLUME_THRESHOLD_MULTIPLIER;
    logCond('Volume Confirmation', volumeConfirmed, `Vol: ${cache.volume?.toFixed(0)} > AvgVol: ${cache.avgVolume?.toFixed(0)} * ${strategyConfig.VOLUME_THRESHOLD_MULTIPLIER}`);

    // --- STRATEGY LOGIC ---

    // BUY Logic: Price is in an uptrend, and we see a confirmation.
    const isUpTrend = (cache.emaFast as number) > (cache.emaSlow as number) && prevCandle.close > (cache.emaLong as number);
    const rsiConfirmBuy = (cache.rsi as number) > strategyConfig.RSI_BREAKOUT_THRESHOLD && (cache.rsi as number) < strategyConfig.RSI_OVERBOUGHT_THRESHOLD;
    logCond('BUY Signal', isUpTrend && rsiConfirmBuy && volumeConfirmed);
    if (isUpTrend && rsiConfirmBuy && volumeConfirmed) {
        signal = { type: 'BUY', level: 'High', price: latest.open, time: latest.time };
    }

    // SELL Logic: Price is in a downtrend, and we see a confirmation.
    const isDownTrend = (cache.emaFast as number) < (cache.emaSlow as number) && prevCandle.close < (cache.emaLong as number);
    const rsiConfirmSell = (cache.rsi as number) < strategyConfig.RSI_BREAKDOWN_THRESHOLD && (cache.rsi as number) > strategyConfig.RSI_OVERSOLD_THRESHOLD;
    logCond('SELL Signal', !signal && isDownTrend && rsiConfirmSell && volumeConfirmed);
    if (!signal && isDownTrend && rsiConfirmSell && volumeConfirmed) {
        signal = { type: 'SELL', level: 'High', price: latest.open, time: latest.time };
    }

    if (!signal) {
        log('No signal generated based on entry conditions.');
        return NextResponse.json({ message: 'No signal generated.' });
    }

    // Enhance and Save
    const atrValue = getValueAt(atrArr, i); // Use current ATR for buffer
    if (atrValue) {
        const capital = 1000; 
        const riskPercent = atrValue > 0.02 ? 0.5 : 1; // Dynamic risk based on volatility
        const dollarRisk = capital * (riskPercent / 100);
        const positionSize = dollarRisk / (atrValue * strategyConfig.STOP_LOSS_ATR_MULTIPLIER);
        const leverage = (positionSize * latest.open) / capital;

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
