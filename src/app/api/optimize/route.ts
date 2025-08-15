

'use server';

import { NextResponse } from 'next/server';
import { getChartData } from '@/app/actions';
import { optimizeParameters, type StrategyParams } from '@/lib/backtesting';
import type { ChartDataPoint } from '@/lib/types';
import { db } from '@/lib/firebase';
import { setDoc, doc } from 'firebase/firestore';

// Define the parameter ranges for optimization
const parameterRanges: { [key in keyof Omit<StrategyParams, 
    'EMA_MEDIUM_PERIOD' |
    'DEEP_RSI_THRESHOLD' |
    'DEEP_RSI_OVERBOUGHT' |
    'BBANDS_PERIOD' |
    'BBANDS_STD_DEV' |
    'BBANDS_DEEP_MULTIPLIER' |
    'VOLUME_SPIKE_FACTOR' |
    'MIN_CANDLE_BODY' |
    'RSI_CENTERLINE' |
    'MIN_VOL_CHANGE' |
    'MIN_ATR_THRESHOLD' |
    'LOW_VOL_THRESHOLD' |
    'AVG_ATR_MULTIPLIER' |
    'VOLUME_CONFIRMATION_FACTOR' |
    'PRICE_POSITION_FILTER' |
    'RSI_BUY_MAX' |
    'RSI_SELL_MIN' |
    'PSAR_BUFFER_FACTOR' |
    'initialCapital'
>]: number[] } = {
  // Core Trend-Following
  EMA_FAST_PERIOD: [5, 7, 10, 13,],
  EMA_SLOW_PERIOD: [15, 20, 25],
  EMA_LONG_PERIOD: [30, 40, 50],
  PARABOLIC_SAR_STEP: [0.01, 0.02],
  PARABOLIC_SAR_MAX: [0.1, 0.2],

  // Momentum-Reversal
  RSI_PERIOD: [7, 9, 14],
  RSI_OVERSOLD_THRESHOLD: [30, 35, 40],
  RSI_OVERBOUGHT_THRESHOLD: [60, 65, 70],

  // Volatility & Filters
  ATR_PERIOD: [7, 10, 14],
  
  // Risk
  TAKE_PROFIT_ATR_MULTIPLIER: [1.5, 2.0, 2.5],
  STOP_LOSS_ATR_MULTIPLIER: [1.0, 1.5, 2.0],
  SPREAD_PERCENT: [0.01, 0.02],
  
  // Custom Filters
  ATR_VOLATILITY_THRESHOLD: [1.1, 1.2],
  VOLUME_PERIOD: [20],
  VOLUME_THRESHOLD_MULTIPLIER: [1.5, 2.0],
  RSI_BREAKOUT_THRESHOLD: [55],
  RSI_BREAKDOWN_THRESHOLD: [45]
};


async function runAndSaveOptimization() {
  console.log("Starting optimization process...");

  // 1. Load data
  // For a real scenario, you'd load a much larger historical dataset,
  // perhaps from a CSV, a dedicated data API, or a larger Firestore collection.
  // Here, we'll use getChartData as a stand-in for the historical data source.
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
  const { bestParams, bestPerformance } = await optimizeParameters(chartData, parameterRanges as any);
  
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
      timestamp: new Date(), // Use server timestamp
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
    // This process can be slow. Vercel's hobby plan has a 10s timeout for functions.
    // For real-world use, this should be run on a service that allows for longer execution times.
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

    