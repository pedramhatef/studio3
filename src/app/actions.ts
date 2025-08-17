
'use server';

import type { ChartDataPoint, Signal, StrategyParams } from '@/lib/types';
import { db } from '@/lib/firebase';
import { collection, addDoc, serverTimestamp, getDocs, query, orderBy, limit } from "firebase/firestore"; 

interface BybitKlineResponse {
  retCode: number;
  retMsg: string;
  result: {
    symbol: string;
    category: string;
    list: [string, string, string, string, string, string, string][];
  };
  retExtInfo: {};
  time: number;
}

export async function getChartData(symbol: 'DOGEUSDT' = 'DOGEUSDT', limit: number = 200): Promise<ChartDataPoint[]> {
  try {
    const host = 'https://api-demo.bybit.com';
    const path = '/v5/market/kline';
    const params = new URLSearchParams({
      category: 'linear',
      symbol: symbol,
      interval: '1', // 1 minute
      limit: limit.toString(),
    });
    const url = `${host}${path}?${params.toString()}`;

    const response = await fetch(url, {
      next: { revalidate: 10 }, // Revalidate every 10 seconds
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Bybit Chart API Error (${symbol}):`, errorText);
      throw new Error(`Failed to fetch chart data for ${symbol}: ${response.statusText}`);
    }

    const data: BybitKlineResponse = await response.json();

    if (data.retCode !== 0) {
      throw new Error(`Bybit API returned an error for ${symbol}: ${data.retMsg}`);
    }

    const formattedData = data.result.list.map(d => ({
      time: parseInt(d[0]),
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
      volume: parseFloat(d[5]),
    })).sort((a, b) => a.time - b.time); // Ensure data is sorted chronologically

    return formattedData;
  } catch (error) {
    console.error(`Error in getChartData for ${symbol}:`, error);
    return []; // Return empty array on error
  }
}


export async function saveSignalToFirestore(signal: Omit<Signal, 'displayTime'>) {
  try {
    const docRef = await addDoc(collection(db, "signals"), {
      ...signal,
      serverTime: serverTimestamp(),
    });
    console.log("Document written with ID: ", docRef.id);
    return { success: true, id: docRef.id };
  } catch (e) {
    console.error("Error adding document: ", e);
    return { success: false, error: (e as Error).message };
  }
}

/**
 * Fetches the single most recent signal from Firestore.
 * This is used by the cron job to check the last signal's direction ('BUY' or 'SELL')
 * and confidence level to prevent saving consecutive identical signals.
 */
export async function getSignalHistoryFromFirestore(): Promise<Signal[]> {
    try {
      const signalsCol = collection(db, "signals");
      // Fetch only the single most recent document.
      const q = query(signalsCol, orderBy("serverTime", "desc"), limit(1));
      const querySnapshot = await getDocs(q);
      
      const signals = querySnapshot.docs.map(doc => {
        const data = doc.data();
        // Ensure all required fields are returned for the duplicate check
        return {
          type: data.type,
          level: data.level,
          price: data.price,
          time: data.time,
        } as Signal;
      });
      
      return signals; 
    } catch (error) {
      console.error("Error fetching signal history:", error);
      return [];
    }
}

export async function getLatestOptimizationParams(): Promise<Partial<StrategyParams> | null> {
    try {
        const optimizationResultsCol = collection(db, 'optimizationResults');
        const q = query(optimizationResultsCol, orderBy('timestamp', 'desc'), limit(1));
        const latestResultSnapshot = await getDocs(q);
    
        if (!latestResultSnapshot.empty) {
          const latestResult = latestResultSnapshot.docs[0].data();
          if (latestResult.bestParams) {
             return latestResult.bestParams as StrategyParams;
          }
        }
        return null;
      } catch (error) {
        console.error(`Error fetching optimization results:`, error);
        return null;
      }
}

    
