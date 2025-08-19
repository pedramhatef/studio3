
'use server';

import type { ChartDataPoint, Signal, StrategyParams, StrategyType } from '@/lib/types';
import * as indicators from '@/lib/indicators';

// =================================================================================
// SIGNAL GENERATOR
// =================================================================================
// This file centralizes the trading logic. It's imported by both the live
// cron job and the backtesting engine to ensure they use the exact same strategy.
// =================================================================================


// Helper functions for logging. Controlled by a global flag.
function log(message: string, ...args: any[]) {
    if ((global as any).ENABLE_DETAILED_LOGS) {
        const timestamp = new Date().toISOString();
        console.log(`${timestamp} [info] ${message}`, ...args);
    }
}

function logCond(name: string, passed: boolean, details?: string) {
    if ((global as any).ENABLE_DETAILED_LOGS) {
        log(`${passed ? '✔' : '✘'} ${name}${details ? ` → ${details}` : ''}`);
    }
}


// --- Helper Functions for Candle Analysis ---
function isCandleBullish(candle: ChartDataPoint) {
    return candle.close > candle.open;
}

function isCandleBearish(candle: ChartDataPoint) {
    return candle.close < candle.open;
}

function candleStrength(candle: ChartDataPoint) {
    const range = candle.high - candle.low;
    return range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
}

const EMA_ROUNDING_DECIMALS = 7; 


/**
 * Generates a trading signal based on the provided data and strategy parameters.
 * @param i The current index in the chartData array. The signal is generated for the candle at `i`.
 * @param chartData The historical price data.
 * @param params The strategy parameters.
 * @param emaFastArr Pre-calculated fast EMA values.
 * @param emaSlowArr Pre-calculated slow EMA values.
 * @param rsiArr Pre-calculated RSI values.
 * @param psarArr Pre-calculated Parabolic SAR values.
 * @param avgVolumeArr Pre-calculated average volume values.
 * @param atrArr Pre-calculated ATR values.
 * @returns A signal object or null if no signal is generated.
 */
