
import { NextRequest, NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore } from '@/app/actions';
import type { ChartDataPoint, Signal } from '@/lib/types';

export const revalidate = 0;

// -- Indicator Parameters --
const INDICATOR_PARAMS = {
    RSI_PERIOD: 14,
    RSI_OVERBOUGHT: 70,
    RSI_OVERSOLD: 30,
    RSI_PULLBACK_BUY: 40,
    RSI_PULLBACK_SELL: 60,
    EMA_SLOW_PERIOD: 50,
    EMA_FAST_PERIOD: 21,
    ATR_PERIOD: 14,
    ATR_STOP_MULTIPLIER: 1.5,
    ATR_PROFIT_MULTIPLIER: 2.5,
    VOLUME_AVG_PERIOD: 20,
    VOLUME_SPIKE_FACTOR: 1.5,
};

// --- Helper Functions ---
const calculateEMA = (data: number[], period: number): number[] => {
    if (data.length < period) return Array(data.length).fill(0);
  
    const k = 2 / (period + 1);
    const emaArray: number[] = new Array(period - 1).fill(0);
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += data[i];
    }
    emaArray.push(sum / period);
  
    for (let i = period; i < data.length; i++) {
      emaArray[i] = data[i] * k + emaArray[i - 1] * (1 - k);
    }
    return emaArray;
};
  
const calculateSMA = (data: number[], period: number): (number | null)[] => {
    const smaArray: (number | null)[] = Array(data.length).fill(null);
    if (data.length < period) return smaArray;
  
    let sum = data.slice(0, period).reduce((a, b) => a + b, 0);
    smaArray[period - 1] = sum / period;
  
    for (let i = period; i < data.length; i++) {
      sum += data[i] - data[i - period];
      smaArray[i] = sum / period;
    }
    return smaArray;
};

// Wilder's Smoothing for a more standard RSI calculation
const calculateRSI = (data: number[], period: number): (number | null)[] => {
    if (data.length < period + 1) return Array(data.length).fill(null);
    
    const rsiArray: (number | null)[] = new Array(data.length).fill(null);
    const changes = data.slice(1).map((val, i) => val - data[i]);

    let avgGain = 0;
    let avgLoss = 0;

    // Initial calculation
    const initialChanges = changes.slice(0, period);
    initialChanges.forEach(change => {
        if (change > 0) avgGain += change;
        else avgLoss -= change;
    });

    avgGain /= period;
    avgLoss /= period;
    
    const firstRsiIndex = period;
    if (firstRsiindex < data.length) {
        if (avgLoss === 0) {
            rsiArray[firstRsiIndex] = 100;
        } else {
            const rs = avgGain / avgLoss;
            rsiArray[firstRsiIndex] = 100 - (100 / (1 + rs));
        }
    }

    // Subsequent calculations using Wilder's smoothing
    for (let i = period; i < changes.length; i++) {
        const change = changes[i];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        
        const rsiIndex = i + 1; 
        if (rsiIndex < data.length) {
            if (avgLoss === 0) {
                rsiArray[rsiIndex] = 100;
            } else {
                const rs = avgGain / avgLoss;
                rsiArray[rsiIndex] = 100 - (100 / (1 + rs));
            }
        }
    }
  
    return rsiArray;
};

// ATR calculation for dynamic stop-loss and take-profit
const calculateATR = (chartData: ChartDataPoint[], period: number): (number | null)[] => {
    if (chartData.length < period) return Array(chartData.length).fill(null);

    const atrArray: (number | null)[] = Array(chartData.length).fill(null);
    const trs: number[] = [];

    for (let i = 1; i < chartData.length; i++) {
        const high = chartData[i].high;
        const low = chartData[i].low;
        const prevClose = chartData[i - 1].close;
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trs.push(tr);
    }
    
    if (trs.length < period) return atrArray;

    // Wilder's Smoothing for ATR
    let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
    atrArray[period] = atr;

    for (let i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
      atrArray[i + 1] = atr;
    }

    return atrArray;
}


