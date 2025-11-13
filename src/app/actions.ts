
'use server';

import type { ChartDataPoint, Signal, StrategyParams, StrategyType } from '@/lib/types';
import { getAdminFirestore } from '@/firebase/server';
import { collection, addDoc, serverTimestamp, getDocs, query, orderBy, limit, doc, getDoc } from "firebase/firestore"; 

const db = getAdminFirestore();

export async function getChartData(symbol: 'DOGEUSDT' = 'DOGEUSDT', limit: number = 200): Promise<ChartDataPoint[]> {
    try {
        // Construct the absolute URL for the API route
        const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:9002';
        const url = `${host}/api/chart-data?limit=${limit}`;

        const response = await fetch(url, {
            next: { revalidate: 10 }, // Revalidate every 10 seconds
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[Actions] Failed to fetch from /api/chart-data: ${response.status}`, errorText);
            throw new Error(`Failed to fetch chart data via API route: ${errorText}`);
        }
        
        return response.json();

    } catch (error) {
        console.error(`[Actions] CRITICAL: Unhandled error in getChartData for ${symbol}. Re-throwing.`, error);
        throw error;
    }
}


// This function will remain but will be called from API routes only
export async function saveSignalToFirestore(signal: Omit<Signal, 'displayTime'>) {
    const signalsCollection = collection(db, "signals");
    const signalData = {
      ...signal,
      serverTime: serverTimestamp(),
    };

    try {
        const docRef = await addDoc(signalsCollection, signalData);
        console.log("[Actions] Signal saved to Firestore with ID: ", docRef.id);
    } catch (error: any) {
        console.error(`[Actions] Firestore permission error while saving signal. Path: ${signalsCollection.path}. Data: ${JSON.stringify(signalData)}. Error: ${error.message}`);
        // Re-throw to ensure the caller (cron job) knows about the failure.
        throw error;
    }
}


export async function getSignalHistoryFromFirestore(): Promise<Signal[]> {
    try {
      const signalsCol = collection(db, "signals");
      const q = query(signalsCol, orderBy("serverTime", "desc"), limit(1));
      const querySnapshot = await getDocs(q);
      
      const signals = querySnapshot.docs.map(doc => {
        const data = doc.data();
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
