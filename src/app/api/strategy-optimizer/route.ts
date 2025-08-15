

'use server';

import { NextResponse } from 'next/server';
import { getChartData } from '../../../app/actions';
import { optimizeParameters } from '../../../lib/backtesting';
import type { ChartDataPoint } from '../../../lib/types';
import { db } from '../../../lib/firebase';
import { setDoc, doc } from 'firebase/firestore';

// Define the parameter ranges for optimization. These have been expanded to provide
// the optimizer with more meaningful choices to adapt to different market conditions.
const parameterRanges = {
  // Core Trend-Following - Using Fibonacci-like numbers, common in trading analysis
  EMA_FAST_PERIOD: [8, 13, 21],
  EMA_SLOW_PERIOD: [21, 34, 55],
  EMA_LONG_PERIOD: [50, 100, 200],
  PARABOLIC_SAR_STEP: [0.02], // Standard value, less need for optimization here
  PARABOLIC_SAR_MAX: [0.2],   // Standard value

  // Momentum - Wider ranges to find different types of momentum conditions
  RSI_PERIOD: [9, 14],
  RSI_OVERSOLD_THRESHOLD: [20, 25, 30, 35, 40], // Can it find entries in oversold or just pullback zones?
  RSI_OVERBOUGHT_THRESHOLD: [60, 65, 70, 75, 80], // Symmetrical to oversold
  RSI_BREAKOUT_THRESHOLD: [52, 55, 60], // Threshold for confirming a volume breakout
  RSI_BREAKDOWN_THRESHOLD: [40, 45, 48], // Threshold for confirming a volume breakdown
  
  // Volatility Filter - More granular options to adapt to different volatility regimes
  ATR_PERIOD: [10, 14],
  ATR_VOLATILITY_THRESHOLD: [0.8, 1.0, 1.25, 1.5], // Key for adapting to market pace

  // Volume Filter
  VOLUME_PERIOD: [20], // Standard period for volume averaging
  VOLUME_THRESHOLD_MULTIPLIER: [1.5, 2.0, 2.5], // How much larger the volume needs to be
  
  // Backtesting Simulation & Risk - Wider risk/reward profiles
  TAKE_PROFIT_ATR_MULTIPLIER: [1.5, 2.0, 2.5, 3.0, 3.5], // Test different reward targets
  STOP_LOSS_ATR_MULTIPLIER: [1.0, 1.5, 2.0, 2.5], // Test different risk tolerances

  // Market Friction - Simulate real-world trading costs
  SPREAD_PERCENT: [0.005, 0.01] // Represents a realistic trading spread
};


async function runAndSaveOptimization() {
  console.log("=== STRATEGY OPTIMIZATION (BACKTESTING) STARTING ===");

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