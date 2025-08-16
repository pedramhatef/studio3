

import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore, getLatestOptimizationParams } from '@/app/actions';
import type { Signal, StrategyParams } from '@/lib/types';
import * as indicators from '@/lib/indicators'; 

interface EnhancedSignal extends Signal {
  suggestedLeverage?: number;
  stopBuffer?: number;
}

const DEBUG = true;

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

type CacheType = Record<string, number | null>;

// Type guard to ensure all cache properties are valid numbers
function allIndicatorsValid(cache: CacheType): cache is Record<keyof CacheType, number> {
    return !Object.values(cache).some(v => v === null || isNaN(v));
}

export async function GET() {
  const ts = new Date().toISOString();
  let strategyConfig: StrategyParams;

  section('Fetch Optimal Parameters');
  try {
    const latestParams = await getLatestOptimizationParams();
    if (latestParams) {
        strategyConfig = { ...latestParams, SPREAD_PERCENT: 0.01 } as StrategyParams;
        log('Applied optimal parameters from Firestore.');
        kv(strategyConfig);
    } else {
        log('No optimization results found in Firestore. Cannot proceed without a strategy.');
        return NextResponse.json({ message: 'No strategy parameters available from optimization.' }, { status: 500 });
    }
  } catch (error) {
    console.error(`Error fetching optimization results:`, error);
    log('Cannot proceed without a strategy due to fetch error.');
    return NextResponse.json({ message: 'Failed to fetch strategy parameters.' }, { status: 500 });
  }

  section(`CRON RUN @ ${ts}`);

  try {
    
    // Ensure we fetch enough data for all indicators, especially the nested ones.
    // The ATR needs its period, and the SMA on top of it needs another 10 periods.
    const atrLookback = strategyConfig.ATR_PERIOD + 10;
    const requiredPeriods = Math.max(
      strategyConfig.EMA_SLOW_PERIOD, 
      strategyConfig.RSI_PERIOD, 
      strategyConfig.EMA_LONG_PERIOD, 
      strategyConfig.VOLUME_PERIOD, 
      atrLookback // Use the combined lookback for ATR
    ) + 2; // Add a small buffer

    const dogeChartData = await getChartData('DOGEUSDT');

    if (!Array.isArray(dogeChartData) || dogeChartData.length < requiredPeriods) { 
      log(`Not enough data. DOGE=${dogeChartData?.length ?? 0} Need>=${requiredPeriods}`);
      return NextResponse.json({ message: 'Not enough data to calculate indicators.' });
    }
    
    const recentSignals = await getSignalHistoryFromFirestore();
    const lastSignal = recentSignals?.[0] ?? null;

    if (lastSignal) {
        const lastSignalTime = lastSignal.time;
        const latestCandleTime = dogeChartData[dogeChartData.length - 1].time;
        const timeSinceLastSignalMs = latestCandleTime - lastSignalTime;
        
        const cooldownMinutes = lastSignal.level === 'High' ? 3 : 5;
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
    
    const volumeSma = indicators.calculateSMA(dogeVolume, strategyConfig.VOLUME_PERIOD);
    const volumeStdDev = indicators.calculateStdDev(dogeVolume, strategyConfig.VOLUME_PERIOD);

    // Calculate the SMA of the ATR. We must filter out initial nulls from atrArr before calculating.
    const validAtrValues = atrArr.filter((v): v is number => v !== null);
    const prevAtrArrRaw = indicators.calculateSMA(validAtrValues, 10);
    // Pad the beginning of the array with nulls to align it with the original chart data
    const prevAtrArr = Array(dogeChartData.length - prevAtrArrRaw.length).fill(null).concat(prevAtrArrRaw);
    
    const i = dogeChartData.length - 1; 
    const prev_i = i - 1; 

    const latest = dogeChartData[i];
    const prevCandle = dogeChartData[prev_i];

    log('Evaluating signal on previous candle:', {
      time: new Date(prevCandle.time).toISOString(),
      close: Number(prevCandle.close).toFixed(6),
    });

    const cache: CacheType = {
      emaFast: indicators.getValueAt(emaFastArr, prev_i),
      emaSlow: indicators.getValueAt(emaSlowArr, prev_i),
      emaLong: indicators.getValueAt(emaLongArr, prev_i),
      rsi: indicators.getValueAt(rsiArr, prev_i),
      psar: indicators.getValueAt(psarArr, prev_i),
      volume: indicators.getValueAt(dogeVolume, prev_i),
      avgVolume: indicators.getValueAt(volumeSma, prev_i),
      volumeStdDev: indicators.getValueAt(volumeStdDev, prev_i),
      atr: indicators.getValueAt(atrArr, prev_i),
      prevAtr: indicators.getValueAt(prevAtrArr, prev_i),
    };

    let signal: Omit<EnhancedSignal, 'displayTime' | 'serverTime'> | null = null;
    
    if (allIndicatorsValid(cache)) {
        kv(cache);
        const isUptrend = cache.emaFast > cache.emaSlow && prevCandle.close > cache.emaLong;
        const isDowntrend = cache.emaFast < cache.emaSlow && prevCandle.close < cache.emaLong;
        logCond('Is Uptrend?', isUptrend, `Fast EMA (${cache.emaFast.toFixed(5)}) > Slow EMA (${cache.emaSlow.toFixed(5)}) AND Close (${prevCandle.close}) > Long EMA (${cache.emaLong.toFixed(5)})`);
        logCond('Is Downtrend?', isDowntrend, `Fast EMA (${cache.emaFast.toFixed(5)}) < Slow EMA (${cache.emaSlow.toFixed(5)}) AND Close (${prevCandle.close}) < Long EMA (${cache.emaLong.toFixed(5)})`);

        const volumeConfirmed = cache.volume > cache.avgVolume + (cache.volumeStdDev * strategyConfig.VOLUME_THRESHOLD_MULTIPLIER);
        const atrConfirmed = cache.atr > cache.prevAtr;

        logCond('Volume Confirmation', volumeConfirmed, `Vol (${cache.volume.toFixed(2)}) > AvgVol (${cache.avgVolume.toFixed(2)}) + (StdDev (${cache.volumeStdDev.toFixed(2)}) * ${strategyConfig.VOLUME_THRESHOLD_MULTIPLIER})`);
        logCond('ATR Confirmation (Volatility)', atrConfirmed, `ATR (${cache.atr.toFixed(6)}) > PrevATR (${cache.prevAtr.toFixed(6)})`);

        if (volumeConfirmed && atrConfirmed) {
            const highConfBuy = isUptrend && cache.rsi > 55 && prevCandle.close > cache.psar;
            logCond('High-Conf BUY Conditions', highConfBuy, `isUptrend AND RSI (${cache.rsi.toFixed(2)}) > 55 AND Close (${prevCandle.close}) > PSAR (${cache.psar.toFixed(5)})`);
            if (highConfBuy) {
                signal = { type: 'BUY', level: 'High', price: latest.open, time: latest.time };
            }

            const highConfSell = !signal && isDowntrend && cache.rsi < 45 && prevCandle.close < cache.psar;
            logCond('High-Conf SELL Conditions', highConfSell, `isDowntrend AND RSI (${cache.rsi.toFixed(2)}) < 45 AND Close (${prevCandle.close}) < PSAR (${cache.psar.toFixed(5)})`);
            if (highConfSell) {
                signal = { type: 'SELL', level: 'High', price: latest.open, time: latest.time };
            }
            
            if (!signal) {
                 const isPullbackBuy = isUptrend && prevCandle.low <= cache.emaSlow && prevCandle.close > cache.emaSlow;
                 const medConfBuy = isPullbackBuy && cache.rsi > 50 && prevCandle.close > cache.psar;
                 logCond('Med-Conf BUY Pullback', medConfBuy, `isPullbackBuy AND RSI (${cache.rsi.toFixed(2)}) > 50 AND Close (${prevCandle.close}) > PSAR (${cache.psar.toFixed(5)})`);
                 if (medConfBuy) {
                     signal = { type: 'BUY', level: 'Medium', price: latest.open, time: latest.time };
                 }

                 const isPullbackSell = isDowntrend && prevCandle.high >= cache.emaSlow && prevCandle.close < cache.emaSlow;
                 const medConfSell = !signal && isPullbackSell && cache.rsi < 50 && prevCandle.close < cache.psar;
                 logCond('Med-Conf SELL Pullback', medConfSell, `isPullbackSell AND RSI (${cache.rsi.toFixed(2)}) < 50 AND Close (${prevCandle.close}) < PSAR (${cache.psar.toFixed(5)})`);
                 if (medConfSell) {
                     signal = { type: 'SELL', level: 'Medium', price: latest.open, time: latest.time };
                 }
            }
        }
    } else {
      log('Indicator calculation incomplete on previous candle:', cache);
    }


    if (!signal) {
        log('No signal generated based on entry conditions.');
        return NextResponse.json({ message: 'No signal generated.' });
    }

    const atrValue = indicators.getValueAt(atrArr, i);
     if (atrValue) {
        const capital = 1000; 
        const riskPercent = atrValue > 0.0005 ? 0.75 : 1.25; 
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
