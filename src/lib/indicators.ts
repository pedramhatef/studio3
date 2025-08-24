

import type { ChartDataPoint } from './types';

// =================================================================================
// TECHNICAL INDICATOR LIBRARY
// =================================================================================
// This file contains pure functions for calculating various technical indicators.
// Each function takes historical market data and returns the calculated values.
// =================================================================================

function logcond(source: string, message: string, ...args: any[]) {
    const params = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    console.log(`[${source}] ${message}`, params);
}

/**
 * Safely gets a value from a numeric array at a specific index.
 * Returns null if the index is out of bounds or the value is invalid.
 */
export const getValueAt = (arr: (number | null)[], idx: number): number | null => {
    if (idx < 0 || idx >= arr.length) return null;
    const value = arr[idx];
    return value === null || typeof value === 'undefined' || isNaN(value) ? null : value;
};


/**
 * Calculates Simple Moving Average (SMA)
 */
export function calculateSMA(data: number[], period: number): (number | null)[] {
    if (period <= 0 || period > data.length) {
        logcond('indicators', `[calculateSMA] Invalid period (${period}) or insufficient data (${data.length}). Returning empty array.`);
        return [];
    }
    
    const result: (number | null)[] = Array(period - 1).fill(null);
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += data[i];
    }
    result.push(sum / period);

    for (let i = period; i < data.length; i++) {
        sum = sum - data[i - period] + data[i];
        result.push(sum / period);
    }
    return result;
}

/**
 * Calculates Standard Deviation.
 */
export function calculateStdDev(data: number[], period: number): (number | null)[] {
    if (period <= 0 || period > data.length) return [];

    const results: (number | null)[] = Array(period - 1).fill(null);

    for (let i = period - 1; i < data.length; i++) {
        const slice = data.slice(i - period + 1, i + 1);
        const mean = slice.reduce((acc, val) => acc + val, 0) / period;
        const variance = slice.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / period;
        results.push(Math.sqrt(variance));
    }
    return results;
}


/**
 * Calculates Exponential Moving Average (EMA)
 */
export function calculateEMA(data: number[], period: number): (number | null)[] {
    if (period <= 0 || period > data.length) {
        logcond('indicators', `[calculateEMA] Invalid period (${period}) or insufficient data (${data.length}). Returning empty array.`);
        return [];
    }

    const result: (number | null)[] = Array(period - 1).fill(null);
    const k = 2 / (period + 1);
    
    // First EMA is the SMA of the first 'period' values
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += data[i];
    }
    let ema = sum / period;
    result.push(ema);

    for (let i = period; i < data.length; i++) {
        ema = (data[i] * k) + (ema * (1 - k));
        result.push(ema);
    }
    return result;
}

/**
 * Calculates Volume-Weighted Average Price (VWAP) for a given set of intraday data.
 * VWAP resets at the beginning of each new day.
 */
export function calculateVWAP(data: ChartDataPoint[]): (number | null)[] {
    const vwaps: (number | null)[] = [];
    let cumulativeTypicalPriceVolume = 0;
    let cumulativeVolume = 0;
    let lastDay = -1;

    for (let i = 0; i < data.length; i++) {
        const point = data[i];
        const date = new Date(point.time);
        const day = date.getUTCDate();

        if (day !== lastDay) {
            // Reset for the new day
            cumulativeTypicalPriceVolume = 0;
            cumulativeVolume = 0;
            lastDay = day;
        }

        const typicalPrice = (point.high + point.low + point.close) / 3;
        cumulativeTypicalPriceVolume += typicalPrice * point.volume;
        cumulativeVolume += point.volume;

        if (cumulativeVolume > 0) {
            vwaps.push(cumulativeTypicalPriceVolume / cumulativeVolume);
        } else {
            vwaps.push(null);
        }
    }
    return vwaps;
}

/**
 * Calculates Relative Strength Index (RSI)
 */
export function calculateRSI(data: number[], period: number = 14): (number | null)[] {
    if (period <= 0 || period >= data.length) {
        logcond('indicators', `[calculateRSI] Invalid period (${period}) or insufficient data (${data.length}). Returning empty array.`);
        return [];
    }

    const result: (number | null)[] = Array(period).fill(null);
    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
        const diff = data[i] - data[i - 1];
        if (diff > 0) {
            gains += diff;
        } else {
            losses -= diff; // losses are positive
        }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    const pushRSI = () => {
        if (avgLoss === 0) {
            result.push(100);
        } else {
            const rs = avgGain / avgLoss;
            result.push(100 - (100 / (1 + rs)));
        }
    };

    pushRSI();

    for (let i = period + 1; i < data.length; i++) {
        const diff = data[i] - data[i - 1];
        let gain = 0;
        let loss = 0;
        if (diff > 0) {
            gain = diff;
        } else {
            loss = -diff;
        }

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        
        pushRSI();
    }

    return result;
}

/**
 * Calculates Bollinger Bands (BB)
 */