async function getNewSignal(chartData: ChartDataPoint[]): Promise<Signal | null> {
    const requiredDataLength = Math.max(
        INDICATOR_PARAMS.EMA_SLOW_PERIOD,
        INDICATOR_PARAMS.RSI_PERIOD + 1,
        INDICATOR_PARAMS.ATR_PERIOD + 1,
        INDICATOR_PARAMS.VOLUME_AVG_PERIOD
    );

    if (chartData.length < requiredDataLength) return null;

    const closePrices = chartData.map(p => p.close);
    const volumes = chartData.map(p => p.volume);

    // --- Indicator Calculations ---
    const emaSlow = calculateEMA(closePrices, INDICATOR_PARAMS.EMA_SLOW_PERIOD);
    const emaFast = calculateEMA(closePrices, INDICATOR_PARAMS.EMA_FAST_PERIOD);
    const rsi = calculateRSI(closePrices, INDICATOR_PARAMS.RSI_PERIOD);
    const atr = calculateATR(chartData, INDICATOR_PARAMS.ATR_PERIOD);
    const volumeSMA = calculateSMA(volumes, INDICATOR_PARAMS.VOLUME_AVG_PERIOD);
    
    const lastIndex = chartData.length - 1;

    // Ensure all indicator values for the current candle are available
    if (emaSlow[lastIndex] === 0 || emaFast[lastIndex] === 0 || rsi[lastIndex] === null || atr[lastIndex] === null || volumeSMA[lastIndex] === null) {
      return null;
    }

    const lastCandle = chartData[lastIndex];
    const prevRsi = rsi[lastIndex - 1];
    const lastRsi = rsi[lastIndex];
    const lastAtr = atr[lastIndex]!; // Non-null assertion as we've checked above

    // --- Signal Logic: Mean Reversion Pullback Strategy ---
    
    // BUY Signal Conditions (Pullback in an Uptrend)
    const isUptrend = lastCandle.close > emaSlow[lastIndex];
    const isInBuyPullback = lastCandle.close < emaFast[lastIndex];
    const isRsiBuyTrigger = prevRsi !== null && prevRsi <= INDICATOR_PARAMS.RSI_PULLBACK_BUY && lastRsi > INDICATOR_PARAMS.RSI_PULLBACK_BUY;

    if (isUptrend && isInBuyPullback && isRsiBuyTrigger) {
        let level: Signal['level'] = 'Medium';
        const isVolumeSpike = lastCandle.volume > volumeSMA[lastIndex]! * INDICATOR_PARAMS.VOLUME_SPIKE_FACTOR;
        const isDeepPullback = lastCandle.low < (emaFast[lastIndex] - lastAtr); // Deeper pullback = higher confidence
        if (isDeepPullback && isVolumeSpike) {
            level = 'High';
        }

        return {
            type: 'BUY',
            level: level,
            price: lastCandle.close,
            time: lastCandle.time,
            stopLoss: lastCandle.close - (lastAtr * INDICATOR_PARAMS.ATR_STOP_MULTIPLIER),
            takeProfit: lastCandle.close + (lastAtr * INDICATOR_PARAMS.ATR_PROFIT_MULTIPLIER)
        };
    }

    // SELL Signal Conditions (Pullback in a Downtrend)
    const isDowntrend = lastCandle.close < emaSlow[lastIndex];
    const isInSellPullback = lastCandle.close > emaFast[lastIndex];
    const isRsiSellTrigger = prevRsi !== null && prevRsi >= INDICATOR_PARAMS.RSI_PULLBACK_SELL && lastRsi < INDICATOR_PARAMS.RSI_PULLBACK_SELL;

    if (isDowntrend && isInSellPullback && isRsiSellTrigger) {
        let level: Signal['level'] = 'Medium';
        const isVolumeSpike = lastCandle.volume > volumeSMA[lastIndex]! * INDICATOR_PARAMS.VOLUME_SPIKE_FACTOR;
        const isDeepRally = lastCandle.high > (emaFast[lastIndex] + lastAtr); // Deeper rally = higher confidence for short
        if (isDeepRally && isVolumeSpike) {
            level = 'High';
        }

        return {
            type: 'SELL',
            level: level,
            price: lastCandle.close,
            time: lastCandle.time,
            stopLoss: lastCandle.close + (lastAtr * INDICATOR_PARAMS.ATR_STOP_MULTIPLIER),
            takeProfit: lastCandle.close - (lastAtr * INDICATOR_PARAMS.ATR_PROFIT_MULTIPLIER)
        };
    }
    
    return null;
}

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  if (process.env.NODE_ENV === 'production' && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return new NextResponse('Unauthorized', {
      status: 401,
    });
  }

  try {
    const chartData = await getChartData();
    if (!chartData || chartData.length === 0) {
      return NextResponse.json({ message: 'No chart data fetched.' });
    }

    const newSignal = await getNewSignal(chartData);

    if (newSignal) {
        const signalHistory = await getSignalHistoryFromFirestore();
        const lastSignal = signalHistory.length > 0 ? signalHistory[signalHistory.length - 1] : null;

        // Cooldown: Ensure we don't fire signals on consecutive candles
        if (lastSignal?.time !== newSignal.time) {
             await saveSignalToFirestore(newSignal);
             return NextResponse.json({ message: `Saved ${newSignal.type} signal.`, signal: newSignal });
        } else {
            return NextResponse.json({ message: 'Signal is a duplicate (same timestamp), not saved.', signal: newSignal });
        }
    }

    return NextResponse.json({ message: 'No new signal generated.' });
  } catch (error) {
    console.error('Cron job error:', error);
    return new NextResponse('Internal Server Error', { status: 500, statusText: (error as Error).message });
  }
}
