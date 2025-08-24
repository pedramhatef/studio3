
'use server';

import type { ChartDataPoint, SignalResult, StrategyParams } from '@/lib/types';
import * as indicators from './indicators';

// Helper for safely getting values from indicator arrays.
const gv = (arr: (number | null)[], index: number, fallback: number = 0): number => {
    const val = indicators.getValueAt(arr, index);
    return val === null || isNaN(val) ? fallback : val;
};

// Helper for analyzing candle properties
function candleStrength(candle: ChartDataPoint) {
    const range = candle.high - candle.low;
    return range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
}

/**
 * Generates a trading signal based on the provided data and strategy parameters.
 * This is the core logic engine used by both backtesting and live trading.
 */
export async function generateSignal(
    i: number,
    candles: ChartDataPoint[],
    params: StrategyParams,
    emaFastArr: (number | null)[],
    emaSlowArr: (number | null)[],
    emaLongArr: (number | null)[],
    rsiArr: (number | null)[],
    _atrArr: (number | null)[],
    volSmaArr: (number | null)[]
): Promise<SignalResult> {

    const c = candles[i];
  
    // --- Indicator Values ---
    const eFast = gv(emaFastArr, i);
    const eSlow = gv(emaSlowArr, i);
    const eLong = gv(emaLongArr, i);
    const rsi = gv(rsiArr, i, 50);
    const vol = gv(candles.map(c => c.volume), i, 0);
    const vAvg = gv(volSmaArr, i, 1);
  
    // --- Primary Conditions ---
    const isUpTrend = eFast > eSlow && eSlow > eLong;
    const isDownTrend = eFast < eSlow && eSlow < eLong;
    const enoughVolume = vol > vAvg * params.VOLUME_THRESHOLD_MULTIPLIER;
  
    let entry = false;
    let side: 'long' | 'short' | undefined;
  
    // --- Entry Logic: Pullback to Fast EMA ---
    if (isUpTrend && enoughVolume && rsi > params.RSI_OVERSOLD) {
      if (c.low < eFast && c.close > eFast) {
          entry = true;
          side = 'long';
      }
    }
  
    if (isDownTrend && enoughVolume && rsi < params.RSI_OVERBOUGHT) {
      if (c.high > eFast && c.close < eFast) {
          entry = true;
          side = 'short';
      }
    }
  
    if (!entry || !side) {
        return { confidence: 0 };
    }
  
    // --- Confidence Scoring ---
    const components: number[] = [];
    components.push(Math.min(1, Math.abs(eSlow - eLong) / (eLong * 0.01)));
    components.push(candleStrength(c));
    components.push(Math.min(1, vol / vAvg - params.VOLUME_THRESHOLD_MULTIPLIER));
    if(side === 'long') {
        components.push((rsi - params.RSI_OVERSOLD) / (50 - params.RSI_OVERSOLD));
    } else {
        components.push((params.RSI_OVERBOUGHT - rsi) / (params.RSI_OVERBOUGHT - 50));
    }
    
    const confidence = components.reduce((a, b) => a + b, 0) / components.length;

    // --- Exit Logic ---
    let exit = false;
    let exitReason: string | undefined;

    if (side === 'long' && (rsi > params.RSI_OVERBOUGHT || c.close < eSlow)) {
        exit = true;
        exitReason = rsi > params.RSI_OVERBOUGHT ? 'rsi_overbought' : 'slow_ema_cross';
    } else if (side === 'short' && (rsi < params.RSI_OVERSOLD || c.close > eSlow)) {
        exit = true;
        exitReason = rsi < params.RSI_OVERSOLD ? 'rsi_oversold' : 'slow_ema_cross';
    }
  
    return { entry, exit, side, confidence, exitReason };
}
