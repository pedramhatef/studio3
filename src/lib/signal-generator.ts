
'use server';

import type { ChartDataPoint, Signal, StrategyParams } from '@/lib/types';
import * as indicators from '@/lib/indicators';

// Helper functions for logging
function log(message: string, ...args: any[]) {
    const timestamp = new Date().toISOString();
    // A simple console.log is fine, but a more robust logging service could be used here
    console.log(`${timestamp} [info] ${message}`, ...args);
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


// This function encapsulates the core logic for generating a trading signal.
// It is designed to be used by both the backtester and the live cron job.
export function generateSignal(
    i: number, // The current candle index
    chartData: ChartDataPoint[],
    params: StrategyParams,
    emaFastArr: (number | null)[],
    emaSlowArr: (number | null)[],
    rsiArr: (number | null)[],
    psarArr: (number | null)[],
    avgVolumeArr: (number | null)[],
    atrArr: (number | null)[],
    volumeMultiplier: (number | null)[]
): Omit<Signal, 'displayTime' | 'serverTime'> | null {

    if (i < 1) return null; // Need at least one previous candle

    const currentCandle = chartData[i];
    const prevCandle = chartData[i - 1];
    
    // --- Indicator Values for the PREVIOUS candle ---
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

    // --- High-Confidence Crossover Logic ---
    const emaCrossedUp = emaFastPrev <= emaSlowPrev && emaFast > emaSlow;
    const emaCrossedDown = emaFastPrev >= emaSlowPrev && emaFast < emaSlow;
    const volumeConditionHigh = volume > (avgVolume * params.VOLUME_THRESHOLD_MULTIPLIER);
    
    if (emaCrossedUp && rsi < params.RSI_OVERBOUGHT_THRESHOLD && psar < prevCandle.close && volumeConditionHigh) {
        signal = 'BUY';
        confidence = 'High';
        log('High-Confidence BUY Signal Triggered by Crossover.');
    } 
    else if (emaCrossedDown && rsi > params.RSI_OVERSOLD_THRESHOLD && psar > prevCandle.close && volumeConditionHigh) {
        signal = 'SELL';
        confidence = 'High';
        log('High-Confidence SELL Signal Triggered by Crossover.');
    }

    // --- Medium-Confidence Pullback Logic ---
    if (!signal) {
        const volumeConditionMedium = volume > (avgVolume * params.VOLUME_THRESHOLD_MULTIPLIERConfirmation);
        const isUptrend = emaFast > emaSlow;
        const isDowntrend = emaFast < emaSlow;

        // Pullback Buy: In an uptrend, price dips to slow EMA and bounces.
        const isPullbackBuy = isUptrend && prevCandle.low <= emaSlow && prevCandle.close > emaSlow;
        const rsiOkForBuyPullback = rsi > 40 && rsi < params.RSI_OVERBOUGHT_THRESHOLD;

        if (isPullbackBuy && rsiOkForBuyPullback && psar < prevCandle.close && volumeConditionMedium) {
            signal = 'BUY';
            confidence = 'Medium';
            log('Medium-Confidence BUY Signal Triggered by Pullback.');
        }

        // Pullback Sell: In a downtrend, price rallies to slow EMA and is rejected.
        const isPullbackSell = isDowntrend && prevCandle.high >= emaSlow && prevCandle.close < emaSlow;
        const rsiOkForSellPullback = rsi < 60 && rsi > params.RSI_OVERSOLD_THRESHOLD;
        
        if (isPullbackSell && rsiOkForSellPullback && psar > prevCandle.close && volumeConditionMedium) {
             signal = 'SELL';
             confidence = 'Medium';
             log('Medium-Confidence SELL Signal Triggered by Pullback.');
        }
    }

    // --- Final Validation ---
    if (signal && confidence) {
        // ATR Noise Filter: Ensure the entry candle has meaningful movement
        const minPriceMovement = atr * params.NOISE_FILTER_RATIO;
        const priceChange = Math.abs(currentCandle.open - prevCandle.close);
        const atrFilterPassed = priceChange >= minPriceMovement;

        // Confirmation Candle: Ensure the entry candle moves in the direction of the signal
        const isBullishConfirm = isCandleBullish(currentCandle) && candleStrength(currentCandle) > 0.3;
        const isBearishConfirm = isCandleBearish(currentCandle) && candleStrength(currentCandle) > 0.3;

        const buySignalValid = signal === 'BUY' && isBullishConfirm && atrFilterPassed;
        const sellSignalValid = signal === 'SELL' && isBearishConfirm && atrFilterPassed;

        if (buySignalValid || sellSignalValid) {
            return {
                type: signal,
                level: confidence,
                price: currentCandle.open, // Entry price is the open of the current candle
                time: currentCandle.time,
            };
        } else {
             log(`Signal invalidated by final filters. Type: ${signal}, ATR Passed: ${atrFilterPassed}, Bullish Confirm: ${isBullishConfirm}, Bearish Confirm: ${isBearishConfirm}`);
        }
    }

    return null; // No valid signal generated
}
