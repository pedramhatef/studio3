
import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore, getLatestOptimizationParams } from '@/app/actions';
import type { Signal, StrategyParams } from '@/lib/types';
import * as indicators from '@/lib/indicators'; 

interface EnhancedSignal extends Signal {
  suggestedLeverage?: number;
  stopBuffer?: number;
}

const DEBUG = true;
const COOLDOWN_HIGH = 3 * 60 * 1000; // 3 minutes in ms
const COOLDOWN_MEDIUM = 5 * 60 * 1000; // 5 minutes in ms

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
    volumeStdDev: number | null;
    atr: number | null;
    prevAtr: number | null;
};

// This is a type guard. If it returns true, TypeScript knows that all properties of cache are numbers.
function allIndicatorsValid(cache: CacheType): cache is Required<CacheType> {
    return Object.values(cache).every(value => value !== null && !isNaN(value));
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
    const requiredPeriods = Math.max(
      strategyConfig.EMA_SLOW_PERIOD, 
      strategyConfig.RSI_PERIOD, 
      strategyConfig.VOLUME_PERIOD
    ) + strategyConfig.ATR_PERIOD + 12; // Add ATR period + 10 for ATR SMA + 2 for safety buffer

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
        const cooldown = lastSignal.level === 'High' ? COOLDOWN_HIGH : COOLDOWN_MEDIUM;
        
        if (timeSinceLastSignalMs > 0 && timeSinceLastSignalMs < cooldown) { 
            log(`In active trade cooldown (${cooldown/60000} mins). No new signals will be generated.`);
            return NextResponse.json({ message: 'In active trade cooldown. No new signal generated.' });
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
    const prev_prev_i = prev_i - 1;

    const latest = dogeChartData[i];
    const prevCandle = dogeChartData[prev_i];

    log('Evaluating signal on previous candle:', {
      time: new Date(prevCandle.time).toISOString(),
      close: Number(prevCandle.close).toFixed(6),
    });

    const cache: CacheType = {
        emaFast: indicators.getValueAt(emaFastArr, prev_i),
        emaSlow: indicators.getValueAt(emaSlowArr, prev_i),
        rsi: indicators.getValueAt(rsiArr, prev_i),
        psar: indicators.getValueAt(psarArr, prev_i),
        volume: indicators.getValueAt(dogeVolume, prev_i),
        avgVolume: indicators.getValueAt(volumeSma, prev_i),
        volumeStdDev: null, 
        atr: indicators.getValueAt(atrArr, i),
        prevAtr: null 
    };
    
    if (cache.avgVolume && cache.atr) {
        const volumeSlice = dogeVolume.slice(Math.max(0, prev_i - strategyConfig.VOLUME_PERIOD + 1), prev_i + 1);
        if(volumeSlice.length === strategyConfig.VOLUME_PERIOD) {
            const mean = volumeSlice.reduce((a, b) => a + b, 0) / strategyConfig.VOLUME_PERIOD;
            const variance = volumeSlice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / strategyConfig.VOLUME_PERIOD;
            cache.volumeStdDev = Math.sqrt(variance);
        }

        const atrSlice = atrArr.slice(Math.max(0, i - 10 + 1), i + 1).filter(v => v !== null) as number[];
        if (atrSlice.length === 10) {
            cache.prevAtr = atrSlice.reduce((sum, val) => sum + val, 0) / atrSlice.length;
        }
    }


    if (!allIndicatorsValid(cache)) {
        log('Indicator calculation incomplete on previous candle:', cache);
        return NextResponse.json({ message: 'Incomplete indicator data.' });
    }

    let signal: Omit<EnhancedSignal, 'displayTime' | 'serverTime'> | null = null;
    let signalType: Signal['type'] | null = null;
    let confidence: Signal['level'] | null = null;
    
    const emaFastPrev = indicators.getValueAt(emaFastArr, prev_prev_i)!;
    const emaSlowPrev = indicators.getValueAt(emaSlowArr, prev_prev_i)!;

    // Log all conditions for better debugging
    logCond('EMA Fast > Slow', cache.emaFast > cache.emaSlow, `Fast: ${cache.emaFast.toFixed(5)} > Slow: ${cache.emaSlow.toFixed(5)}`);
    logCond('EMA Fast < Slow', cache.emaFast < cache.emaSlow, `Fast: ${cache.emaFast.toFixed(5)} < Slow: ${cache.emaSlow.toFixed(5)}`);
    logCond('RSI Buy Range', cache.rsi < strategyConfig.RSI_OVERBOUGHT_THRESHOLD, `RSI: ${cache.rsi.toFixed(2)} < ${strategyConfig.RSI_OVERBOUGHT_THRESHOLD}`);
    logCond('RSI Sell Range', cache.rsi > strategyConfig.RSI_OVERSOLD_THRESHOLD, `RSI: ${cache.rsi.toFixed(2)} > ${strategyConfig.RSI_OVERSOLD_THRESHOLD}`);
    logCond('PSAR Buy Confirmation', cache.psar < prevCandle.close, `PSAR: ${cache.psar.toFixed(5)} < Close: ${prevCandle.close}`);
    logCond('PSAR Sell Confirmation', cache.psar > prevCandle.close, `PSAR: ${cache.psar.toFixed(5)} > Close: ${prevCandle.close}`);
    const volumeBaseCondition = cache.volume > (cache.avgVolume * strategyConfig.VOLUME_THRESHOLD_MULTIPLIER * 0.85);
    logCond('Volume Confirmation Base', volumeBaseCondition, `Vol ${cache.volume.toFixed(2)} > AvgVol*Multiplier*0.85 (${(cache.avgVolume * strategyConfig.VOLUME_THRESHOLD_MULTIPLIER * 0.85).toFixed(2)})`);
    const emaCrossedUp = emaFastPrev <= emaSlowPrev && cache.emaFast > cache.emaSlow;
    const emaCrossedDown = emaFastPrev >= emaSlowPrev && cache.emaFast < cache.emaSlow;
    logCond('EMA Crossover Up', emaCrossedUp, `Prev Fast: ${emaFastPrev.toFixed(5)} <= Prev Slow: ${emaSlowPrev.toFixed(5)} AND Curr Fast: ${cache.emaFast.toFixed(5)} > Curr Slow: ${cache.emaSlow.toFixed(5)}`);
    logCond('EMA Crossover Down', emaCrossedDown, `Prev Fast: ${emaFastPrev.toFixed(5)} >= Prev Slow: ${emaSlowPrev.toFixed(5)} AND Curr Fast: ${cache.emaFast.toFixed(5)} < Curr Slow: ${cache.emaSlow.toFixed(5)}`);

    if (volumeBaseCondition) {
        // High-confidence Crossover Logic
        if (emaCrossedUp && cache.rsi < strategyConfig.RSI_OVERBOUGHT_THRESHOLD && cache.psar < prevCandle.close) {
            signalType = 'BUY';
            confidence = 'High';
        } else if (emaCrossedDown && cache.rsi > strategyConfig.RSI_OVERSOLD_THRESHOLD && cache.psar > prevCandle.close) {
            signalType = 'SELL';
            confidence = 'High';
        }

        // Medium-confidence Pullback signals
        if (!signalType) {
            const isPullbackBuy = prevCandle.low <= cache.emaSlow && prevCandle.close > cache.emaSlow;
            const rsiPullbackOkBuy = cache.rsi > 40 && cache.rsi < strategyConfig.RSI_OVERBOUGHT_THRESHOLD;
            logCond('Pullback Buy Condition', isPullbackBuy, `Low: ${prevCandle.low.toFixed(5)} <= Slow EMA: ${cache.emaSlow.toFixed(5)} AND Close: ${prevCandle.close.toFixed(5)} > Slow EMA`);
            logCond('RSI Range for Pullback Buy', rsiPullbackOkBuy, `40 < RSI: ${cache.rsi.toFixed(2)} < ${strategyConfig.RSI_OVERBOUGHT_THRESHOLD}`);

            if (isPullbackBuy && rsiPullbackOkBuy && cache.psar < prevCandle.close) {
                signalType = 'BUY';
                confidence = 'Medium';
            } else {
                const isPullbackSell = prevCandle.high >= cache.emaSlow && prevCandle.close < cache.emaSlow;
                const rsiPullbackOkSell = cache.rsi < 60 && cache.rsi > strategyConfig.RSI_OVERSOLD_THRESHOLD;
                logCond('Pullback Sell Condition', isPullbackSell, `High: ${prevCandle.high.toFixed(5)} >= Slow EMA: ${cache.emaSlow.toFixed(5)} AND Close: ${prevCandle.close.toFixed(5)} < Slow EMA`);
                logCond('RSI Range for Pullback Sell', rsiPullbackOkSell, `60 > RSI: ${cache.rsi.toFixed(2)} > ${strategyConfig.RSI_OVERSOLD_THRESHOLD}`);

                if (isPullbackSell && rsiPullbackOkSell && cache.psar > prevCandle.close) {
                    signalType = 'SELL';
                    confidence = 'Medium';
                }
            }
        }
        
        const volumeRatio = cache.volume / cache.avgVolume;
        const mediumVolumeConfirmed = volumeRatio > strategyConfig.VOLUME_THRESHOLD_MULTIPLIERConfirmation;
        logCond('Volume Confirmation Medium', mediumVolumeConfirmed, `Volume Ratio (${volumeRatio.toFixed(2)}) > Threshold (${strategyConfig.VOLUME_THRESHOLD_MULTIPLIERConfirmation})`);

        if (confidence === 'High' && !mediumVolumeConfirmed) {
            log('High confidence signal rejected due to insufficient medium volume confirmation.');
            signalType = null;
            confidence = null;
        } else if (confidence === 'Medium' && !mediumVolumeConfirmed) {
            log('Medium confidence signal rejected due to insufficient medium volume confirmation.');
            signalType = null;
            confidence = null;
        }


        if (signalType && confidence) {
            const minPriceMovement = cache.atr * strategyConfig.NOISE_FILTER_RATIO;
            const priceChange = Math.abs(latest.open - prevCandle.close);
            const atrFilterPassed = priceChange >= minPriceMovement;
            logCond('ATR Noise Filter', atrFilterPassed, `Price Change (${priceChange.toFixed(6)}) >= Min Movement (${minPriceMovement.toFixed(6)})`);

            if (!atrFilterPassed) {
                signalType = null;
                confidence = null;
            } else {
                 const isBullishConfirmation = latest.close > latest.open && latest.close > prevCandle.high;
                 const isBearishConfirmation = latest.close < latest.open && latest.close < prevCandle.low;
                 logCond('Bullish Confirmation Candle', isBullishConfirmation, `Close (${latest.close.toFixed(5)}) > Open (${latest.open.toFixed(5)}) AND Close > Prev High (${prevCandle.high.toFixed(5)})`);
                 logCond('Bearish Confirmation Candle', isBearishConfirmation, `Close (${latest.close.toFixed(5)}) < Open (${latest.open.toFixed(5)}) AND Close < Prev Low (${prevCandle.low.toFixed(5)})`);

                 if (signalType === 'BUY' && !isBullishConfirmation) {
                     log("Buy signal rejected: Missing bullish confirmation candle.");
                     signalType = null;
                 } else if (signalType === 'SELL' && !isBearishConfirmation) {
                     log("Sell signal rejected: Missing bearish confirmation candle.");
                     signalType = null;
                 }
            }
        }

        if (signalType && confidence) {
            signal = { 
                type: signalType, 
                level: confidence, 
                price: latest.open, 
                time: latest.time 
            };

            const capital = 1000; 
            const dollarRisk = capital * (cache.atr > 0.0005 ? 0.0075 : 0.0125);
            const positionSize = dollarRisk / (cache.atr * strategyConfig.STOP_LOSS_ATR_MULTIPLIER);
            const leverage = Math.min(10, Math.max(1, Math.round((positionSize * latest.open) / capital)));
            
            signal.suggestedLeverage = leverage;
            signal.stopBuffer = cache.atr * strategyConfig.STOP_LOSS_ATR_MULTIPLIER;
        }
    } else {
        log('No signal generated: Base volume confirmation failed.');
    }

    if (!signal) {
        log('No signal generated based on entry conditions.');
        return NextResponse.json({ message: 'No signal generated.' });
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
