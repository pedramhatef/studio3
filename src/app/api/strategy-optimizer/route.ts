

'use server';

import { NextResponse } from 'next/server';
import { getChartData } from '../../../app/actions';
import { optimizeParameters } from '../../../lib/backtesting';
import type { ChartDataPoint, StrategyParams } from '../../../lib/types';
import { db } from '../../../lib/firebase';
import { setDoc, doc, getDoc, deleteDoc } from 'firebase/firestore';

const OPTIMIZATION_LOCK_KEY = 'optimizationLock';


const getDynamicParameterRanges = (volatility: number): { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]: number[] } => {
    // If volatility is high, use tighter stops. If low, allow wider stops.
    const stopLossMultipliers = volatility > 0.05 ? [1.0, 1.2, 1.5] : [1.5, 2.0, 2.5];
    const takeProfitMultipliers = volatility > 0.05 ? [2.0, 2.5] : [2.5, 3.0, 3.5];

    return {
      // Core Trend-Following
      EMA_FAST_PERIOD: [3, 5, 8, 10, 13, 15],
      EMA_SLOW_PERIOD: [20, 25, 30, 35, 40],
      EMA_LONG_PERIOD: [50],
      
      // Confirmation
      PARABOLIC_SAR_STEP: [0.01, 0.02],
      PARABOLIC_SAR_MAX: [0.1, 0.2],
    
      // Momentum
      RSI_PERIOD: [14],
      RSI_OVERSOLD_THRESHOLD: [30, 35],
      RSI_OVERBOUGHT_THRESHOLD: [65, 70],
      RSI_BREAKOUT_THRESHOLD: [55], 
      RSI_BREAKDOWN_THRESHOLD: [45], 
    
      // Volatility & Volume
      ATR_VOLATILITY_THRESHOLD: [1.2, 1.5],
      VOLUME_PERIOD: [20],
      VOLUME_THRESHOLD_MULTIPLIER: [1.5, 2.0],
      
      // Risk Management
      ATR_PERIOD: [7, 10, 12, 14],
      TAKE_PROFIT_ATR_MULTIPLIER: takeProfitMultipliers,
      STOP_LOSS_ATR_MULTIPLIER: stopLossMultipliers,
    };
}


async function runAndSaveOptimization() {
  console.log("=== STRATEGY OPTIMIZATION (GENETIC ALGORITHM) STARTING ===");

  const lockRef = doc(db, 'locks', OPTIMIZATION_LOCK_KEY);
  
  try {
    // --- Optimization Lock ---
    const lockSnapshot = await getDoc(lockRef);
    if (lockSnapshot.exists()) {
        const lockData = lockSnapshot.data();
        const lockTime = lockData.timestamp.toDate();
        // If lock is older than 15 minutes, release it
        if (new Date().getTime() - lockTime.getTime() > 15 * 60 * 1000) {
            console.warn("Stale optimization lock found. Releasing...");
            await deleteDoc(lockRef);
        } else {
            console.log("Optimization already in progress. Exiting.");
            return { success: false, message: "Optimization already running." };
        }
    }
    await setDoc(lockRef, { timestamp: new Date() });


    // 1. Load data
    const dogeChartData = await getChartData('DOGEUSDT');
    console.log(`Loaded ${dogeChartData.length} data points for backtesting.`);

    if (dogeChartData.length < 200) {
      throw new Error("Not enough historical data to run optimization.");
    }
    
    // --- Dynamic Parameter Ranges ---
    const recentData = dogeChartData.slice(-50);
    const recentCloses = recentData.map(d => d.close);
    const stdDev = Math.sqrt(recentCloses.reduce((s, p, i, a) => s + Math.pow(p - (a.reduce((a,b)=>a+b,0)/a.length), 2), 0) / (recentCloses.length -1));
    const avgPrice = recentCloses.reduce((a,b)=>a+b,0) / recentCloses.length;
    const volatility = stdDev / avgPrice; // Coefficient of variation as volatility metric
    console.log(`Current market volatility (CV): ${volatility.toFixed(4)}`);
    const parameterRanges = getDynamicParameterRanges(volatility);


    // 2. Run the optimization
    console.log("Running optimizeParameters (Genetic Algorithm) function...");
    const { bestParams, bestPerformance, bestTrades } = await optimizeParameters(dogeChartData, parameterRanges);
    
    if (!bestParams || !bestPerformance) {
        throw new Error("Optimization failed to find a suitable strategy.");
    }

    // 3. Save the results to Firestore
    console.log("Saving best parameters to Firestore...");
    const optimizationResultDoc = doc(db, 'optimizationResults', 'latest');
    await setDoc(optimizationResultDoc, {
      bestParams,
      bestPerformance,
      bestTrades, 
      timestamp: new Date(),
    });

    console.log("Successfully saved optimization results to Firestore.");
    return {
      success: true,
      message: "Optimization complete. Best parameters saved to Firestore.",
      bestParams,
      bestPerformance,
    };

  } catch (error) {
    console.error("Error during optimization:", error);
    return {
      success: false,
      message: `Optimization failed: ${(error as Error).message}`,
    };
  } finally {
      // --- Release Lock ---
      await deleteDoc(lockRef);
      console.log("Optimization lock released.");
  }
}

export async function GET() {
  // Non-blocking execution
  runAndSaveOptimization().catch(err => {
      console.error("Error in background optimization task:", err);
  });
  return NextResponse.json({ message: "Strategy optimization process initiated." });
}

    