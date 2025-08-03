'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { CryptoChart } from './CryptoChart';
import { SignalHistory } from './SignalHistory';
import type { ChartDataPoint, Signal } from '@/lib/types';
import { BarChart2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore } from '@/app/actions';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { collection, query, orderBy, onSnapshot, limit } from 'firebase/firestore';


// Constants
const DATA_REFRESH_INTERVAL = 5000; // 5 seconds
const MAX_SIGNALS = 15;

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

// --- Main Component ---
export function SignalDashboard() {
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();
  const initialLoadToastId = useRef<string | null>(null);
  const lastSignalRef = useRef<Signal | null>(null);

  // Calculate required data length
  const requiredDataLength = useMemo(() => {
    return Math.max(
      INDICATOR_PARAMS.WT_CHANNEL_LENGTH + INDICATOR_PARAMS.WT_AVERAGE_LENGTH,
      INDICATOR_PARAMS.MACD_SLOW_PERIOD,
      INDICATOR_PARAMS.RSI_PERIOD + 1,
      INDICATOR_PARAMS.EMA_TREND_PERIOD,
      INDICATOR_PARAMS.VOLUME_AVG_PERIOD
    );
  }, []);

  const displayedSignals = useMemo(() => {
    return signals.map(s => ({
        ...s,
        displayTime: new Date(s.time).toLocaleTimeString(),
    })).sort((a,b) => b.time - a.time);
  }, [signals]);

  const fetchDataAndGenerateSignal = useCallback(async (isInitialLoad = false) => {
    try {
      const formattedData = await getChartData();
      if (!formattedData?.length) return;
      
      setChartData(formattedData);
      if (isInitialLoad) {
        setIsLoading(false);
      }
      
      if (formattedData.length < requiredDataLength) return;
      
      // Extract price and volume data
      const closePrices = formattedData.map(p => p.close);
      const volumes = formattedData.map(p => p.volume);

      // --- Indicator Calculations ---
      const trendEMA = calculateEMA(closePrices, INDICATOR_PARAMS.EMA_TREND_PERIOD);
      const ap = formattedData.map(p => (p.high + p.low + p.close) / 3);
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

      const lastIndex = formattedData.length - 1;

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
        return;
      }

      const isUptrend = lastClose > lastTrendEMA;
      const isDowntrend = lastClose < lastTrendEMA;
      const isWTBuy = prevTci < prevWt2 && lastTci > lastWt2;
      const isWTSell = prevTci > prevWt2 && lastTci < lastWt2;
      const isMACDConfirmBuy = lastMacd > lastMacdSignal;
      const isRSIConfirmBuy = lastRsi > 50;
      const isMACDConfirmSell = lastMacd < lastMacdSignal;
      const isRSIConfirmSell = lastRsi < 50;
      const isVolumeSpike = lastVolume > lastVolumeSMA * INDICATOR_PARAMS.VOLUME_SPIKE_FACTOR;
      
      let newSignal: Omit<Signal, 'price' | 'time'> | null = null;
      
      // BUY Signal Logic
      if (isUptrend && isWTBuy && lastSignalRef.current?.type !== 'BUY') {
          const confirmations = (isMACDConfirmBuy ? 1 : 0) + (isRSIConfirmBuy ? 1 : 0);
          
          if (confirmations === 2 && isVolumeSpike) newSignal = { type: 'BUY', level: 'High' };
          else if (confirmations >= 1) newSignal = { type: 'BUY', level: 'Medium' };
          else newSignal = { type: 'BUY', level: 'Low' };
      } 
      // SELL Signal Logic
      else if (isDowntrend && isWTSell && lastSignalRef.current?.type !== 'SELL') {
          const confirmations = (isMACDConfirmSell ? 1 : 0) + (isRSIConfirmSell ? 1 : 0);
          
          if (confirmations === 2 && isVolumeSpike) newSignal = { type: 'SELL', level: 'High' };
          else if (confirmations >= 1) newSignal = { type: 'SELL', level: 'Medium' };
          else newSignal = { type: 'SELL', level: 'Low' };
      }

      if (newSignal) {
        const lastDataPoint = formattedData[lastIndex];
        const fullSignal: Signal = {
            ...newSignal,
            price: lastDataPoint.close,
            time: lastDataPoint.time,
        };
        
        lastSignalRef.current = fullSignal;
        const { displayTime, ...signalToSave } = fullSignal;
        await saveSignalToFirestore(signalToSave);
      }

    } catch (error) {
      console.error("Data processing error:", error);
      toast({
        variant: "destructive",
        title: "Data Error",
        description: "Could not fetch or process chart data.",
      });
    } finally {
        if (isLoading) {
            setIsLoading(false);
            if (initialLoadToastId.current) {
                toast({
                    id: initialLoadToastId.current,
                    variant: "default",
                    title: "✅ Data Loaded",
                    description: "Live data feed and signal generation active.",
                });
                initialLoadToastId.current = null;
            }
        }
    }
  }, [toast, isLoading, requiredDataLength]);
  
  // Initial data load and listener setup
  useEffect(() => {
    setIsLoading(true);
    fetchDataAndGenerateSignal(true);
    
    const q = query(collection(db, "signals"), orderBy("serverTime", "desc"), limit(50));
    const unsubscribe = onSnapshot(q, (querySnapshot) => {
      const fetchedSignals: Signal[] = [];
      querySnapshot.forEach((doc) => {
        const data = doc.data();
        fetchedSignals.push({
            type: data.type,
            level: data.level,
            price: data.price,
            time: data.time,
          } as Signal);
      });
      
      const reversedSignals = fetchedSignals.reverse();
      setSignals(reversedSignals);

      if (reversedSignals.length > 0) {
        const latestSignal = reversedSignals[reversedSignals.length - 1];
        if (lastSignalRef.current?.time !== latestSignal.time) {
            lastSignalRef.current = latestSignal;

            const toastTitles = {
              High: `🚀 High ${latestSignal.type} Signal!`,
              Medium: `🔥 Medium ${latestSignal.type} Signal!`,
              Low: `🤔 Low ${latestSignal.type} Signal`
            };

            toast({
              id: `signal-${latestSignal.time}`,
              title: toastTitles[latestSignal.level],
              description: `Generated at $${latestSignal.price.toFixed(5)}`,
            });
        }
      }
      if (isLoading) setIsLoading(false);
    }, (error) => {
      console.error("Firestore snapshot error: ", error);
      toast({
        variant: "destructive",
        title: "Database Listener Error",
        description: "Could not listen for real-time signal updates.",
      });
      setIsLoading(false);
    });
    
    // Cleanup listener on component unmount
    return () => unsubscribe();
  }, [toast]); // Removed isLoading from deps to prevent re-subscribing


  // Fetch chart data periodically
  useEffect(() => {
    const intervalId = setInterval(() => fetchDataAndGenerateSignal(false), DATA_REFRESH_INTERVAL);
    return () => clearInterval(intervalId);
  }, [fetchDataAndGenerateSignal]);

  // Initial loading toast
  useEffect(() => {
    if (isLoading && !initialLoadToastId.current) {
      const { id } = toast({
        id: `loading-toast`,
        title: "Initializing data...",
        description: "Connecting to data feed and signal history.",
      });
      initialLoadToastId.current = id;
    }
  }, [isLoading, toast]);

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
              <CardDescription>
                Algorithmic signals using enhanced WaveTrend strategy with volume confirmation
              </CardDescription>
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
      <SignalHistory signals={displayedSignals.slice(0, MAX_SIGNALS)} />
    </div>
  );
}
