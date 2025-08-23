
'use server';

import { NextResponse, NextRequest } from 'next/server';
import { getChartData } from '../../../../app/actions';
import { optimizeParameters } from '../../../../lib/backtesting';
import type { StrategyParams, StrategyType } from '../../../../lib/types';
import { db } from '../../../../lib/firebase';
import { setDoc, doc } from 'firebase/firestore';

// Tighter ranges for quick, small moves.
// Goal: High win rate, quick in-and-out.
const scalpParameterRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]: number[] } = {
  EMA_FAST_PERIOD: [2, 3, 4, 5],         // slightly slower to smooth micro-spikes
  EMA_SLOW_PERIOD: [6, 8, 10, 12],
  PARABOLIC_SAR_STEP: [0.02, 0.025, 0.03, 0.035],
  PARABOLIC_SAR_MAX: [0.18, 0.2, 0.25, 0.3],
  RSI_PERIOD: [5, 6, 7, 8],
  RSI_OVERSOLD_THRESHOLD: [27, 28, 30, 32],
  RSI_OVERBOUGHT_THRESHOLD: [68, 70, 72, 74],
  VOLUME_PERIOD: [6, 7, 8, 9],
  VOLUME_THRESHOLD_MULTIPLIER: [1.8, 2.0, 2.2, 2.5],
  VOLUME_THRESHOLD_MULTIPLIERConfirmation: [1.1, 1.2, 1.3, 1.4],
  ATR_PERIOD: [5, 6, 7, 8],
  TAKE_PROFIT_ATR_MULTIPLIER: [1.2, 1.5, 1.8],
  STOP_LOSS_ATR_MULTIPLIER: [0.6, 0.7, 0.8, 0.9],
  NOISE_FILTER_RATIO: [0.1, 0.12, 0.15, 0.18],

};

// Balanced ranges for intraday trends.
// Goal: Good win rate with decent profit per trade.
const dayTradeParameterRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]: number[] } = {
  EMA_FAST_PERIOD: [9, 10, 11, 12, 13],
  EMA_SLOW_PERIOD: [25, 27, 30, 32, 35],
  PARABOLIC_SAR_STEP: [0.017, 0.018, 0.02, 0.022, 0.024],
  PARABOLIC_SAR_MAX: [0.18, 0.19, 0.2, 0.21, 0.22],
  RSI_PERIOD: [12, 13, 14, 15, 16],
  RSI_OVERSOLD_THRESHOLD: [32, 33, 35, 37, 38],
  RSI_OVERBOUGHT_THRESHOLD: [62, 63, 65, 67, 68],
  VOLUME_PERIOD: [17, 18, 20, 21, 22],
  VOLUME_THRESHOLD_MULTIPLIER: [1.7, 1.8, 1.9, 2.0, 2.1],
  VOLUME_THRESHOLD_MULTIPLIERConfirmation: [1.0, 1.05, 1.1, 1.15, 1.2],
  ATR_PERIOD: [13, 14, 15, 16, 17],
  TAKE_PROFIT_ATR_MULTIPLIER: [2.0, 2.2, 2.4, 2.6, 2.8],
  STOP_LOSS_ATR_MULTIPLIER: [1.2, 1.3, 1.4, 1.5, 1.6],
  NOISE_FILTER_RATIO: [0.23, 0.25, 0.28, 0.3, 0.32],

};

// Wider ranges for longer trends
// Goal: Catch larger moves, win rate is less important than profit factor.
const swingParameterRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]: number[] } = {
  EMA_FAST_PERIOD: [18, 20, 22, 25, 28],
  EMA_SLOW_PERIOD: [70, 80, 90, 100, 110],
  PARABOLIC_SAR_STEP: [0.01, 0.011, 0.012, 0.013, 0.014],
  PARABOLIC_SAR_MAX: [0.1, 0.11, 0.12, 0.13, 0.14],
  RSI_PERIOD: [24, 26, 28, 30, 32],
  RSI_OVERSOLD_THRESHOLD: [25, 26, 28, 30, 32],
  RSI_OVERBOUGHT_THRESHOLD: [68, 70, 72, 73, 75],
  VOLUME_PERIOD: [33, 35, 38, 40, 45],
  VOLUME_THRESHOLD_MULTIPLIER: [0.9, 1.0, 1.1, 1.2],
  VOLUME_THRESHOLD_MULTIPLIERConfirmation: [0.7, 0.8, 0.9, 1.0],
  ATR_PERIOD: [18, 20, 22, 24, 26],
  TAKE_PROFIT_ATR_MULTIPLIER: [4.5, 5.0, 5.5, 6.0, 6.5],
  STOP_LOSS_ATR_MULTIPLIER: [2.2, 2.5, 2.8, 3.0, 3.2],
  NOISE_FILTER_RATIO: [0.35, 0.38, 0.4, 0.42, 0.45],
};


const strategyMap: { [key: string]: any } = {
  Scalp: scalpParameterRanges,
  Day: dayTradeParameterRanges,
  Swing: swingParameterRanges,
};

function capitalizeFirstLetter(string: string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

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

export async function GET(
    request: NextRequest,
    { params }: { params: { strategy: string } }
  ) {
    const strategyParam = params.strategy;
    const strategy = capitalizeFirstLetter(strategyParam) as StrategyType;

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
