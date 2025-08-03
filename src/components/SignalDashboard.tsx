'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { CryptoChart } from './CryptoChart';
import { SignalHistory } from './SignalHistory';
import type { ChartDataPoint, Signal } from '@/lib/types';
import { BarChart2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { getChartData } from '@/app/actions';
import { useToast } from '@/hooks/use-toast';

const DATA_REFRESH_INTERVAL = 5000; // 5 seconds

// --- WaveTrend Parameters ---
const WT_CHANNEL_LENGTH = 10;
const WT_AVERAGE_LENGTH = 21;
const WT_SIGNAL_LENGTH = 4;

// --- MACD Parameters ---
const MACD_FAST_PERIOD = 12;
const MACD_SLOW_PERIOD = 26;
const MACD_SIGNAL_PERIOD = 9;

// --- RSI Parameters ---
const RSI_PERIOD = 14;

// --- Trend Filter ---
const EMA_TREND_PERIOD = 50;

// --- Volume Confirmation ---
const VOLUME_AVG_PERIOD = 20;
const VOLUME_SPIKE_FACTOR = 1.8;


// Helper to calculate Exponential Moving Average (EMA)
const calculateEMA = (data: number[], period: number): number[] => {
  const k = 2 / (period + 1);
  const emaArray: number[] = [];
  if (data.length > 0) {
    let ema = data[0]; // Start with the first value
    emaArray.push(ema);
    for (let i = 1; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
      emaArray.push(ema);
    }
  }
  return emaArray;
};

// Helper to calculate Simple Moving Average (SMA)
const calculateSMA = (data: number[], period: number): (number | null)[] => {
  const smaArray: (number | null)[] = new Array(data.length).fill(null);
  if (data.length < period) return smaArray;

  for (let i = period - 1; i < data.length; i++) {
    const window = data.slice(i - period + 1, i + 1);
    const sum = window.reduce((a, b) => a + b, 0);
    smaArray[i] = sum / period;
  }
  return smaArray;
};

// Helper to calculate RSI
const calculateRSI = (data: number[], period: number): (number | null)[] => {
    if (data.length < period + 1) return new Array(data.length).fill(null);
    
    const rsiArray: (number | null)[] = new Array(data.length).fill(null);
    let gains = 0;
    let losses = 0;

    // Calculate initial average gain/loss
    for (let i = 1; i <= period; i++) {
        const change = data[i] - data[i - 1];
        if (change > 0) {
            gains += change;
        } else {
            losses -= change;
        }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    if (avgLoss === 0) {
        rsiArray[period] = 100;
    } else {
        const rs = avgGain / avgLoss;
        rsiArray[period] = 100 - (100 / (1 + rs));
    }

    // Calculate subsequent RSI values
    for (let i = period + 1; i < data.length; i++) {
        const change = data[i] - data[i - 1];
        let currentGain = change > 0 ? change : 0;
        let currentLoss = change < 0 ? -change : 0;

        avgGain = (avgGain * (period - 1) + currentGain) / period;
        avgLoss = (avgLoss * (period - 1) + currentLoss) / period;

        if (avgLoss === 0) {
            rsiArray[i] = 100;
        } else {
            const rs = avgGain / avgLoss;
            rsiArray[i] = 100 - (100 / (1 + rs));
        }
    }
    return rsiArray;
};

export function SignalDashboard() {
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();
  const prevSignalsRef = useRef<Signal[]>([]);
  const initialLoadToastId = useRef<string | null>(null);


  const fetchDataAndGenerateSignal = useCallback(async () => {
    try {
      const formattedData = await getChartData();
      
      if (!formattedData || formattedData.length === 0) {
        return; // Wait for data
      }

      setChartData(formattedData);
      
      const requiredDataLength = Math.max(WT_CHANNEL_LENGTH + WT_AVERAGE_LENGTH, MACD_SLOW_PERIOD, RSI_PERIOD + 1, EMA_TREND_PERIOD, VOLUME_AVG_PERIOD);

      if (formattedData.length < requiredDataLength) {
        return; // Not enough data yet to generate signals
      }
      
      // --- Indicator Calculations ---
      const closePrices = formattedData.map(p => p.close);
      const volumes = formattedData.map(p => p.volume);

      const trendEMA = calculateEMA(closePrices, EMA_TREND_PERIOD);
      const ap = formattedData.map(p => (p.high + p.low + p.close) / 3);
      const esa = calculateEMA(ap, WT_CHANNEL_LENGTH);
      const d = calculateEMA(ap.map((val, i) => Math.abs(val - esa[i])), WT_CHANNEL_LENGTH);
      const ci = ap.map((val, i) => (d[i] === 0) ? 0 : (val - esa[i]) / (0.015 * d[i]));
      const tci = calculateEMA(ci, WT_AVERAGE_LENGTH);
      const wt2 = calculateSMA(tci, WT_SIGNAL_LENGTH);
      const fastEMA = calculateEMA(closePrices, MACD_FAST_PERIOD);
      const slowEMA = calculateEMA(closePrices, MACD_SLOW_PERIOD);
      const macdLine = fastEMA.map((val, i) => val - slowEMA[i]);
      const signalLine = calculateEMA(macdLine, MACD_SIGNAL_PERIOD);
      const rsi = calculateRSI(closePrices, RSI_PERIOD);
      const volumeSMA = calculateSMA(volumes, VOLUME_AVG_PERIOD);


      setSignals(prevSignals => {
        const lastVolume = volumes[volumes.length - 1];
        const lastVolumeSMA = volumeSMA[volumeSMA.length - 1];
        const lastTrendEMA = trendEMA[trendEMA.length - 1];
        const lastTci = tci[tci.length - 1];
        const prevTci = tci[tci.length - 2];
        const lastWt2 = wt2[wt2.length - 1];
        const prevWt2 = wt2[wt2.length - 2];
        const lastMacd = macdLine[macdLine.length - 1];
        const lastMacdSignal = signalLine[signalLine.length - 1];
        const lastRsi = rsi[rsi.length - 1];
        const lastClose = closePrices[closePrices.length - 1];

        if (lastVolumeSMA === null || lastTrendEMA === null || lastTci === null || prevTci === null || lastWt2 === null || prevWt2 === null || lastMacd === null || lastMacdSignal === null || lastRsi === null) {
          return prevSignals;
        }

        const lastSignal = prevSignals.length > 0 ? prevSignals[0] : null;
        
        const isUptrend = lastClose > lastTrendEMA;
        const isDowntrend = lastClose < lastTrendEMA;
        const isWTBuy = prevTci < prevWt2 && lastTci > lastWt2;
        const isWTSell = prevTci > prevWt2 && lastTci < lastWt2;
        const isMACDConfirmBuy = lastMacd > lastMacdSignal;
        const isRSIConfirmBuy = lastRsi > 50;
        const isMACDConfirmSell = lastMacd < lastMacdSignal;
        const isRSIConfirmSell = lastRsi < 50;
        const isVolumeSpike = lastVolume > lastVolumeSMA * VOLUME_SPIKE_FACTOR;
        
        let newSignal: Omit<Signal, 'price' | 'time' | 'displayTime'> | null = null;
        
        // BUY Signal Logic
        if (isUptrend && isWTBuy && (!lastSignal || lastSignal.type !== 'BUY')) {
            let confirmations = 0;
            if (isMACDConfirmBuy) confirmations++;
            if (isRSIConfirmBuy) confirmations++;
            
            // High confidence BUY now requires a volume spike
            if (confirmations === 2 && isVolumeSpike) {
                newSignal = { type: 'BUY', level: 'High' };
            } else if (confirmations >= 1) { // Medium for 1 or 2 confirmations without volume spike
                newSignal = { type: 'BUY', level: 'Medium' };
            } else {
                newSignal = { type: 'BUY', level: 'Low' };
            }
        } 
        // SELL Signal Logic
        else if (isDowntrend && isWTSell && (!lastSignal || lastSignal.type !== 'SELL')) {
            let confirmations = 0;
            if (isMACDConfirmSell) confirmations++;
            if (isRSIConfirmSell) confirmations++;
            
            // High confidence SELL also requires a volume spike
            if (confirmations === 2 && isVolumeSpike) {
                newSignal = { type: 'SELL', level: 'High' };
            } else if (confirmations >= 1) {
                newSignal = { type: 'SELL', level: 'Medium' };
            } else {
                newSignal = { type: 'SELL', level: 'Low' };
            }
        }

        if (newSignal) {
          const lastDataPoint = formattedData[formattedData.length - 1];
          const fullSignal: Signal = {
              ...newSignal,
              price: lastDataPoint.close,
              time: lastDataPoint.time,
              displayTime: new Date(lastDataPoint.time).toLocaleTimeString(),
          };
          
          return [fullSignal, ...prevSignals].slice(0, 15);
        }

        return prevSignals;
      });

    } catch (error) {
      console.error("Error processing data:", error);
      toast({
        variant: "destructive",
        title: "Data Error",
        description: "Could not fetch or process chart data.",
      });
    } finally {
      if(isLoading) setIsLoading(false);
      if(initialLoadToastId.current) {
        toast({
            id: initialLoadToastId.current,
            variant: "default",
            title: "✅ Data Loaded",
            description: "Signals are now being generated.",
        });
        initialLoadToastId.current = null;
      }
    }
  }, [toast, isLoading]);

  useEffect(() => {
    fetchDataAndGenerateSignal();
    const intervalId = setInterval(fetchDataAndGenerateSignal, DATA_REFRESH_INTERVAL);
    return () => clearInterval(intervalId);
  }, [fetchDataAndGenerateSignal]);

  // Effect to show a toast when a new signal is generated
  useEffect(() => {
    if (signals.length > 0 && signals[0].time !== (prevSignalsRef.current[0]?.time || 0)) {
        const newSignal = signals[0];
        
        let toastTitle = '';
        switch (newSignal.level) {
            case 'High':
                toastTitle = `🚀 High ${newSignal.type} Signal!`;
                break;
            case 'Medium':
                toastTitle = `🔥 Medium ${newSignal.type} Signal!`;
                break;
            case 'Low':
                toastTitle = `🤔 Low ${newSignal.type} Signal`;
                break;
        }
        
        toast({
          id: `signal-${newSignal.time}`,
          title: toastTitle,
          description: `A new ${newSignal.level.toLowerCase()}-confidence signal was generated at $${newSignal.price.toFixed(5)}`,
        });
    }
    prevSignalsRef.current = signals;
  }, [signals, toast]);


  // Separate effect for the initial loading toast.
  useEffect(() => {
    const requiredDataLength = Math.max(WT_CHANNEL_LENGTH + WT_AVERAGE_LENGTH, MACD_SLOW_PERIOD, RSI_PERIOD + 1, EMA_TREND_PERIOD);
    if (isLoading && chartData.length < requiredDataLength && !initialLoadToastId.current) {
      const {id} = toast({
        title: "Fetching data...",
        description: "Waiting for enough data to generate signals.",
      });
      initialLoadToastId.current = id;
    }
  }, [isLoading, chartData.length, toast]);

  return (
    <div className="grid gap-8">
      <Card className="shadow-lg">
        <CardHeader>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <CardTitle className="flex items-center gap-2">
                <BarChart2 className="h-6 w-6" />
                DOGE/USDT Real-Time Signals
              </CardTitle>
              <CardDescription>High-quality signals generated with the trend using a custom WaveTrend strategy.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading && chartData.length === 0 ? (
            <Skeleton className="h-[400px] w-full" />
          ) : (
            <CryptoChart data={chartData} signals={signals} />
          )}
        </CardContent>
      </Card>
      <SignalHistory signals={signals} />
    </div>
  );
}
