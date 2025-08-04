
import { NextRequest, NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore } from '@/app/actions';
import type { ChartDataPoint, Signal } from '@/lib/types';

export const revalidate = 0;

// Indicator Parameters
const INDICATOR_PARAMS = {
    WT_CHANNEL_LENGTH: 10,
    WT_AVERAGE_LENGTH: 21,
    WT_SIGNAL_LENGTH: 4,
    MACD_FAST_PERIOD: 12,
    MACD_SLOW_PERIOD: 26,
    MACD_SIGNAL_PERIOD: 9,
    RSI_PERIOD: 14,
    EMA_TREND_PERIOD: 50,
    VOLUME_AVG_PERIOD: 20,
    VOLUME_SPIKE_FACTOR: 1.8,
    RSI_OB: 70, // RSI Overbought threshold
    RSI_OS: 30, // RSI Oversold threshold
};

// --- Helper Functions ---
const calculateEMA = (data: number[], period: number): number[] => {
    if (data.length === 0) return [];
  
    const k = 2 / (period + 1);
    const emaArray: number[] = [data[0]];
  
    for (let i = 1; i < data.length; i++) {
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
      if (firstRsiIndex < data.length) {
          if (avgLoss === 0) {
              rsiArray[firstRsiIndex] = 100;
          } else {
              const rs = avgGain / avgLoss;
              rsiArray[firstRsiIndex] = 100 - (100 / (1 + rs));
          }
      }
  
      // Subsequent calculations
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

async function getNewSignal(chartData: ChartDataPoint[]): Promise<Signal | null> {
    const requiredDataLength = Math.max(
        INDICATOR_PARAMS.WT_CHANNEL_LENGTH + INDICATOR_PARAMS.WT_AVERAGE_LENGTH,
        INDICATOR_PARAMS.MACD_SLOW_PERIOD,
        INDICATOR_PARAMS.RSI_PERIOD + 1,
        INDICATOR_PARAMS.EMA_TREND_PERIOD,
        INDICATOR_PARAMS.VOLUME_AVG_PERIOD
    );

    if (chartData.length < requiredDataLength) return null;

    const closePrices = chartData.map(p => p.close);
    const lowPrices = chartData.map(p => p.low);
    const highPrices = chartData.map(p => p.high);
    const volumes = chartData.map(p => p.volume);

    // --- Indicator Calculations ---
    const trendEMA = calculateEMA(closePrices, INDICATOR_PARAMS.EMA_TREND_PERIOD);
    const ap = chartData.map(p => (p.high + p.low + p.close) / 3);
    const esa = calculateEMA(ap, INDICATOR_PARAMS.WT_CHANNEL_LENGTH);
    const d = calculateEMA(ap.map((val, i) => Math.abs(val - esa[i])), INDICATOR_PARAMS.WT_CHANNEL_LENGTH);
    const ci = ap.map((val, i) => (d[i] === 0) ? 0 : (val - esa[i]) / (0.015 * d[i]));
    const tci = calculateEMA(ci, INDICATOR_PARAMS.WT_AVERAGE_LENGTH);
    const wt2 = calculateSMA(tci, INDICATOR_PARAMS.WT_SIGNAL_LENGTH);
    const fastEMA = calculateEMA(closePrices, INDICATOR_PARAMS.MACD_FAST_PERIOD);
    const slowEMA = calculateEMA(closePrices, INDICATOR_PARAMS.MACD_SLOW_PERIOD);
    const macdLine = fastEMA.map((val, i) => val - slowEMA[i]);
    const signalLine = calculateEMA(macdLine, INDICATOR_PARAMS.MACD_SIGNAL_PERIOD);
    const rsi = calculateRSI(closePrices, INDICATOR_PARAMS.RSI_PERIOD);
    const volumeSMA = calculateSMA(volumes, INDICATOR_PARAMS.VOLUME_AVG_PERIOD);

    const lastIndex = chartData.length - 1;

    if (!wt2 || !rsi || !volumeSMA || !tci) return null;
    
    const lastVolume = volumes[lastIndex];
    const lastVolumeSMA = volumeSMA[lastIndex];
    const lastTrendEMA = trendEMA[lastIndex];
    const lastTci = tci[lastIndex];
    const prevTci = tci[lastIndex - 1];
    const lastWt2 = wt2[lastIndex];
    const prevWt2 = wt2[lastIndex - 1];
    const lastMacd = macdLine[lastIndex];
    const lastMacdSignal = signalLine[lastIndex];
    const lastRsi = rsi[lastIndex];
    const lastClose = closePrices[lastIndex];

    if (lastVolumeSMA === null || lastWt2 === null || prevWt2 === null || lastRsi === null) {
      return null;
    }

    // --- Condition Checks ---
    const isUptrend = lastClose > lastTrendEMA;
    const isDowntrend = lastClose < lastTrendEMA;
    const isWTBuyCross = prevTci < prevWt2 && lastTci > lastWt2;
    const isWTSellCross = prevTci > prevWt2 && lastTci < lastWt2;
    const isMACDConfirmBuy = lastMacd > lastMacdSignal;
    const isRSIConfirmBuy = lastRsi > 50;
    const isMACDConfirmSell = lastMacd < lastMacdSignal;
    const isRSIConfirmSell = lastRsi < 50;
    const isVolumeSpike = lastVolume > lastVolumeSMA * INDICATOR_PARAMS.VOLUME_SPIKE_FACTOR;
    const isRSIOversold = lastRsi < INDICATOR_PARAMS.RSI_OS;
    const isRSIOverbought = lastRsi > INDICATOR_PARAMS.RSI_OB;

    // RSI Bullish Divergence check (price makes lower low, RSI makes higher low)
    let isBullishDivergence = false;
    if (rsi.length > 15) {
        const lookbackPeriod = 14;
        const recentLowPriceIndex = lowPrices.slice(lastIndex - lookbackPeriod, lastIndex).reduce((iMin, x, i, arr) => x < arr[iMin] ? i : iMin, 0) + (lastIndex - lookbackPeriod);
        const recentLowRsiIndex = rsi.slice(lastIndex - lookbackPeriod, lastIndex).reduce((iMin, x, i, arr) => x! < arr[iMin]! ? i : iMin, 0) + (lastIndex - lookbackPeriod);
        
        if (lastClose < lowPrices[recentLowPriceIndex] && rsi[lastIndex]! > rsi[recentLowRsiIndex]!) {
            isBullishDivergence = true;
        }
    }
    
    let newSignal: Omit<Signal, 'price' | 'time'> | null = null;
    
    // --- Signal Logic ---
    if (isWTBuyCross || (isUptrend && isMACDConfirmBuy) || (isBullishDivergence && isRSIOversold)) {
        const confirmations = (isMACDConfirmBuy ? 1 : 0) + (isRSIConfirmBuy ? 1 : 0) + (isUptrend ? 1 : 0) + (isBullishDivergence ? 1 : 0);
        
        if (confirmations >= 3 && isVolumeSpike) newSignal = { type: 'BUY', level: 'High' };
        else if (confirmations >= 2) newSignal = { type: 'BUY', level: 'Medium' };
        else newSignal = { type: 'BUY', level: 'Low' };
    } 
    else if (isWTSellCross || (isDowntrend && isMACDConfirmSell)) {
        const confirmations = (isMACDConfirmSell ? 1 : 0) + (isRSIConfirmSell ? 1 : 0) + (isDowntrend ? 1 : 0);
        
        if (confirmations >= 3 && isVolumeSpike) newSignal = { type: 'SELL', level: 'High' };
        else if (confirmations >= 2) newSignal = { type: 'SELL', level: 'Medium' };
        else newSignal = { type: 'SELL', level: 'Low' };
    }
    
    if (newSignal) {
      const lastDataPoint = chartData[lastIndex];
      return {
          ...newSignal,
          price: lastDataPoint.close,
          time: lastDataPoint.time,
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

        if (lastSignal?.time !== newSignal.time) {
             const { displayTime, ...signalToSave } = newSignal;
             await saveSignalToFirestore(signalToSave);
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

    