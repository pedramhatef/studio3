
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
import { collection, query, orderBy, onSnapshot, limit, getDocs, where, Timestamp } from 'firebase/firestore';

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
    
    // This timestamp will be used to listen for only new signals after the initial fetch
    const initialLoadTimestamp = Timestamp.now();

    const initialFetch = async () => {
      setIsLoading(true);
      
      await fetchChartData();

      // 1. One-time fetch for historical signals
      const historyQuery = query(collection(db, "signals"), orderBy("serverTime", "desc"), limit(MAX_SIGNALS));
      const querySnapshot = await getDocs(historyQuery);
      
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
      setIsLoading(false);

      if (chronologicalSignals.length > 0) {
        lastSignalRef.current = chronologicalSignals[chronologicalSignals.length - 1];
      }

      // 2. Set up a listener for NEW signals only
      const newSignalsQuery = query(collection(db, "signals"), where("serverTime", ">", initialLoadTimestamp), orderBy("serverTime", "desc"));
      
      unsubscribe = onSnapshot(newSignalsQuery, (snapshot) => {
        if (snapshot.empty) {
          return; // No new signals yet
        }
        
        snapshot.docChanges().forEach((change) => {
          if (change.type === "added") {
            const newSignalData = change.doc.data();
            const newSignal = {
                type: newSignalData.type,
                level: newSignalData.level,
                price: newSignalData.price,
                time: newSignalData.time,
            } as Signal;

            // Only process if it's a truly new signal
            if (lastSignalRef.current?.time !== newSignal.time) {
                lastSignalRef.current = newSignal;

                // Add the new signal to our state
                setSignals(prevSignals => [...prevSignals, newSignal].slice(-MAX_SIGNALS));

                // Refresh chart data to align with the new signal
                fetchChartData();

                const toastTitles = {
                  High: `🚀 High ${newSignal.type} Signal!`,
                  Medium: `🔥 Medium ${newSignal.type} Signal!`,
                };

                toast({
                  id: `signal-${newSignal.time}`,
                  title: toastTitles[newSignal.level],
                  description: `Generated at $${newSignal.price.toFixed(5)}`,
                });
            }
          }
        });
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
                Algorithmic signals using enhanced WaveTrend strategy with volume confirmation.
              </CardDescription>
            </div>
            <div className="text-xs text-muted-foreground border rounded-lg p-2 flex flex-col gap-2">
                <div className='font-bold'>Chart Legend:</div>
                <div className="flex items-center gap-x-4 gap-y-2 flex-wrap">
                    <div className="flex items-center gap-2">
                        <div className="h-3 w-3 rounded-full bg-green-500" />
                        <span>Buy Signal</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="h-3 w-3 rounded-full bg-red-500" />
                        <span>Sell Signal</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                            <div className="h-3 w-3 rounded-full bg-green-500 opacity-80" />
                            <div className="h-3 w-3 rounded-full bg-red-500 opacity-80" />
                        </div>
                        <span>High Confidence (Solid)</span>
                    </div>
                     <div className="flex items-center gap-2">
                        <div className="flex items-center gap-1">
                          <div className="h-3 w-3 rounded-full bg-green-500 opacity-50" />
                          <div className="h-3 w-3 rounded-full bg-red-500 opacity-50" />
                        </div>
                        <span>Medium Confidence (Transparent)</span>
                    </div>
                </div>
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
