
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
  const lastSignalRef = useRef<Signal | null>(null);

  const displayedSignals = useMemo(() => {
    return signals.map(s => ({
        ...s,
        displayTime: new Date(s.time).toLocaleTimeString(),
    })).sort((a,b) => b.time - a.time);
  }, [signals]);

  const fetchChartData = useCallback(async () => {
    try {
      const formattedData = await getChartData();
      if (formattedData?.length) {
        setChartData(formattedData);
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
    let unsubscribe: () => void;
    
    const initialFetch = async () => {
      setIsLoading(true);
      
      await fetchChartData();

      // Optimize: Only fetch the number of signals we are going to display initially.
      const q = query(collection(db, "signals"), orderBy("serverTime", "desc"), limit(MAX_SIGNALS));
      
      unsubscribe = onSnapshot(q, (querySnapshot) => {
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
        
        // The query is desc, so we need to reverse to get chronological order for the state
        const chronologicalSignals = fetchedSignals.reverse();
        setSignals(chronologicalSignals);

        if (isLoading) {
          setIsLoading(false);
        }

        if (chronologicalSignals.length > 0) {
          const latestSignal = chronologicalSignals[chronologicalSignals.length - 1];
          // Only show toast and refetch data for NEW signals
          if (lastSignalRef.current?.time !== latestSignal.time) {
              lastSignalRef.current = latestSignal;

              // Refresh chart data to align with the new signal
              fetchChartData();

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
      }, (error) => {
        console.error("Firestore snapshot error: ", error);
        toast({
          variant: "destructive",
          title: "Database Listener Error",
          description: "Could not listen for real-time signal updates.",
        });
        setIsLoading(false);
      });
    };
    
    initialFetch();
    
    // Cleanup listener on component unmount
    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchChartData]); // fetchChartData is memoized with useCallback

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
