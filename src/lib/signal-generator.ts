

'use server';
import type { ChartDataPoint, SignalResult, StrategyParams, StrategyType } from '@/lib/types';
import * as indicators from './indicators';

const gv = (arr: (number | null)[], index: number, fallback: number = 0): number => {
    const val = indicators.getValueAt(arr, index);
    return val === null || isNaN(val) ? fallback : val;
};

function candleStrength(candle: ChartDataPoint) {
    const range = candle.high - candle.low;
    return range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
}

export async function generateSignal(
    i: number,
    candles: ChartDataPoint[],
    params: StrategyParams,
    strategyType: StrategyType,
    verbose: boolean = false,
): Promise<SignalResult> {

    const c = candles[i];
    const closes = candles.map(c => c.close);
    const volumes = candles.map(d => d.volume);
    const logPrefix = `[SignalGen-${strategyType}]`;

    const eFast = gv(indicators.calculateEMA(closes, params.EMA_FAST_PERIOD), i);
    const eSlow = gv(indicators.calculateEMA(closes, params.EMA_SLOW_PERIOD), i);
    const eLong = gv(indicators.calculateEMA(closes, params.EMA_LONG_PERIOD), i);
    const rsi = gv(indicators.calculateRSI(closes, params.RSI_PERIOD), i, 50);
    const vol = gv(volumes, i, 0);
    const volSmaArr = indicators.calculateSMA(volumes, params.VOLUME_PERIOD);
    const vAvg = gv(volSmaArr, i, 1);
  
    const isPrimaryUpTrend = eFast > eSlow;
    const isPrimaryDownTrend = eFast < eSlow;
    const isLongTermUpTrend = c.close > eLong;
    const isLongTermDownTrend = c.close < eLong;
    const enoughVolume = vol > vAvg * params.VOLUME_THRESHOLD_MULTIPLIER;

    if (verbose) {
        console.log(`${logPrefix} Checking conditions for candle at time ${new Date(c.time).toISOString()}`);
        console.log(`${logPrefix} │`);
        console.log(`${logPrefix} ├─ Indicators:`);
        console.log(`${logPrefix} │  ├─ EMA Fast: ${eFast.toFixed(5)}`);
        console.log(`${logPrefix} │  ├─ EMA Slow: ${eSlow.toFixed(5)}`);
        console.log(`${logPrefix} │  ├─ EMA Long: ${eLong.toFixed(5)}`);
        console.log(`${logPrefix} │  ├─ RSI: ${rsi.toFixed(2)} (Oversold: ${params.RSI_OVERSOLD}, Overbought: ${params.RSI_OVERBOUGHT})`);
        console.log(`${logPrefix} │  ├─ Volume: ${vol.toFixed(2)}`);
        console.log(`${logPrefix} │  ├─ Avg Volume: ${vAvg.toFixed(2)}`);
        console.log(`${logPrefix} │  └─ Volume Threshold: ${(vAvg * params.VOLUME_THRESHOLD_MULTIPLIER).toFixed(2)}`);
        console.log(`${logPrefix} │`);
        console.log(`${logPrefix} ├─ Conditions:`);
        console.log(`${logPrefix} │  ├─ Primary Trend Up? ${isPrimaryUpTrend}`);
        console.log(`${logPrefix} │  ├─ Primary Trend Down? ${isPrimaryDownTrend}`);
        console.log(`${logPrefix} │  ├─ Long-Term Filter Up? ${isLongTermUpTrend}`);
        console.log(`${logPrefix} │  ├─ Long-Term Filter Down? ${isLongTermDownTrend}`);
        console.log(`${logPrefix} │  └─ Enough Volume? ${enoughVolume}`);
        console.log(`${logPrefix} │`);
    }

    let entry = false;
    let side: 'long' | 'short' | undefined;
  
    if (isPrimaryUpTrend && isLongTermUpTrend && enoughVolume && rsi > params.RSI_OVERSOLD) {
        if (verbose) console.log(`${logPrefix} ├─ Logic Path: Potential LONG entry`);
      if (c.low < eFast && c.close > eFast) {
          if (verbose) console.log(`${logPrefix} │  └─ ✓ SUCCESS: Price pulled back to and crossed above Fast EMA.`);
          entry = true;
          side = 'long';
      } else {
          if (verbose) console.log(`${logPrefix} │  └─ ✗ FAILED: Price did not pull back to and cross above Fast EMA (Low: ${c.low.toFixed(5)}, Close: ${c.close.toFixed(5)}, EMA Fast: ${eFast.toFixed(5)}).`);
      }
    }
  
    if (isPrimaryDownTrend && isLongTermDownTrend && enoughVolume && rsi < params.RSI_OVERBOUGHT) {
        if (verbose) console.log(`${logPrefix} ├─ Logic Path: Potential SHORT entry`);
      if (c.high > eFast && c.close < eFast) {
          if (verbose) console.log(`${logPrefix} │  └─ ✓ SUCCESS: Price pulled back to and crossed below Fast EMA.`);
          entry = true;
          side = 'short';
      } else {
        if (verbose) console.log(`${logPrefix} │  └─ ✗ FAILED: Price did not pull back to and cross below Fast EMA (High: ${c.high.toFixed(5)}, Close: ${c.close.toFixed(5)}, EMA Fast: ${eFast.toFixed(5)}).`);
      }
    }
  
    if (!entry || !side) {
        if (verbose) console.log(`${logPrefix} └─ Final decision: No entry signal generated.`);
        return { confidence: 0 };
    }
  
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
    if (verbose) console.log(`${logPrefix} └─ Final decision: ${side.toUpperCase()} signal generated with confidence ${confidence.toFixed(4)}.`);

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
