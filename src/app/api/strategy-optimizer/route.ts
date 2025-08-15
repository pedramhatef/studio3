

'use server';

import { NextResponse } from 'next/server';
import { getChartData } from '../../../app/actions';
import { optimizeParameters } from '../../../lib/backtesting';
import type { ChartDataPoint, StrategyParams } from '../../../lib/types';
import { db } from '../../../lib/firebase';
import { setDoc, doc } from 'firebase/firestore';

const parameterRanges: { [key in keyof StrategyParams]?: number[] } = {
  // Core Trend-Following
  EMA_FAST_PERIOD: [5, 10, 15],
  EMA_SLOW_PERIOD: [20, 30, 40],
  
  // Momentum
  RSI_PERIOD: [14],
  RSI_OVERSOLD_THRESHOLD: [30, 35],
  RSI_OVERBOUGHT_THRESHOLD: [65, 70],
  
  // Volatility Filter & Risk Management
  ATR_PERIOD: [7, 10, 12],
  TAKE_PROFIT_ATR_MULTIPLIER: [2.0, 2.5, 3.0],
  STOP_LOSS_ATR_MULTIPLIER: [1.5, 2.0],
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
