
import type { ChartDataPoint } from './types';

// =================================================================================
// TECHNICAL INDICATOR LIBRARY
// =================================================================================
// This file contains pure functions for calculating various technical indicators.
// Each function takes historical market data and returns the calculated values.
// =================================================================================

/**
 * Calculates Simple Moving Average (SMA)
 */
export function calculateSMA(data: number[], period: number): (number | null)[] {
    if (period > data.length) return Array(data.length).fill(null);
    
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
 * Calculates Exponential Moving Average (EMA)
 */
export function calculateEMA(data: number[], period: number): (number | null)[] {
    if (period > data.length) return Array(data.length).fill(null);

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
    if (period >= data.length) return Array(data.length).fill(null);

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
    if (period > data.length) {
        return { 
            middle: Array(data.length).fill(null), 
            upper: Array(data.length).fill(null), 
            lower: Array(data.length).fill(null) 
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
    const emaFast = calculateEMA(data, fastPeriod);
    const emaSlow = calculateEMA(data, slowPeriod);

    const macdLine: (number|null)[] = [];
    for (let i = 0; i < data.length; i++) {
        if (emaFast[i] !== null && emaSlow[i] !== null) {
            macdLine.push(emaFast[i]! - emaSlow[i]!);
        } else {
            macdLine.push(null);
        }
    }

    const macdValues = macdLine.filter(v => v !== null) as number[];
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
    if (data.length < 2) return Array(data.length).fill(null);
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
// Add this to '@/lib/indicators.ts' or equivalent
export function calculateATR(highs: number[], lows: number[], closes: number[], period: number): number[] {
    if (highs.length !== lows.length || highs.length !== closes.length || highs.length < period + 1) {
      return [];
    }
  
    const atr: number[] = [];
    const tr: number[] = [];
  
    // Calculate True Range for each period
    for (let i = 1; i < highs.length; i++) {
      const trueRange = Math.max(
        highs[i] - lows[i], // Current high to low
        Math.abs(highs[i] - closes[i - 1]), // Current high to previous close
        Math.abs(lows[i] - closes[i - 1]) // Current low to previous close
      );
      tr.push(trueRange);
    }
  
    // Initial ATR (Simple Moving Average of first 'period' TR values)
    let sumTr = tr.slice(0, period).reduce((a, b) => a + b, 0);
    atr.push(sumTr / period);
  
    // Subsequent ATR values (using Wilder's smoothing)
    for (let i = period; i < tr.length; i++) {
      const prevAtr = atr[i - period];
      atr.push((prevAtr * (period - 1) + tr[i]) / period);
    }
  
    return atr;
  }