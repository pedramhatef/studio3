'use server';

import type { ChartDataPoint, Signal } from '@/lib/types';
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

export async function getChartData(): Promise<ChartDataPoint[]> {
  try {
    const host = 'https://api-demo.bybit.com';
    const path = '/v5/market/kline';
    const params = new URLSearchParams({
      category: 'linear',
      symbol: 'DOGEUSDT',
      interval: '1', // 1 minute
      limit: '200', // max limit
    });
    const url = `${host}${path}?${params.toString()}`;

    const response = await fetch(url, {
      next: { revalidate: 10 }, // Revalidate every 10 seconds
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Bybit Chart API Error:', errorText);
      throw new Error(`Failed to fetch chart data: ${response.statusText}`);
    }

    const data: BybitKlineResponse = await response.json();

    if (data.retCode !== 0) {
      throw new Error(`Bybit API returned an error: ${data.retMsg}`);
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
    console.error('Error in getChartData:', error);
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
 * to prevent saving consecutive signals in the same direction.
 */
export async function getSignalHistoryFromFirestore(): Promise<Signal[]> {
    try {
      const signalsCol = collection(db, "signals");
      // Fetch only the single most recent document, which is the only one we need to prevent duplicates.
      const q = query(signalsCol, orderBy("serverTime", "desc"), limit(1));
      const querySnapshot = await getDocs(q);
      
      const signals = querySnapshot.docs.map(doc => {
        const data = doc.data();
        return {
          type: data.type,
          level: data.level,
          price: data.price,
          time: data.time,
        } as Signal;
      });
      
      // The query returns an array with 0 or 1 item, already in the correct order (most recent).
      return signals; 
    } catch (error) {
      console.error("Error fetching signal history:", error);
      return [];
    }
}
