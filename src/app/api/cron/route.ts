
import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore, getLatestOptimizationParams } from '@/app/actions';
import type { Signal, StrategyParams } from '@/lib/types';
import * as indicators from '@/lib/indicators'; 

interface EnhancedSignal extends Signal {
  suggestedLeverage?: number;
  stopBuffer?: number;
}

const DEBUG = true;
const COOLDOWN_HIGH = 3 * 60 * 1000; // 3 minutes
const COOLDOWN_MEDIUM = 5 * 60 * 1000; // 5 minutes

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

type CacheType = {
    emaFast: number | null;
    emaSlow: number | null;
    rsi: number | null;
    psar: number | null;
    volume: number | null;
    avgVolume: number | null;
    atr: number | null;
};

// This is a type guard that tells TypeScript that if it returns true, all properties of 'cache' are numbers.
function allIndicatorsValid(cache: CacheType): cache is Required<CacheType> {
    return (
        cache.emaFast !== null &&
        cache.emaSlow !== null &&
        cache.rsi !== null &&
        cache.psar !== null &&
        cache.volume !== null &&
        cache.avgVolume !== null &&
        cache.atr !== null
    );
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
        log('No optimization results found. Cannot proceed without strategy.');
        return NextResponse.json({ message: 'No strategy parameters available.' }, { status: 500 });
    }
  } catch (error) {
    console.error(`Error fetching optimization results:`, error);
    return NextResponse.json({ message: 'Failed to fetch strategy.' }, { status: 500 });
  }

  section(`CRON RUN @ ${ts}`);

  try {
    const requiredPeriods = Math.max(
      strategyConfig.EMA_SLOW_PERIOD, 
      strategyConfig.RSI_PERIOD, 
      strategyConfig.VOLUME_PERIOD,
      strategyConfig.ATR_PERIOD
    ) + 12; // Safety buffer + 10 for ATR SMA + 2 for PSAR

    const dogeChartData = await getChartData('DOGEUSDT');

    if (!Array.isArray(dogeChartData) || dogeChartData.length < requiredPeriods) { 
      log(`Insufficient data. DOGE=${dogeChartData?.length ?? 0} Need=${requiredPeriods}`);
      return NextResponse.json({ message: 'Not enough data for indicators.' });
    }
    
    const recentSignals = await getSignalHistoryFromFirestore();
    const lastSignal = recentSignals?.[0] ?? null;

    if (lastSignal) {
        const lastSignalTime = lastSignal.time;
        const latestCandleTime = dogeChartData[dogeChartData.length - 1].time;
        const timeSinceLastSignalMs = latestCandleTime - lastSignalTime;
        const cooldown = lastSignal.level === 'High' ? COOLDOWN_HIGH : COOLDOWN_MEDIUM;
        
        if (timeSinceLastSignalMs > 0 && timeSinceLastSignalMs < cooldown) { 
            log(`Cooldown active (${Math.floor(cooldown/60000)}min). Skipping signal.`);
            return NextResponse.json({ message: 'In trade cooldown.' });
        }
    }

    section('Find New Signal');
    const dogeClose = dogeChartData.map(d => d.close);
    const dogeVolume = dogeChartData.map(d => d.volume);

    const emaFastArr = indicators.calculateEMA(dogeClose, strategyConfig.EMA_FAST_PERIOD);
    const emaSlowArr = indicators.calculateEMA(dogeClose, strategyConfig.EMA_SLOW_PERIOD);
    const rsiArr = indicators.calculateRSI(dogeClose, strategyConfig.RSI_PERIOD);
    const atrArr = indicators.calculateATR(dogeChartData, strategyConfig.ATR_PERIOD);
    const psarArr = indicators.calculateParabolicSAR(dogeChartData, strategyConfig.PARABOLIC_SAR_STEP, strategyConfig.PARABOLIC_SAR_MAX);
    const volumeSma = indicators.calculateSMA(dogeVolume, strategyConfig.VOLUME_PERIOD);
    
    const i = dogeChartData.length - 1; 
    const prev_i = i - 1; 
    const prev_prev_i = i - 2;

    const latestCandle = dogeChartData[i];
    const prevCandle = dogeChartData[prev_i];

    log('Evaluating signal on previous candle:', {
      time: new Date(prevCandle.time).toISOString(),
      close: prevCandle.close.toFixed(6),
    });

    const cache: CacheType = {
        emaFast: indicators.getValueAt(emaFastArr, prev_i),
        emaSlow: indicators.getValueAt(emaSlowArr, prev_i),
        rsi: indicators.getValueAt(rsiArr, prev_i),
        psar: indicators.getValueAt(psarArr, prev_i),
        volume: dogeVolume[prev_i],
        avgVolume: indicators.getValueAt(volumeSma, prev_i),
        atr: indicators.getValueAt(atrArr, prev_i)
    };
    
    if (allIndicatorsValid(cache)) {
        // --- Start of type-safe block ---
        section('Signal Conditions');
        let signal: Omit<EnhancedSignal, 'displayTime' | 'serverTime'> | null = null;
        let confidence: Signal['level'] | null = null;

        const emaFastPrev = indicators.getValueAt(emaFastArr, prev_prev_i);
        const emaSlowPrev = indicators.getValueAt(emaSlowArr, prev_prev_i);

        logCond('EMA Fast > Slow', (cache.emaFast ?? 0) > (cache.emaSlow ?? 0), `Fast: ${(cache.emaFast ?? 0).toFixed(5)} > Slow: ${(cache.emaSlow ?? 0).toFixed(5)}`);
        logCond('EMA Fast < Slow', (cache.emaFast ?? 0) < (cache.emaSlow ?? 0), `Fast: ${(cache.emaFast ?? 0).toFixed(5)} < Slow: ${(cache.emaSlow ?? 0).toFixed(5)}`);
        logCond('RSI Buy Range', (cache.rsi ?? 0) < strategyConfig.RSI_OVERBOUGHT_THRESHOLD, `RSI: ${(cache.rsi ?? 0).toFixed(2)} < ${strategyConfig.RSI_OVERBOUGHT_THRESHOLD}`);
        logCond('RSI Sell Range', (cache.rsi ?? 0) > strategyConfig.RSI_OVERSOLD_THRESHOLD, `RSI: ${(cache.rsi ?? 0).toFixed(2)} > ${strategyConfig.RSI_OVERSOLD_THRESHOLD}`);
        logCond('PSAR Buy Confirmation', (cache.psar ?? 0) < prevCandle.close, `PSAR: ${(cache.psar ?? 0).toFixed(5)} < Close: ${prevCandle.close.toFixed(5)}`);
        logCond('PSAR Sell Confirmation', (cache.psar ?? 0) > prevCandle.close, `PSAR: ${(cache.psar ?? 0).toFixed(5)} > Close: ${prevCandle.close.toFixed(5)}`);
        
        const volumeBaseCondition = (cache.volume ?? 0) > ((cache.avgVolume ?? 0) * strategyConfig.VOLUME_THRESHOLD_MULTIPLIER * 0.85);
        logCond('Volume Confirmation Base', volumeBaseCondition, `Vol ${(cache.volume ?? 0).toFixed(2)} > AvgVol* ${((cache.avgVolume ?? 0) * strategyConfig.VOLUME_THRESHOLD_MULTIPLIER * 0.85).toFixed(2)})`);
        
        const emaCrossedUp = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev <= emaSlowPrev && (cache.emaFast ?? 0) > (cache.emaSlow ?? 0);
        logCond('EMA Crossover Up', emaCrossedUp, `Prev Fast: ${emaFastPrev?.toFixed(5)} <= Prev Slow: ${emaSlowPrev?.toFixed(5)} AND Curr Fast: ${(cache.emaFast ?? 0).toFixed(5)} > Curr Slow: ${(cache.emaSlow ?? 0).toFixed(5)}`);
        
        const emaCrossedDown = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev >= emaSlowPrev && (cache.emaFast ?? 0) < (cache.emaSlow ?? 0);
        logCond('EMA Crossover Down', emaCrossedDown, `Prev Fast: ${emaFastPrev?.toFixed(5)} >= Prev Slow: ${emaSlowPrev?.toFixed(5)} AND Curr Fast: ${(cache.emaFast ?? 0).toFixed(5)} < Curr Slow: ${(cache.emaSlow ?? 0).toFixed(5)}`);

        // High-confidence signals (crossover + confirmation)
        if (emaCrossedUp && (cache.rsi ?? 0) < strategyConfig.RSI_OVERBOUGHT_THRESHOLD && (cache.psar ?? 0) < prevCandle.close) {
            confidence = volumeBaseCondition ? 'High' : 'Medium';
            signal = { type: 'BUY', level: confidence, price: latestCandle.open, time: latestCandle.time };
        } 
        else if (emaCrossedDown && (cache.rsi ?? 0) > strategyConfig.RSI_OVERSOLD_THRESHOLD && (cache.psar ?? 0) > prevCandle.close) {
            confidence = volumeBaseCondition ? 'High' : 'Medium';
            signal = { type: 'SELL', level: confidence, price: latestCandle.open, time: latestCandle.time };
        }
        // Medium-confidence signals (pullbacks)
        else {
            const isPullbackBuy = prevCandle.low <= (cache.emaSlow ?? 0) && prevCandle.close > (cache.emaSlow ?? 0);
            logCond('Pullback Buy Condition', isPullbackBuy, `Prev Low ${prevCandle.low.toFixed(5)} <= EMA Slow ${(cache.emaSlow ?? 0).toFixed(5)} AND Prev Close ${prevCandle.close.toFixed(5)} > EMA Slow ${(cache.emaSlow ?? 0).toFixed(5)}`);
            
            const isPullbackSell = prevCandle.high >= (cache.emaSlow ?? 0) && prevCandle.close < (cache.emaSlow ?? 0);
            logCond('Pullback Sell Condition', isPullbackSell, `Prev High ${prevCandle.high.toFixed(5)} >= EMA Slow ${(cache.emaSlow ?? 0).toFixed(5)} AND Prev Close ${prevCandle.close.toFixed(5)} < EMA Slow ${(cache.emaSlow ?? 0).toFixed(5)}`);
            
            const rsiOkForBuyPullback = (cache.rsi ?? 0) > 30 && (cache.rsi ?? 0) < strategyConfig.RSI_OVERBOUGHT_THRESHOLD;
            logCond('RSI OK for Buy Pullback', rsiOkForBuyPullback, `30 < RSI ${(cache.rsi ?? 0).toFixed(2)} < ${strategyConfig.RSI_OVERBOUGHT_THRESHOLD}`);
            
            const rsiOkForSellPullback = (cache.rsi ?? 0) < 70 && (cache.rsi ?? 0) > strategyConfig.RSI_OVERSOLD_THRESHOLD;
            logCond('RSI OK for Sell Pullback', rsiOkForSellPullback, `70 > RSI ${(cache.rsi ?? 0).toFixed(2)} > ${strategyConfig.RSI_OVERSOLD_THRESHOLD}`);

            if (isPullbackBuy && rsiOkForBuyPullback && (cache.psar ?? 0) < prevCandle.close) {
                confidence = 'Medium';
                signal = { type: 'BUY', level: confidence, price: latestCandle.open, time: latestCandle.time };
            } 
            else if (isPullbackSell && rsiOkForSellPullback && (cache.psar ?? 0) > prevCandle.close) {
                confidence = 'Medium';
                signal = { type: 'SELL', level: confidence, price: latestCandle.open, time: latestCandle.time };
            }
        }

        // Final confirmation filters
        if (signal) {
            section('Signal Validation');
            
            const minPriceMovement = (cache.atr ?? 0) * strategyConfig.NOISE_FILTER_RATIO;
            const priceChange = Math.abs(latestCandle.open - prevCandle.close);
            const atrFilterPassed = priceChange >= minPriceMovement;
            logCond('ATR Noise Filter', atrFilterPassed, `Change: ${priceChange.toFixed(6)} >= Min Move: ${minPriceMovement.toFixed(6)}`);

            const isBullishConfirm = latestCandle.close > latestCandle.open && latestCandle.close > prevCandle.high;
            const isBearishConfirm = latestCandle.close < latestCandle.open && latestCandle.close < prevCandle.low;
            logCond('Bullish Confirm Candle', isBullishConfirm, `Curr Close ${latestCandle.close.toFixed(5)} > Curr Open ${latestCandle.open.toFixed(5)} AND Curr Close > Prev High ${prevCandle.high.toFixed(5)}`);
            logCond('Bearish Confirm Candle', isBearishConfirm, `Curr Close ${latestCandle.close.toFixed(5)} < Curr Open ${latestCandle.open.toFixed(5)} AND Curr Close < Prev Low ${prevCandle.low.toFixed(5)}`);

            if ((signal.type === 'BUY' && !isBullishConfirm) || (signal.type === 'SELL' && !isBearishConfirm) || !atrFilterPassed) {
                log(`Signal rejected: ${!atrFilterPassed ? 'ATR filter failed' : 'Missing confirmation candle'}`);
                signal = null;
                confidence = null;
            }
        }

        if (signal) {
            section('Saving Signal');
            const capital = 1000;
            const dollarRisk = capital * ((cache.atr ?? 0) > 0.0005 ? 0.0075 : 0.0125);
            const positionSize = dollarRisk / ((cache.atr ?? 0) * strategyConfig.STOP_LOSS_ATR_MULTIPLIER);
            const leverage = Math.min(10, Math.max(1, Math.round((positionSize * latestCandle.open) / capital)));
            
            const enhancedSignal: EnhancedSignal = {
                ...signal,
                suggestedLeverage: leverage,
                stopBuffer: (cache.atr ?? 0) * strategyConfig.STOP_LOSS_ATR_MULTIPLIER
            };

            await saveSignalToFirestore(enhancedSignal);
            log('Signal saved:', enhancedSignal);
            return NextResponse.json({ signal: enhancedSignal });
        }
        
        log('No valid signal generated');
        return NextResponse.json({ message: 'No signal generated.' });

        // --- End of type-safe block ---
    } else {
        log('Indicator calculation incomplete on previous candle:', cache);
        return NextResponse.json({ message: 'Indicator calculation failed.' });
    }

  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${errorMessage}`);
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }
}
 

    