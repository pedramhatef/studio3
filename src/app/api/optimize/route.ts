
'use server';

import { NextResponse } from 'next/server';
import { getChartData } from '@/app/actions';
import { optimizeParameters } from '@/lib/backtesting';
import type { ChartDataPoint } from '@/lib/types';
import { db } from '@/lib/firebase';
import { setDoc, doc } from 'firebase/firestore';

// Define the parameter ranges for optimization
// NOTE: Keep the number of combinations low to avoid Vercel timeouts on the hobby plan.
// Total combinations = 3 * 2 * 1 * ...
const parameterRanges = {
  // Core Trend-Following
  EMA_FAST_PERIOD: [5, 7, 10],
  EMA_SLOW_PERIOD: [20, 25],
  EMA_MEDIUM_PERIOD: [15],
  EMA_LONG_PERIOD: [40],
  PARABOLIC_SAR_STEP: [0.02],
  PARABOLIC_SAR_MAX: [0.2],

  // Momentum-Reversal
  RSI_PERIOD: [9, 14],
  RSI_OVERSOLD_THRESHOLD: [30, 35],
  RSI_OVERBOUGHT_THRESHOLD: [65, 70],
  DEEP_RSI_THRESHOLD: [25],
  DEEP_RSI_OVERBOUGHT: [75],
  BBANDS_PERIOD: [14],
  BBANDS_STD_DEV: [1.5],
  BBANDS_DEEP_MULTIPLIER: [2.0],
  VOLUME_SPIKE_FACTOR: [1.5],
  MIN_CANDLE_BODY: [0.0001],

  // Momentum Shift
  RSI_CENTERLINE: [50],
  MIN_VOL_CHANGE: [1.5],

  // Volatility & Filters
  ATR_PERIOD: [10],
  MIN_ATR_THRESHOLD: [0.00015],
  LOW_VOL_THRESHOLD: [0.0008],
  AVG_ATR_MULTIPLIER: [1.0],
  VOLUME_CONFIRMATION_FACTOR: [1.0],
  PRICE_POSITION_FILTER: [0.20],
  RSI_BUY_MAX: [60],
  RSI_SELL_MIN: [40],
  PSAR_BUFFER_FACTOR: [0.2],
};

async function runAndSaveOptimization() {
  console.log("Starting optimization process...");

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
  const { bestParams, bestPerformance } = await optimizeParameters(chartData, parameterRanges);
  
  if (!bestParams) {
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
  // Increase the max duration for this function on Vercel
  // This is a Vercel-specific feature
  // Note: this is only available on paid plans. It will have no effect on the Hobby plan.
  // The hobby plan has a hard limit of 10-15s.
  // We keep the logic here for when you upgrade.
  // See: https://vercel.com/docs/functions/serverless-functions/runtimes#max-duration
  // export const maxDuration = 300; // 5 minutes

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
