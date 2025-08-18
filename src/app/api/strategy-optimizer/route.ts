
'use server';

import { NextResponse } from 'next/server';
import { getChartData } from '../../../app/actions';
import { optimizeParameters } from '../../../lib/backtesting';
import type { StrategyParams } from '../../../lib/types';
import { db } from '../../../lib/firebase';
import { setDoc, doc } from 'firebase/firestore';

const parameterRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]: number[] } = {
  // Core Trend-Following - Wider gap between fast and slow to catch established trends
  EMA_FAST_PERIOD: [8, 10, 13, 15],
  EMA_SLOW_PERIOD: [25, 30, 35, 40, 50],
  
  // Parabolic SAR - Standard values
  PARABOLIC_SAR_STEP: [0.01, 0.02, 0.03],
  PARABOLIC_SAR_MAX: [0.1, 0.2, 0.3],

  // Momentum - Wider RSI thresholds to allow for more pullback opportunities
  RSI_PERIOD: [14, 21],
  RSI_OVERSOLD_THRESHOLD: [30, 35, 40],
  RSI_OVERBOUGHT_THRESHOLD: [60, 65, 70],
  
  // Volume - Relaxed thresholds to avoid filtering out good signals on moderate volume
  VOLUME_PERIOD: [20, 30, 50],
  VOLUME_THRESHOLD_MULTIPLIER: [1.2, 1.5, 1.8], 
  VOLUME_THRESHOLD_MULTIPLIERConfirmation: [0.8, 1.0, 1.2], 

  // Volatility & Risk - More flexible ATR multipliers
  ATR_PERIOD: [12, 14],
  TAKE_PROFIT_ATR_MULTIPLIER: [2.5, 3.0, 3.5, 4.0],
  STOP_LOSS_ATR_MULTIPLIER: [1.5, 2.0, 2.5],
  NOISE_FILTER_RATIO: [0.3, 0.4, 0.5], 
};


async function runAndSaveOptimization() {
  console.log("=== STRATEGY OPTIMIZATION (GENETIC ALGORITHM) STARTING ===");

  // 1. Load data for DOGE
  const dogeChartData = await getChartData('DOGEUSDT', 1000);

  console.log(`Loaded ${dogeChartData.length} DOGE data points for backtesting.`);

  if (dogeChartData.length < 500) {
    console.error("Not enough historical data to run optimization.");
    return {
      success: false,
      message: "Not enough historical data to run optimization.",
    };
  }

  // 2. Run the optimization
  console.log("Running optimizeParameters (Genetic Algorithm) function...");
  const { bestParams, bestPerformance, bestTrades } = await optimizeParameters(dogeChartData, parameterRanges);
  
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
    console.error("Error saving optimization results to Firestore:", error);
    return {
      success: false,
      message: `Failed to save results to Firestore: ${(error as Error).message}`,
    };
  }
}

export async function GET() {
  try {
    runAndSaveOptimization().catch(err => {
        console.error("Error in background optimization task:", err);
    });
    return NextResponse.json({ message: "Strategy optimization started in the background." });
  } catch (error) {
    console.error("An error occurred during the optimization GET request:", error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
