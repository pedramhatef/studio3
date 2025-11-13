
'use server';

import type { ChartDataPoint, Signal, StrategyParams, StrategyType } from '@/lib/types';
import { getAdminFirestore } from '@/firebase/server';
import { collection, addDoc, serverTimestamp, getDocs, query, orderBy, limit, doc, getDoc } from "firebase/firestore"; 

const db = getAdminFirestore();

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
      console.error(`[Actions] Bybit Chart API HTTP Error (${symbol}): ${response.status} ${response.statusText}`, errorText);
      throw new Error(`Failed to fetch chart data for ${symbol}: ${response.statusText}`);
    }

    const data: BybitKlineResponse = await response.json();

    if (data.retCode !== 0) {
      throw new Error(`[Actions] Bybit API returned an error for ${symbol}: ${data.retMsg}`);
    }

    const formattedData = data.result.list.map(d => ({
      time: parseInt(d[0]),
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
      volume: parseFloat(d[5]),
    })).sort((a, b) => a.time - b.time);

    return formattedData;
  } catch (error) {
    console.error(`[Actions] CRITICAL: Unhandled error in getChartData for ${symbol}. Re-throwing.`, error);
    throw error;
  }
}


export async function saveSignalToFirestore(signal: Omit<Signal, 'displayTime'>) {
    const signalsCollection = collection(db, "signals");
    const signalData = {
      ...signal,
      serverTime: serverTimestamp(),
    };

    // No await, no try/catch. Chain .catch() for error handling.
    addDoc(signalsCollection, signalData)
      .then(docRef => {
        console.log("[Actions] Signal saved to Firestore with ID: ", docRef.id);
      })
      .catch(error => {
        // For server actions, direct logging is the primary method for now.
        // The concept of a client-side errorEmitter doesn't apply here.
        console.error(`[Actions] Firestore permission error while saving signal. Path: ${signalsCollection.path}. Data: ${JSON.stringify(signalData)}. Error: ${error.message}`);
      });
}


export async function getSignalHistoryFromFirestore(): Promise<Signal[]> {
    try {
      const signalsCol = collection(db, "signals");
      const q = query(signalsCol, orderBy("serverTime", "desc"), limit(1));
      const querySnapshot = await getDocs(q);
      
      const signals = querySnapshot.docs.map(doc => {
        const data = doc.data();
        // Ensure strategy is valid, default to Day as a safe fallback.
        const strategy = data.strategy && ['Scalp', 'Day', 'Swing'].includes(data.strategy) ? data.strategy : 'Day';
        return {
          type: data.type,
          level: data.level,
          price: data.price,
          time: data.time,
          strategy: strategy,
          confidence: data.confidence,
        } as Signal;
      });
      
      return signals; 
    } catch (error) {
      console.error("[Actions] Error fetching signal history from Firestore:", error);
      return [];
    }
}

export async function getLatestOptimizationParams(strategy: StrategyType = 'Day'): Promise<Partial<StrategyParams> | null> {
    try {
        const docId = `latest-${strategy}`;
        const docRef = doc(db, 'optimizationResults', docId);
        const docSnap = await getDoc(docRef);
    
        if (docSnap.exists()) {
          const data = docSnap.data();
          if (data && data.bestParams) {
             console.log(`[Actions] Fetched latest optimization params for ${strategy}.`);
             return data.bestParams as StrategyParams;
          }
        } else {
            console.log(`[Actions] No optimization document found for strategy: ${strategy}`);
        }
        return null;
      } catch (error) {
        console.error(`[Actions] Error fetching latest optimization results for ${strategy}:`, error);
        return null;
      }
}
