
'use server';

import type { ChartDataPoint, Signal, StrategyParams } from '@/lib/types';
import * as indicators from '@/lib/indicators';

// Helper functions for logging
function log(message: string, ...args: any[]) {
    if ((global as any).ENABLE_DETAILED_LOGS) {
        const timestamp = new Date().toISOString();
        console.log(`${timestamp} [info] ${message}`, ...args);
    }
}

function logCond(name: string, passed: boolean, details?: string) {
    log(`${passed ? '✔' : '✘'} ${name}${details ? ` → ${details}` : ''}`);
}

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

const EMA_ROUNDING_DECIMALS = 7; // Number of decimals to round EMAs to for comparison

export function generateSignal(
    i: number,
    chartData: ChartDataPoint[],
    params: StrategyParams,
    emaFastArr: (number | null)[],
    emaSlowArr: (number | null)[],
    rsiArr: (number | null)[],
    psarArr: (number | null)[],
    avgVolumeArr: (number | null)[],
    atrArr: (number | null)[]
): Omit<Signal, 'displayTime' | 'serverTime'> | null {

    if (i < 2) return null;

    const currentCandle = chartData[i];
    const prevCandle = chartData[i - 1];
    
    const emaFast = indicators.getValueAt(emaFastArr, i - 1) ?? 0;
    const emaSlow = indicators.getValueAt(emaSlowArr, i - 1) ?? 0;
    const rsi = indicators.getValueAt(rsiArr, i - 1) ?? 0;
    const psar = indicators.getValueAt(psarArr, i - 1) ?? 0;
    const volume = indicators.getValueAt(chartData.map(d => d.volume), i-1) ?? 0;
    const avgVolume = indicators.getValueAt(avgVolumeArr, i - 1) ?? 0;
    const atr = indicators.getValueAt(atrArr, i-1) ?? 0;

    const emaFastPrev = indicators.getValueAt(emaFastArr, i - 2) ?? 0;
    const emaSlowPrev = indicators.getValueAt(emaSlowArr, i - 2) ?? 0;

    let signal: 'BUY' | 'SELL' | null = null;
    let confidence: Signal['level'] | null = null;
    
    log(`Evaluating signal on previous candle: { time: '${new Date(prevCandle.time).toISOString()}', close: '${prevCandle.close.toFixed(6)}' }`);

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

    const psarBuyConfirm = psar < prevCandle.close;
    logCond('PSAR Buy Confirmation', psarBuyConfirm, `PSAR: ${psar.toFixed(5)} < Close: ${prevCandle.close.toFixed(5)}`);

    const psarSellConfirm = psar > prevCandle.close;
    logCond('PSAR Sell Confirmation', psarSellConfirm, `PSAR: ${psar.toFixed(5)} > Close: ${prevCandle.close.toFixed(5)}`);
    
    const highVolTarget = (avgVolume * params.VOLUME_THRESHOLD_MULTIPLIER);
    const volumeConditionHigh = volume > highVolTarget;
    logCond(`Volume Confirmation (High)`, volumeConditionHigh, `Vol ${volume.toFixed(2)} > (AvgVol ${avgVolume.toFixed(2)} * ${params.VOLUME_THRESHOLD_MULTIPLIER}) = ${highVolTarget.toFixed(2)}`);

    if (emaCrossedUp && rsiBuyRange && psarBuyConfirm && volumeConditionHigh) {
        signal = 'BUY';
        confidence = 'High';
        log('Signal Decision: High-Confidence BUY by Crossover.');
    } 
    else if (emaCrossedDown && rsiSellRange && psarSellConfirm && volumeConditionHigh) {
        signal = 'SELL';
        confidence = 'High';
        log('Signal Decision: High-Confidence SELL by Crossover.');
    }

    // --- Medium-Confidence Pullback Logic ---
    if (!signal) {
        log('=== Medium-Confidence Pullback Conditions ===');
        const medVolTarget = (avgVolume * params.VOLUME_THRESHOLD_MULTIPLIERConfirmation);
        const volumeConditionMedium = volume > medVolTarget;

        const isUptrend = emaFast > emaSlow;
        logCond('Established Uptrend', isUptrend, `Fast: ${emaFast.toFixed(5)} > Slow: ${emaSlow.toFixed(5)}`);

        const isDowntrend = emaFast < emaSlow;
        logCond('Established Downtrend', isDowntrend, `Fast: ${emaFast.toFixed(5)} < Slow: ${emaSlow.toFixed(5)}`);

        const isPullbackBuy = isUptrend && prevCandle.low <= emaSlow && prevCandle.close > emaSlow;
        logCond('Pullback to Slow EMA (Buy)', isPullbackBuy, `PrevLow (${prevCandle.low.toFixed(5)}) <= SlowEMA (${emaSlow.toFixed(5)}) AND PrevClose (${prevCandle.close.toFixed(5)}) > SlowEMA`);

        const rsiOkForBuyPullback = rsi > 40 && rsi < params.RSI_OVERBOUGHT_THRESHOLD;
        logCond('Healthy RSI for Buy Pullback', rsiOkForBuyPullback, `40 < RSI (${rsi.toFixed(2)}) < ${params.RSI_OVERBOUGHT_THRESHOLD}`);
        
        logCond('PSAR Confirms Uptrend (Buy)', psarBuyConfirm, `PSAR: ${psar.toFixed(5)} < Close: ${prevCandle.close.toFixed(5)}`);

        logCond(`Volume Confirmation (Medium)`, volumeConditionMedium, `Vol ${volume.toFixed(2)} > (AvgVol ${avgVolume.toFixed(2)} * ${params.VOLUME_THRESHOLD_MULTIPLIERConfirmation}) = ${medVolTarget.toFixed(2)}`);

        if (isPullbackBuy && rsiOkForBuyPullback && psarBuyConfirm && volumeConditionMedium) {
            signal = 'BUY';
            confidence = 'Medium';
            log('Signal Decision: Medium-Confidence BUY by Pullback.');
        }

        const isPullbackSell = isDowntrend && prevCandle.high >= emaSlow && prevCandle.close < emaSlow;
        logCond('Pullback to Slow EMA (Sell)', isPullbackSell, `PrevHigh (${prevCandle.high.toFixed(5)}) >= SlowEMA (${emaSlow.toFixed(5)}) AND PrevClose (${prevCandle.close.toFixed(5)}) < SlowEMA`);
        
        const rsiOkForSellPullback = rsi > params.RSI_OVERSOLD_THRESHOLD && rsi < 60;
        logCond('Healthy RSI for Sell Pullback', rsiOkForSellPullback, `${params.RSI_OVERSOLD_THRESHOLD} < RSI (${rsi.toFixed(2)}) < 60`);

        logCond('PSAR Confirms Downtrend (Sell)', psarSellConfirm, `PSAR: ${psar.toFixed(5)} > Close: ${prevCandle.close.toFixed(5)}`);
        
        if (!signal && isPullbackSell && rsiOkForSellPullback && psarSellConfirm && volumeConditionMedium) {
             signal = 'SELL';
             confidence = 'Medium';
             log('Signal Decision: Medium-Confidence SELL by Pullback.');
        }
    }

    // --- Final Validation ---
    if (signal && confidence) {
        log('=== Final Validation on Current Candle ===');
        const minPriceMovement = atr * params.NOISE_FILTER_RATIO;
        const candleRange = currentCandle.high - currentCandle.low;
        const atrFilterPassed = candleRange >= minPriceMovement;
        logCond('ATR Noise Filter', atrFilterPassed, `Candle Range (${candleRange.toFixed(5)}) >= Min Movement (${minPriceMovement.toFixed(5)})`);

        // Dynamic candle strength threshold based on volatility
        const dynamicStrengthThreshold = Math.min(0.3, Math.max(0.15, atr / currentCandle.close * 20)); // scales with ATR % of price
        log(`Dynamic candle strength threshold: ${dynamicStrengthThreshold.toFixed(3)}`)

        const isBullishConfirm = isCandleBullish(currentCandle) && candleStrength(currentCandle) > dynamicStrengthThreshold;
        logCond('Is Bullish Confirmation', isBullishConfirm, `Close > Open AND Strength (${candleStrength(currentCandle).toFixed(2)}) > ${dynamicStrengthThreshold.toFixed(2)}`);
        const isBearishConfirm = isCandleBearish(currentCandle) && candleStrength(currentCandle) > dynamicStrengthThreshold;
        logCond('Is Bearish Confirmation', isBearishConfirm, `Close < Open AND Strength (${candleStrength(currentCandle).toFixed(2)}) > ${dynamicStrengthThreshold.toFixed(2)}`);

        const buySignalValid = signal === 'BUY' && isBullishConfirm && atrFilterPassed;
        const sellSignalValid = signal === 'SELL' && isBearishConfirm && atrFilterPassed;

        if (buySignalValid || sellSignalValid) {
            log(`✔✔✔ Final Decision: VALID ${confidence.toUpperCase()} ${signal} SIGNAL!`);
            return {
                type: signal,
                level: confidence,
                price: currentCandle.open,
                time: currentCandle.time,
            };
        } else {
             log(`✘✘✘ Final Decision: Signal invalidated by final filters.`);
        }
    } else {
        log('No potential signal found in this run.');
    }

    return null;
}
