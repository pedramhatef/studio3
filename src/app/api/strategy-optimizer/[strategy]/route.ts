
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
  EMA_FAST_PERIOD: [3, 5, 8],
  EMA_SLOW_PERIOD: [10, 13, 21], 
  PARABOLIC_SAR_STEP: [0.02, 0.025, 0.03],
  PARABOLIC_SAR_MAX: [0.2, 0.25, 0.3],
  RSI_PERIOD: [7, 9, 12],
  RSI_OVERSOLD_THRESHOLD: [25, 30, 35], // Tightened from 20 to avoid deep oversold bounces that fail
  RSI_OVERBOUGHT_THRESHOLD: [65, 70, 75], // Tightened from 80
  VOLUME_PERIOD: [8, 12, 15],
  VOLUME_THRESHOLD_MULTIPLIER: [1.8, 2.2, 2.5], // Keep this high to confirm breakouts
  VOLUME_THRESHOLD_MULTIPLIERConfirmation: [1.0, 1.3],
  ATR_PERIOD: [8, 10, 12],
  TAKE_PROFIT_ATR_MULTIPLIER: [1.2, 1.5, 2.0],
  STOP_LOSS_ATR_MULTIPLIER: [0.8, 1.0, 1.2],
  NOISE_FILTER_RATIO: [0.15, 0.25], 
};

// Balanced ranges for intraday trends.
// Goal: Good win rate with decent profit per trade.
const dayTradeParameterRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]: number[] } = {
  EMA_FAST_PERIOD: [5, 8, 13],
  EMA_SLOW_PERIOD: [20, 25, 30],
  PARABOLIC_SAR_STEP: [0.015, 0.02, 0.025],
  PARABOLIC_SAR_MAX: [0.2, 0.25],
  RSI_PERIOD: [12, 14, 21],
  RSI_OVERSOLD_THRESHOLD: [35, 40], // Raised to be more selective
  RSI_OVERBOUGHT_THRESHOLD: [60, 65], // Lowered to be more selective
  VOLUME_PERIOD: [20, 25, 30],
  VOLUME_THRESHOLD_MULTIPLIER: [1.5, 1.7, 2.0], // Increased to demand stronger volume confirmation
  VOLUME_THRESHOLD_MULTIPLIERConfirmation: [0.9, 1.1, 1.3],
  ATR_PERIOD: [12, 14, 16],
  TAKE_PROFIT_ATR_MULTIPLIER: [2.0, 2.5, 3.0],
  STOP_LOSS_ATR_MULTIPLIER: [1.2, 1.5, 2.0],
  NOISE_FILTER_RATIO: [0.25, 0.35],
};

// Wider ranges for longer trends
// Goal: Catch larger moves, win rate is less important than profit factor.
const swingParameterRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]: number[] } = {
  EMA_FAST_PERIOD: [13, 21, 34],
  EMA_SLOW_PERIOD: [50, 75, 100],
  PARABOLIC_SAR_STEP: [0.01, 0.015, 0.02],
  PARABOLIC_SAR_MAX: [0.1, 0.15, 0.2],
  RSI_PERIOD: [21, 28, 35],
  RSI_OVERSOLD_THRESHOLD: [25, 30, 35], // Kept this range as it's standard for swing
  RSI_OVERBOUGHT_THRESHOLD: [65, 70, 75], // Kept this range as it's standard for swing
  VOLUME_PERIOD: [30, 40, 50],
  VOLUME_THRESHOLD_MULTIPLIER: [1.0, 1.2, 1.5], // Relaxed to capture trend starts, not just spikes
  VOLUME_THRESHOLD_MULTIPLIERConfirmation: [0.7, 0.9, 1.0],
  ATR_PERIOD: [14, 21, 28],
  TAKE_PROFIT_ATR_MULTIPLIER: [3.5, 5.0, 6.0],
  STOP_LOSS_ATR_MULTIPLIER: [2.0, 2.5, 3.0],
  NOISE_FILTER_RATIO: [0.35, 0.5],
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
    } catch (error)
      console.error("An error occurred during the optimization GET request:", error);
      return NextResponse.json(
        { error: (error as Error).message },
        { status: 500 }
      );
    }
  }

