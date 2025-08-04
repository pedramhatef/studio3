
'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { CryptoChart } from './CryptoChart';
import { SignalHistory } from './SignalHistory';
import type { ChartDataPoint, Signal } from '@/lib/types';
import { BarChart2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { getChartData } from '@/app/actions';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { collection, query, orderBy, onSnapshot, limit } from 'firebase/firestore';

const MAX_SIGNALS = 15;

export function SignalDashboard() {
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();
  const initialLoadToastId = useRef<string | null>(null);
  const lastSignalRef = useRef<Signal | null>(null);

  const displayedSignals = useMemo(() => {
    return signals.map(s => ({
        ...s,
        displayTime: new Date(s.time).toLocaleTimeString(),
    })).sort((a,b) => b.time - a.time);
  }, [signals]);

  const fetchChartData = useCallback(async (isInitialLoad = false) => {
    try {
      const formattedData = await getChartData();
      if (formattedData?.length) {
        setChartData(formattedData);
      }
      if (isInitialLoad) {
        setIsLoading(false);
      }
    } catch (error) {
      console.error("Chart data fetching error:", error);
      toast({
        variant: "destructive",
        title: "Chart Data Error",
        description: "Could not fetch real-time chart data.",
      });
    }
  }, [toast]);

  // Initial data load and listener setup
  useEffect(() => {
    setIsLoading(true);
    fetchChartData(true);
    
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
  }, [toast, isLoading, fetchChartData]);


  // Fetch chart data periodically
  useEffect(() => {
    const intervalId = setInterval(() => fetchChartData(false), 5000); // refresh chart data every 5 seconds
    return () => clearInterval(intervalId);
  }, [fetchChartData]);

  // Initial loading toast
  useEffect(() => {
    if (isLoading && !initialLoadToastId.current) {
      const { id } = toast({
        id: `loading-toast`,
        title: "Initializing data...",
        description: "Connecting to data feed and signal history.",
      });
      initialLoadToastId.current = id;
    } else if (!isLoading && initialLoadToastId.current) {
        toast({
            id: initialLoadToastId.current,
            variant: "default",
            title: "✅ Data Loaded",
            description: "Live data feed and signal generation active.",
        });
        initialLoadToastId.current = null;
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
