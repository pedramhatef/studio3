
'use server';

import { NextResponse, NextRequest } from 'next/server';
import { getChartData } from '../../../app/actions';
import { optimizeParameters } from '../../../lib/backtesting';
import type { StrategyParams, StrategyType } from '../../../lib/types';
import { db } from '../../../lib/firebase';
import { setDoc, doc } from 'firebase/firestore';

// Tighter ranges for quick, small moves
const scalpParameterRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]: number[] } = {
  EMA_FAST_PERIOD: [3, 5, 8],
  EMA_SLOW_PERIOD: [13, 15, 21],
  PARABOLIC_SAR_STEP: [0.02, 0.025, 0.03],
  PARABOLIC_SAR_MAX: [0.2, 0.25, 0.3],
  RSI_PERIOD: [9, 12, 14],
  RSI_OVERSOLD_THRESHOLD: [25, 30, 35],
  RSI_OVERBOUGHT_THRESHOLD: [65, 70, 75],
  VOLUME_PERIOD: [10, 15, 20],
  VOLUME_THRESHOLD_MULTIPLIER: [1.5, 2.0],
  VOLUME_THRESHOLD_MULTIPLIERConfirmation: [1.0, 1.2],
  ATR_PERIOD: [10, 12],
  TAKE_PROFIT_ATR_MULTIPLIER: [1.5, 2.0, 2.5],
  STOP_LOSS_ATR_MULTIPLIER: [1.0, 1.5],
  NOISE_FILTER_RATIO: [0.2, 0.3],
};

// Current balanced ranges
const dayTradeParameterRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]: number[] } = {
  EMA_FAST_PERIOD: [5, 8, 10, 13],
  EMA_SLOW_PERIOD: [21, 25, 30, 35],
  PARABOLIC_SAR_STEP: [0.015, 0.02, 0.025],
  PARABOLIC_SAR_MAX: [0.15, 0.2, 0.25],
  RSI_PERIOD: [14, 21],
  RSI_OVERSOLD_THRESHOLD: [35, 40, 45],
  RSI_OVERBOUGHT_THRESHOLD: [55, 60, 65],
  VOLUME_PERIOD: [20, 30],
  VOLUME_THRESHOLD_MULTIPLIER: [1.2, 1.5],
  VOLUME_THRESHOLD_MULTIPLIERConfirmation: [0.8, 1.0],
  ATR_PERIOD: [12, 14],
  TAKE_PROFIT_ATR_MULTIPLIER: [2.5, 3.0, 4.0],
  STOP_LOSS_ATR_MULTIPLIER: [1.5, 2.0, 2.5],
  NOISE_FILTER_RATIO: [0.3, 0.4],
};

// Wider ranges for longer trends
const swingParameterRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]: number[] } = {
  EMA_FAST_PERIOD: [15, 21, 30],
  EMA_SLOW_PERIOD: [50, 60, 75],
  PARABOLIC_SAR_STEP: [0.01, 0.015, 0.02],
  PARABOLIC_SAR_MAX: [0.1, 0.15, 0.2],
  RSI_PERIOD: [21, 28, 35],
  RSI_OVERSOLD_THRESHOLD: [40, 45, 50],
  RSI_OVERBOUGHT_THRESHOLD: [50, 55, 60],
  VOLUME_PERIOD: [30, 40, 50],
  VOLUME_THRESHOLD_MULTIPLIER: [1.0, 1.2],
  VOLUME_THRESHOLD_MULTIPLIERConfirmation: [0.7, 0.9],
  ATR_PERIOD: [14, 21],
  TAKE_PROFIT_ATR_MULTIPLIER: [4.0, 5.0, 6.0],
  STOP_LOSS_ATR_MULTIPLIER: [2.5, 3.0, 3.5],
  NOISE_FILTER_RATIO: [0.4, 0.5],
};


const strategyMap = {
  Scalp: scalpParameterRanges,
  Day: dayTradeParameterRanges,
  Swing: swingParameterRanges,
};

async function runAndSaveOptimization(strategyType: StrategyType) {
  console.log(`=== STRATEGY OPTIMIZATION (${strategyType}) STARTING ===`);
  
  const parameterRanges = strategyMap[strategyType];
  if (!parameterRanges) {
    throw new Error(`Invalid strategy type provided: ${strategyType}`);
  }

  // Load data for DOGE
  const dogeChartData = await getChartData('DOGEUSDT', 1000);
  console.log(`Loaded ${dogeChartData.length} DOGE data points for backtesting.`);

  if (dogeChartData.length < 500) {
    console.error("Not enough historical data to run optimization.");
    return {
      success: false,
      message: "Not enough historical data to run optimization.",
    };
  }

  // Run the optimization
  console.log(`Running optimizeParameters for ${strategyType}...`);
  const { bestParams, bestPerformance, bestTrades } = await optimizeParameters(dogeChartData, parameterRanges);
  
  if (!bestParams || !bestPerformance) {
    console.error("Optimization failed to find best parameters.");
    return {
      success: false,
      message: "Optimization did not yield a result.",
    };
  }

  // Save the results to Firestore
  try {
    const docId = `latest-${strategyType}`;
    console.log(`Saving best parameters to Firestore document: ${docId}`);
    const optimizationResultDoc = doc(db, 'optimizationResults', docId);
    await setDoc(optimizationResultDoc, {
      strategyType,
      bestParams,
      bestPerformance,
      bestTrades,
      timestamp: new Date(),
    });
    console.log("Successfully saved optimization results to Firestore.");
    return {
      success: true,
      message: `Optimization complete for ${strategyType}. Best parameters saved.`,
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

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const strategy = (searchParams.get('strategy') as StrategyType) || 'Day';

  if (!Object.keys(strategyMap).includes(strategy)) {
      return NextResponse.json({ message: 'Invalid strategy type provided.' }, { status: 400 });
  }

  try {
    // Run in background, don't await
    runAndSaveOptimization(strategy).catch(err => {
        console.error(`Error in background optimization task for ${strategy}:`, err);
    });
    return NextResponse.json({ message: `Strategy optimization for ${strategy} started in the background.` });
  } catch (error) {
    console.error("An error occurred during the optimization GET request:", error);
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 }
    );
  }
}