export async function generateSignal(
    i: number,
    chartData: ChartDataPoint[],
    params: StrategyParams,
    emaFastArr: (number | null)[],
    emaSlowArr: (number | null)[],
    rsiArr: (number | null)[],
    psarArr: (number | null)[],
    avgVolumeArr: (number | null)[],
    atrArr: (number | null)[]
): Promise<Omit<Signal, 'displayTime' | 'serverTime' | 'strategy'> | null> {

    // Ensure we have enough data to look back on
    if (i < 2) return null;

    // We generate signals based on the completed, previous candle's data.
    const signalCandle = chartData[i - 1];
    
    // --- Indicator Values for the Signal Candle ---
    const emaFast = indicators.getValueAt(emaFastArr, i - 1) ?? 0;
    const emaSlow = indicators.getValueAt(emaSlowArr, i - 1) ?? 0;
    const rsi = indicators.getValueAt(rsiArr, i - 1) ?? 0;
    const psar = indicators.getValueAt(psarArr, i - 1) ?? 0;
    const volume = indicators.getValueAt(chartData.map(d => d.volume), i-1) ?? 0;
    const avgVolume = indicators.getValueAt(avgVolumeArr, i - 1) ?? 0;
    const atr = indicators.getValueAt(atrArr, i-1) ?? 0;

    // --- Indicator Values for the candle *before* the signal candle ---
    const emaFastPrev = indicators.getValueAt(emaFastArr, i - 2) ?? 0;
    const emaSlowPrev = indicators.getValueAt(emaSlowArr, i - 2) ?? 0;

    // --- Absolute Minimum Volume Filter ---
    let minVolumeMultiplier: number;

    if (params.EMA_FAST_PERIOD < 10) {
        minVolumeMultiplier = 0.35; 
    } else if (params.EMA_FAST_PERIOD < 20) {
        minVolumeMultiplier = 0.25;
    } else {
        minVolumeMultiplier = 0.15;
    }

    const minVolumeFloor = avgVolume * minVolumeMultiplier;
    if (volume < minVolumeFloor) {
        log(`Volume too low. Vol: ${volume.toFixed(0)} < Min Floor: ${minVolumeFloor.toFixed(0)} (${minVolumeMultiplier*100}% of AvgVol). Skipping signal.`);
        return null;
    }


    let signalType: 'BUY' | 'SELL' | null = null;
    let confidence: Signal['level'] | null = null;
    
    log(`Evaluating signal on previous candle: { time: '${new Date(signalCandle.time).toISOString()}', close: '${signalCandle.close.toFixed(6)}' }`);

    // --- High-Confidence Crossover Logic ---
    log('=== High-Confidence Crossover Conditions ===');
    const roundedEmaFast = parseFloat(emaFast.toFixed(EMA_ROUNDING_DECIMALS));
    const roundedEmaSlow = parseFloat(emaSlow.toFixed(EMA_ROUNDING_DECIMALS));
    const roundedEmaFastPrev = parseFloat(emaFastPrev.toFixed(EMA_ROUNDING_DECIMALS));
    const roundedEmaSlowPrev = parseFloat(emaSlowPrev.toFixed(EMA_ROUNDING_DECIMALS));
    
    const emaCrossedUp = roundedEmaFastPrev <= roundedEmaSlowPrev && roundedEmaFast > roundedEmaSlow;
    logCond('EMA Crossover Up', emaCrossedUp, `Prev Fast: ${roundedEmaFastPrev} <= Prev Slow: ${roundedEmaSlowPrev} | Curr Fast: ${roundedEmaFast} > Curr Slow: ${roundedEmaSlow}`);
    
    const emaCrossedDown = roundedEmaFastPrev >= roundedEmaSlowPrev && roundedEmaFast < roundedEmaSlow;
    logCond('EMA Crossover Down', emaCrossedDown, `Prev Fast: ${roundedEmaFastPrev} >= Prev Slow: ${roundedEmaSlowPrev} | Curr Fast: ${roundedEmaFast} < Curr Slow: ${roundedEmaSlow}`);

    const rsiBuyRange = rsi < params.RSI_OVERBOUGHT_THRESHOLD;
    logCond('RSI Buy Range', rsiBuyRange, `RSI: ${rsi.toFixed(2)} < ${params.RSI_OVERBOUGHT_THRESHOLD}`);

    const rsiSellRange = rsi > params.RSI_OVERSOLD_THRESHOLD;
    logCond('RSI Sell Range', rsiSellRange, `RSI: ${rsi.toFixed(2)} > ${params.RSI_OVERSOLD_THRESHOLD}`);

    const psarBuyConfirm = psar < signalCandle.close;
    logCond('PSAR Buy Confirmation', psarBuyConfirm, `PSAR: ${psar.toFixed(5)} < Close: ${signalCandle.close.toFixed(5)}`);
    
    const psarSellConfirm = psar > signalCandle.close;
    logCond('PSAR Sell Confirmation', psarSellConfirm, `PSAR: ${psar.toFixed(5)} > Close: ${signalCandle.close.toFixed(5)}`);
    
    const highVolTarget = (avgVolume * params.VOLUME_THRESHOLD_MULTIPLIER);
    const volumeConditionHigh = volume > highVolTarget;
    logCond(`Volume Confirmation (High)`, volumeConditionHigh, `Vol ${volume.toFixed(2)} > (AvgVol ${avgVolume.toFixed(2)} * ${params.VOLUME_THRESHOLD_MULTIPLIER}) = ${highVolTarget.toFixed(2)}`);

    if (emaCrossedUp && rsiBuyRange && volumeConditionHigh) {
        signalType = 'BUY';
        confidence = psarBuyConfirm ? 'High' : 'Medium';
        log(`Signal Decision: ${confidence}-Confidence BUY by Crossover.`);
    } 
    else if (emaCrossedDown && rsiSellRange && volumeConditionHigh) {
        signalType = 'SELL';
        confidence = psarSellConfirm ? 'High' : 'Medium';
        log(`Signal Decision: ${confidence}-Confidence SELL by Crossover.`);
    }

    // --- Medium-Confidence Pullback Logic ---
    if (!signalType) {
        log('=== Medium-Confidence Pullback Conditions ===');
        const medVolTarget = (avgVolume * params.VOLUME_THRESHOLD_MULTIPLIERConfirmation);
        const volumeConditionMedium = volume > medVolTarget;

        const isUptrend = emaFast > emaSlow;
        logCond('Established Uptrend', isUptrend, `Fast: ${emaFast.toFixed(5)} > Slow: ${emaSlow.toFixed(5)}`);

        const isDowntrend = emaFast < emaSlow;
        logCond('Established Downtrend', isDowntrend, `Fast: ${emaFast.toFixed(5)} < Slow: ${emaSlow.toFixed(5)}`);
        
        const rejectionBuffer = atr * 0.1;
        const isPullbackBuy = isUptrend && signalCandle.low <= emaSlow && (signalCandle.close > emaSlow + rejectionBuffer);
        logCond('Pullback to Slow EMA (Buy)', isPullbackBuy, `SignalLow (${signalCandle.low.toFixed(5)}) <= SlowEMA (${emaSlow.toFixed(5)}) AND SignalClose (${signalCandle.close.toFixed(5)}) > SlowEMA + RejectionBuffer (${(emaSlow + rejectionBuffer).toFixed(5)})`);

        const rsiOkForBuyPullback = rsi > 40 && rsi < params.RSI_OVERBOUGHT_THRESHOLD;
        logCond('Healthy RSI for Buy Pullback', rsiOkForBuyPullback, `40 < RSI (${rsi.toFixed(2)}) < ${params.RSI_OVERBOUGHT_THRESHOLD}`);
        
        logCond('PSAR Confirms Uptrend (Buy)', psarBuyConfirm, `PSAR: ${psar.toFixed(5)} < Close: ${signalCandle.close.toFixed(5)}`);

        logCond(`Volume Confirmation (Medium)`, volumeConditionMedium, `Vol ${volume.toFixed(2)} > (AvgVol ${avgVolume.toFixed(2)} * ${params.VOLUME_THRESHOLD_MULTIPLIERConfirmation}) = ${medVolTarget.toFixed(2)}`);

        if (isPullbackBuy && rsiOkForBuyPullback && volumeConditionMedium) {
            signalType = 'BUY';
            confidence = psarBuyConfirm ? 'High' : 'Medium';
            log(`Signal Decision: ${confidence}-Confidence BUY by Pullback.`);
        }

        const isPullbackSell = isDowntrend && signalCandle.high >= emaSlow && (signalCandle.close < emaSlow - rejectionBuffer);
        logCond('Pullback to Slow EMA (Sell)', isPullbackSell, `SignalHigh (${signalCandle.high.toFixed(5)}) >= SlowEMA (${emaSlow.toFixed(5)}) AND SignalClose (${signalCandle.close.toFixed(5)}) < SlowEMA - RejectionBuffer (${(emaSlow - rejectionBuffer).toFixed(5)})`);
        
        const rsiOkForSellPullback = rsi > params.RSI_OVERSOLD_THRESHOLD && rsi < 60;
        logCond('Healthy RSI for Sell Pullback', rsiOkForSellPullback, `${params.RSI_OVERSOLD_THRESHOLD} < RSI (${rsi.toFixed(2)}) < 60`);
        
        logCond('PSAR Confirms Downtrend (Sell)', psarSellConfirm, `PSAR: ${psar.toFixed(5)} > Close: ${signalCandle.close.toFixed(5)}`);
        
        if (!signalType && isPullbackSell && rsiOkForSellPullback && volumeConditionMedium) {
             signalType = 'SELL';
             confidence = psarSellConfirm ? 'High' : 'Medium';
             log(`Signal Decision: ${confidence}-Confidence SELL by Pullback.`);
        }
    }

    if (signalType && confidence) {
        log(`✔✔✔ Final Decision: VALID ${confidence.toUpperCase()} ${signalType} SIGNAL!`);
        return {
            type: signalType,
            level: confidence,
            price: signalCandle.close, // Entry price is the close of the signal candle
            time: signalCandle.time,
        };
    }

    if ((global as any).ENABLE_DETAILED_LOGS) {
        log('No potential signal found in this run.');
    }

    return null;
}
