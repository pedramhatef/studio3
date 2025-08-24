import type { ChartDataPoint, MarketRegime } from './types';
import * as indicators from './indicators';

const ADX_PERIOD = 14;
const ADX_THRESHOLD = 25; // Threshold to determine if the market is trending or ranging
const TREND_EMA_PERIOD = 200; // Long-term EMA to determine trend direction

function logcond(message: string, ...args: any[]) {
    const params = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' ');
    console.log(`[MarketRegime] ${message}`, params);
}

/**
 * Calculates the Average Directional Index (ADX).
 * ADX is used to determine the strength of a trend, not its direction.
 * @param candles The historical price data.
 * @param period The period for ADX calculation.
 * @returns An array containing ADX, +DI, and -DI values.
 */
function calculateADX(candles: ChartDataPoint[], period: number) {
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);

    const plusDMs: number[] = [0];
    const minusDMs: number[] = [0];

    for (let i = 1; i < highs.length; i++) {
        const upMove = highs[i] - highs[i-1];
        const downMove = lows[i-1] - lows[i];

        plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    const trs = candles.map((c, i) => {
        if (i === 0) return 0;
        return Math.max(c.high - c.low, Math.abs(c.high - candles[i-1].close), Math.abs(c.low - candles[i-1].close));
    });

    const smooth = (data: number[], period: number): number[] => {
        const smoothed: number[] = [data.slice(0, period).reduce((a, b) => a + b, 0)];
        for (let i = period; i < data.length; i++) {
            smoothed.push(smoothed[i-period] - (smoothed[i-period] / period) + data[i]);
        }
        return smoothed;
    }

    const smoothedTR = smooth(trs, period);
    const smoothedPlusDM = smooth(plusDMs, period);
    const smoothedMinusDM = smooth(minusDMs, period);

    const plusDIs: number[] = [];
    const minusDIs: number[] = [];
    for (let i = 0; i < smoothedTR.length; i++) {
        plusDIs.push(smoothedTR[i] > 0 ? (smoothedPlusDM[i] / smoothedTR[i]) * 100 : 0);
        minusDIs.push(smoothedTR[i] > 0 ? (smoothedMinusDM[i] / smoothedTR[i]) * 100 : 0);
    }

    const dxs: number[] = [];
    for (let i = 0; i < plusDIs.length; i++) {
        const sum = plusDIs[i] + minusDIs[i];
        dxs.push(sum > 0 ? (Math.abs(plusDIs[i] - minusDIs[i]) / sum) * 100 : 0);
    }
    
    const adx = smooth(dxs, period);
    
    // Align with original candle length
    const emptyFill = Array(candles.length - adx.length).fill(null);
    return {
      adx: [...emptyFill, ...adx],
      plusDI: [...emptyFill, ...plusDIs],
      minusDI: [...emptyFill, ...minusDIs],
    };
}


/**
 * Detects the current market regime based on ADX and a long-term EMA.
 * @param candles Historical price data.
 * @returns The detected market regime ('trending_up', 'trending_down', or 'ranging').
 */
export async function detectMarketRegime(candles: ChartDataPoint[]): Promise<MarketRegime> {
    if (candles.length < TREND_EMA_PERIOD) {
        logcond(`Not enough data to detect market regime (${candles.length} candles), defaulting to 'ranging'.`);
        return 'ranging';
    }

    try {
        const closes = candles.map(c => c.close);
        const emaTrendArr = indicators.calculateEMA(closes, TREND_EMA_PERIOD);
        const { adx: adxArr, plusDI: plusDIArr, minusDI: minusDIArr } = calculateADX(candles, ADX_PERIOD);
        
        const lastCandle = candles[candles.length - 1];
        const lastADX = indicators.getValueAt(adxArr, adxArr.length - 1) ?? 0;
        const lastPlusDI = indicators.getValueAt(plusDIArr, plusDIArr.length - 1) ?? 0;
        const lastMinusDI = indicators.getValueAt(minusDIArr, minusDIArr.length - 1) ?? 0;
        const lastTrendEMA = indicators.getValueAt(emaTrendArr, emaTrendArr.length - 1) ?? 0;
    
        logcond(`Values - ADX: ${lastADX.toFixed(2)}, +DI: ${lastPlusDI.toFixed(2)}, -DI: ${lastMinusDI.toFixed(2)}, Price: ${lastCandle.close}, Trend EMA: ${lastTrendEMA.toFixed(5)}`);
    
        // Is the market trending?
        if (lastADX > ADX_THRESHOLD) {
            // Yes, it's trending. Now determine direction.
            if (lastPlusDI > lastMinusDI && lastCandle.close > lastTrendEMA) {
                return 'trending_up';
            } else if (lastMinusDI > lastPlusDI && lastCandle.close < lastTrendEMA) {
                return 'trending_down';
            }
        }
    
        // If ADX is weak or other conditions don't align, we are in a ranging market.
        return 'ranging';

    } catch (error) {
        logcond(`Error detecting market regime:`, error);
        return 'ranging'; // Default to ranging on error
    }
}