export function calculateBollingerBands(data: number[], period: number = 20, stdDev: number = 2): { middle: (number|null)[], upper: (number|null)[], lower: (number|null)[] } {
    if (period <= 0 || period > data.length) {
        logcond('indicators', `[calculateBollingerBands] Invalid period (${period}) or insufficient data (${data.length}). Returning empty result.`);
        return { 
            middle: [], 
            upper: [], 
            lower: [] 
        };
    }

    const middle = calculateSMA(data, period);
    const upper: (number | null)[] = Array(period - 1).fill(null);
    const lower: (number | null)[] = Array(period - 1).fill(null);
    
    for (let i = period - 1; i < data.length; i++) {
        const slice = data.slice(i - period + 1, i + 1);
        const mean = middle[i];
        if (mean === null) {
            upper.push(null);
            lower.push(null);
            continue;
        }
        const variance = slice.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / period;
        const sd = Math.sqrt(variance);
        upper.push(mean + sd * stdDev);
        lower.push(mean - sd * stdDev);
    }
    
    return { middle, upper, lower };
}


/**
 * Calculates Moving Average Convergence Divergence (MACD)
 */
export function calculateMACD(data: number[], fastPeriod: number, slowPeriod: number, signalPeriod: number): { macd: (number|null)[], signal: (number|null)[], histogram: (number|null)[] } {
    if (fastPeriod <= 0 || slowPeriod <= 0 || signalPeriod <= 0 || fastPeriod >= slowPeriod) {
        return {
            macd: [],
            signal: [],
            histogram: [],
        };
    }

    const emaFast = calculateEMA(data, fastPeriod);
    const emaSlow = calculateEMA(data, slowPeriod);
    if(emaFast.length === 0 || emaSlow.length === 0) return { macd: [], signal: [], histogram: [] };

    const macdLine: (number|null)[] = [];
    for (let i = 0; i < data.length; i++) {
        if (emaFast[i] !== null && emaSlow[i] !== null) {
            macdLine.push(emaFast[i]! - emaSlow[i]!);
        } else {
            macdLine.push(null);
        }
    }

    const macdValues = macdLine.filter(v => v !== null) as number[];
    if(macdValues.length < signalPeriod) return { macd: [], signal: [], histogram: [] };
    
    const signalLineRaw = calculateEMA(macdValues, signalPeriod);
    
    const signalLine: (number|null)[] = Array(data.length - macdValues.length).fill(null).concat(signalLineRaw);

    const histogram: (number|null)[] = [];
    for(let i = 0; i < data.length; i++) {
        if (macdLine[i] !== null && signalLine[i] !== null) {
            histogram.push(macdLine[i]! - signalLine[i]!);
        } else {
            histogram.push(null);
        }
    }

    return { macd: macdLine, signal: signalLine, histogram };
}

/**
 * Calculates Parabolic SAR (Stop and Reverse)
 */
export function calculateParabolicSAR(data: ChartDataPoint[], step: number, max: number): (number | null)[] {
    if (data.length < 2) return [];
    const sar: (number | null)[] = [null];
    let isRising = data[1].high > data[0].high;
    let af = step;
    let ep = isRising ? data[1].high : data[1].low;
    let currentSar = isRising ? data[0].low : data[0].high;

    sar.push(currentSar);

    for (let i = 2; i < data.length; i++) {
        const prevSar = currentSar;
        
        currentSar = prevSar + af * (ep - prevSar);

        if (isRising) {
            currentSar = Math.min(currentSar, data[i-1].low, data[i-2].low);
            if (data[i].high > ep) {
                ep = data[i].high;
                af = Math.min(af + step, max);
            }
        } else {
            currentSar = Math.max(currentSar, data[i-1].high, data[i-2].high);
            if (data[i].low < ep) {
                ep = data[i].low;
                af = Math.min(af + step, max);
            }
        }
        
        if ((isRising && data[i].low < currentSar) || (!isRising && data[i].high > currentSar)) {
            isRising = !isRising;
            af = step;
            currentSar = ep;
            ep = isRising ? data[i].high : data[i].low;
        }
        
        sar.push(currentSar);
    }
    return sar;
}

/**
 * Calculates Average True Range (ATR)
 */
export function calculateATR(chartData: ChartDataPoint[], period: number): (number | null)[] {
    if (period <= 0 || chartData.length < period) {
        logcond('indicators', `[calculateATR] Invalid period (${period}) or insufficient data (${chartData.length}). Returning empty array.`);
        return [];
    }
    
    const highs = chartData.map(d => d.high);
    const lows = chartData.map(d => d.low);
    const closes = chartData.map(d => d.close);
    
    const tr: number[] = [];
    for (let i = 0; i < highs.length; i++) {
        const high = highs[i];
        const low = lows[i];
        const prevClose = i > 0 ? closes[i - 1] : high; // Use current high if no previous close
        const trueRange = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        tr.push(trueRange);
    }

    const atr: (number | null)[] = Array(period -1).fill(null);

    let sumTr = 0;
    for(let i=0; i<period; i++) {
        sumTr += tr[i];
    }
    let currentAtr = sumTr / period;
    atr.push(currentAtr);
    
    for (let i = period; i < tr.length; i++) {
        currentAtr = (currentAtr * (period - 1) + tr[i]) / period;
        atr.push(currentAtr);
    }

    return atr;
}
