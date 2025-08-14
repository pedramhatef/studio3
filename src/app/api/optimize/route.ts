
'use server';

import { NextResponse } from 'next/server';
import { getChartData } from '@/app/actions';
import { optimizeParameters } from '@/lib/backtesting';
import type { ChartDataPoint } from '@/lib/types';
import { db } from '@/lib/firebase';
import { setDoc, doc } from 'firebase/firestore';

// Define the parameter ranges for optimization
// NOTE: Keep the number of combinations low to avoid Vercel timeouts on the hobby plan.
const parameterRanges = {
    // Core Trend-Following - Test faster and slower trend confirmation
    EMA_FAST_PERIOD: [5, 8, 13],
    EMA_SLOW_PERIOD: [21, 25, 30],
    EMA_MEDIUM_PERIOD: [15], // Keep medium stable as a reference
    EMA_LONG_PERIOD: [40, 50],
    PARABOLIC_SAR_STEP: [0.02],
    PARABOLIC_SAR_MAX: [0.2],
  
    // Momentum-Reversal - Test different sensitivity levels
    RSI_PERIOD: [7, 9, 14],
    RSI_OVERSOLD_THRESHOLD: [25, 30, 35],
    RSI_OVERBOUGHT_THRESHOLD: [65, 70, 75],
    DEEP_RSI_THRESHOLD: [20, 25],
    DEEP_RSI_OVERBOUGHT: [75, 80],
    BBANDS_PERIOD: [14, 20],
    BBANDS_STD_DEV: [1.5],
    BBANDS_DEEP_MULTIPLIER: [2.0],
    VOLUME_SPIKE_FACTOR: [1.5, 2.0],
    MIN_CANDLE_BODY: [0.0001],
  
    // Momentum Shift
    RSI_CENTERLINE: [50],
    MIN_VOL_CHANGE: [1.5],
  
    // Volatility & Filters
    ATR_PERIOD: [10, 14],
    MIN_ATR_THRESHOLD: [0.00015],
    LOW_VOL_THRESHOLD: [0.0008],
    AVG_ATR_MULTIPLIER: [1.0],
    VOLUME_CONFIRMATION_FACTOR: [1.0],
    PRICE_POSITION_FILTER: [0.20],
    RSI_BUY_MAX: [65], // Allow buying in slightly stronger trends
    RSI_SELL_MIN: [35], // Allow selling in slightly weaker trends
    PSAR_BUFFER_FACTOR: [0.2],
  
    // Backtesting Simulation - Crucial for risk/reward profile
    TAKE_PROFIT_ATR_MULTIPLIER: [1.5, 2, 3],
    STOP_LOSS_ATR_MULTIPLIER: [1, 1.5, 2],
  };


async function runAndSaveOptimization() {
  console.log("=== STRATEGY OPTIMIZATION CRON (BACKTESTING) STARTING ===");

  // 1. Load data
  const chartData: ChartDataPoint[] = await getChartData();
  console.log(`Loaded ${chartData.length} data points for backtesting.`);

  if (chartData.length < 50) { // Need a reasonable amount of data
    console.error("Not enough historical data to run optimization.");
    return {
      success: false,
      message: "Not enough historical data to run optimization.",
    };
  }

  // 2. Run the optimization
  console.log("Running optimizeParameters function...");
  const { bestParams, bestPerformance, bestTrades } = await optimizeParameters(chartData, parameterRanges);
  
  if (!bestParams || !bestPerformance) {
    console.error("Optimization failed to find best parameters.");
    return {
      success: false,
      message: "Optimization did not yield a result.",
    };
  }

  // 3. Save the results to Firestore
  try {
    console.log("Saving best parameters to Firestore...");
    const optimizationResultDoc = doc(db, 'optimizationResults', 'latest');
    await setDoc(optimizationResultDoc, {
      bestParams,
      bestPerformance,
      bestTrades, // Save the simulated trades as well
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
    console.error("Error saving optimization results to Firestore:", error);
    return {
      success: false,
      message: `Failed to save results to Firestore: ${(error as Error).message}`,
    };
  }
}

export async function GET() {
  try {
    const result = await runAndSaveOptimization();
    return NextResponse.json(result);
  } catch (error) {
    console.error("An error occurred during the optimization GET request:", error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
