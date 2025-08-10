
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
      
      const firstRsiIndex = period; // The first valid RSI value is at index 'period'
      if (firstRsiIndex < rsiArray.length) {
          if (avgLoss === 0) {
              rsiArray[firstRsiIndex] = 100; // Avoid division by zero for RS calculation
          } else {
              const rs = avgGain / avgLoss;
              rsiArray[firstRsiIndex] = 100 - (100 / (1 + rs));
          }
      }
  
      // Subsequent calculations using Wilder's smoothing
      // The loop should start from the first index where a valid RSI was calculated + 1
      for (let i = firstRsiIndex; i < data.length - 1; i++) {
          const change = changes[i];
          const gain = change > 0 ? change : 0;
          const loss = change < 0 ? -change : 0;
  
          avgGain = (avgGain * (period - 1) + gain) / period;
          avgLoss = (avgLoss * (period - 1) + loss) / period;

          // The RSI value corresponds to the data point at index i + 1
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

async function getNewSignal(chartData: ChartDataPoint[], lastSignal: Signal | null): Promise<Signal | null> {
    const requiredDataLength = Math.max(
        INDICATOR_PARAMS.WT_CHANNEL_LENGTH + INDICATOR_PARAMS.WT_AVERAGE_LENGTH,
        INDICATOR_PARAMS.MACD_SLOW_PERIOD,
        INDICATOR_PARAMS.RSI_PERIOD + 1,
        INDICATOR_PARAMS.EMA_TREND_PERIOD,
        INDICATOR_PARAMS.VOLUME_AVG_PERIOD
    );

    if (chartData.length < requiredDataLength) return null;

    // --- Signal Logic ---
    // Rule: Do not generate a new signal if it's the same type as the last one.
    // This is the primary fix to prevent back-to-back signals of the same type.
    const shouldGenerateBuy = !lastSignal || lastSignal.type !== 'BUY';
    const shouldGenerateSell = !lastSignal || lastSignal.type !== 'SELL';

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

    // Ensure access to previous data points is within bounds
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

    // Basic check if required previous data exists
    if (lastIndex < 1 || trendEMA.length <= lastIndex || tci.length <= lastIndex || wt2.length <= lastIndex || macdLine.length <= lastIndex || signalLine.length <= lastIndex || rsi.length <= lastIndex || volumeSMA.length <= lastIndex) {
        console.error("Insufficient data points for calculating all indicators and signals.");
        return null;
    }

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

    let newSignal: Omit<Signal, 'price' | 'time'> | null = null;
    
    if (shouldGenerateBuy && (isWTBuyCross || (isUptrend && isMACDConfirmBuy) || isRSIOversold)) {
        const confirmations = (isWTBuyCross ? 1 : 0) + (isMACDConfirmBuy ? 1 : 0) + (isRSIConfirmBuy ? 1 : 0) + (isUptrend ? 1 : 0);
        
        if (confirmations >= 3 && isVolumeSpike) newSignal = { type: 'BUY', level: 'High' };
        else if (confirmations >= 2) newSignal = { type: 'BUY', level: 'Medium' };
        else if (isWTBuyCross || isRSIOversold) newSignal = { type: 'BUY', level: 'Low' }; // Allow low confidence for primary triggers
    } 
    else if (shouldGenerateSell && (isWTSellCross || (isDowntrend && isMACDConfirmSell) || isRSIOverbought)) {
        const confirmations = (isWTSellCross ? 1 : 0) + (isMACDConfirmSell ? 1 : 0) + (isRSIConfirmSell ? 1 : 0) + (isDowntrend ? 1 : 0);
        
        if (confirmations >= 3 && isVolumeSpike) newSignal = { type: 'SELL', level: 'High' };
        else if (confirmations >= 2) newSignal = { type: 'SELL', level: 'Medium' };
        else if (isWTSellCross || isRSIOverbought) newSignal = { type: 'SELL', level: 'Low' }; // Allow low confidence for primary triggers
    }
    
    if (newSignal) {
      const lastDataPoint = chartData[lastIndex];
      // Final check: Do not save if the signal is for the same exact time as the last one.
      if (lastSignal?.time === lastDataPoint.time) {
          console.log(`Preventing duplicate signal for the same timestamp: ${lastDataPoint.time}`);
          return null;
      }
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
    if (!chartData || chartData.length < 2) { 
      return NextResponse.json({ message: 'No chart data fetched.' });
    }

    // Get the last signal from Firestore
    const signalHistory = await getSignalHistoryFromFirestore();
    const lastSignal = signalHistory.length > 0 ? signalHistory[0] : null;

    const newSignal = await getNewSignal(chartData, lastSignal);

    if (newSignal) {
        await saveSignalToFirestore(newSignal);
        return NextResponse.json({ message: `Saved ${newSignal.type} signal.`, signal: newSignal });
    }

    return NextResponse.json({ message: 'No new signal generated.' });
  } catch (error) {
    console.error('Cron job error:', error);
    return new NextResponse('Internal Server Error', { status: 500, statusText: (error as Error).message });
  }
}
