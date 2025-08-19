
'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { CryptoChart } from './CryptoChart';
import { SignalHistory } from './SignalHistory';
import type { ChartDataPoint, Signal, StrategyType } from '@/lib/types';
import { BarChart2, Briefcase, Zap, Waves } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { getChartData } from '@/app/actions';
import { useToast } from '@/hooks/use-toast';
import { db } from '@/lib/firebase';
import { collection, query, orderBy, onSnapshot, limit, getDocs, where, Timestamp } from 'firebase/firestore';
import { Button } from '@/components/ui/button';

const MAX_SIGNALS = 15;

const chartDataLimits: Record<StrategyType, number> = {
  Scalp: 100,
  Day: 200,
  Swing: 500,
};


export function SignalDashboard() {
  const [chartData, setChartData] = useState<ChartDataPoint[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeView, setActiveView] = useState<StrategyType>('Day');
  const { toast } = useToast();
  const lastSignalRef = useRef<Signal | null>(null);

  const displayedSignals = useMemo(() => {
    return signals.map(s => {
      const date = new Date(s.time);
      const day = String(date.getDate()).padStart(2, '0');
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const year = String(date.getFullYear()).slice(-2);
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      const seconds = String(date.getSeconds()).padStart(2, '0');
      
      return {
        ...s,
        displayTime: `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`,
      };
    }).sort((a,b) => b.time - a.time);
  }, [signals]);

  const chartSignals = useMemo(() => {
    return signals.filter(s => s.strategy === activeView);
  }, [signals, activeView]);

  const fetchChartData = useCallback(async (view: StrategyType) => {
    try {
      const dataLimit = chartDataLimits[view];
      const formattedData = await getChartData('DOGEUSDT', dataLimit);
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
      
      await fetchChartData(activeView);

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
            strategy: data.strategy || 'Day', // Default to Day if not present
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
        
        const newSignalsFromSnapshot: Signal[] = [];
        snapshot.docChanges().forEach((change) => {
            if (change.type === "added") {
                const newSignalData = change.doc.data();
                const newSignal = {
                    type: newSignalData.type,
                    level: newSignalData.level,
                    price: newSignalData.price,
                    time: newSignalData.time,
                    strategy: newSignalData.strategy || 'Day',
                } as Signal;

                // Simple check to avoid processing duplicates from the listener
                if (lastSignalRef.current?.time !== newSignal.time) {
                    lastSignalRef.current = newSignal;
                    newSignalsFromSnapshot.push(newSignal);

                    const toastTitles = {
                      High: `🚀 High ${newSignal.type} Signal!`,
                      Medium: `🔥 Medium ${newSignal.type} Signal!`,
                    };
                    
                    if (newSignal.price && typeof newSignal.price === 'number') {
                      toast({
                        title: toastTitles[newSignal.level],
                        description: `${newSignal.strategy} Trade generated at $${newSignal.price.toFixed(5)}`,
                      });
                    }
                }
            }
        });

        if (newSignalsFromSnapshot.length > 0) {
            // Add the new signal(s) to our state
            setSignals(prevSignals => [...prevSignals, ...newSignalsFromSnapshot].slice(-MAX_SIGNALS));
            // Refresh chart data to align with the new signal
            fetchChartData(activeView);
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
  }, []); // Changed to only run on mount

  // Effect to refetch chart data when activeView changes
  useEffect(() => {
    fetchChartData(activeView);
  }, [activeView, fetchChartData]);


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
              Algorithmic signals using an adaptive, trend-following strategy.
              </CardDescription>
              <div className="mt-4 flex items-center gap-2">
                  <Button variant={activeView === 'Scalp' ? 'default' : 'outline'} size="sm" onClick={() => setActiveView('Scalp')}>
                      <Zap className="mr-2 h-4 w-4" />
                      ScalpTrade
                  </Button>
                  <Button variant={activeView === 'Day' ? 'default' : 'outline'} size="sm" onClick={() => setActiveView('Day')}>
                      <Briefcase className="mr-2 h-4 w-4" />
                      DayTrade
                  </Button>
                  <Button variant={activeView === 'Swing' ? 'default' : 'outline'} size="sm" onClick={() => setActiveView('Swing')}>
                      <Waves className="mr-2 h-4 w-4" />
                      SwingTrade
                  </Button>
              </div>

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
            <CryptoChart data={chartData} signals={chartSignals} />
          )}
        </CardContent>
      </Card>
      <SignalHistory signals={displayedSignals.slice(0, MAX_SIGNALS)} />
    </div>
  );
}
