
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
  EMA_FAST_PERIOD: [3, 4, 5],           // Very fast response
  EMA_SLOW_PERIOD: [8, 10, 12],         // Quick but stable baseline
  PARABOLIC_SAR_STEP: [0.025, 0.03, 0.035], // Aggressive SAR sensitivity
  PARABOLIC_SAR_MAX: [0.2, 0.25, 0.3],  // Tighter max acceleration
  RSI_PERIOD: [6, 7, 8],                // Very responsive RSI
  RSI_OVERSOLD_THRESHOLD: [30, 32, 35], // Avoid deep oversold traps
  RSI_OVERBOUGHT_THRESHOLD: [65, 68, 70], // Avoid overbought false signals
  VOLUME_PERIOD: [7, 8, 9],             // Short volume avg for responsiveness
  VOLUME_THRESHOLD_MULTIPLIER: [2.0, 2.2, 2.5], // High volume confirmation
  VOLUME_THRESHOLD_MULTIPLIERConfirmation: [1.2, 1.3, 1.4], // Strong pullback volume
  ATR_PERIOD: [7, 8, 9],                // Short ATR for noise filtering
  TAKE_PROFIT_ATR_MULTIPLIER: [1.0, 1.2, 1.5],  // Tight take-profit
  STOP_LOSS_ATR_MULTIPLIER: [0.7, 0.8, 0.9],     // Tight stop-loss
  NOISE_FILTER_RATIO: [0.1, 0.15, 0.2], // Strict noise filter
};

// Balanced ranges for intraday trends.
// Goal: Good win rate with decent profit per trade.
const dayTradeParameterRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]: number[] } = {
  EMA_FAST_PERIOD: [7, 8, 9],           // Balanced speed
  EMA_SLOW_PERIOD: [20, 22, 25],        // Reliable trend baseline
  PARABOLIC_SAR_STEP: [0.018, 0.02, 0.022], // Moderate SAR sensitivity
  PARABOLIC_SAR_MAX: [0.18, 0.2, 0.22], // Standard max acceleration
  RSI_PERIOD: [12, 14, 16],             // Classic RSI period
  RSI_OVERSOLD_THRESHOLD: [35, 38, 40], // Avoid weak bounces
  RSI_OVERBOUGHT_THRESHOLD: [60, 62, 65], // Early exit from overbought
  VOLUME_PERIOD: [18, 20, 22],          // Medium-term volume avg
  VOLUME_THRESHOLD_MULTIPLIER: [1.7, 1.9, 2.1], // Strong volume confirmation
  VOLUME_THRESHOLD_MULTIPLIERConfirmation: [1.0, 1.1, 1.2], // Moderate pullback volume
  ATR_PERIOD: [12, 13, 14],             // Standard ATR period
  TAKE_PROFIT_ATR_MULTIPLIER: [2.0, 2.3, 2.6],  // Balanced reward
  STOP_LOSS_ATR_MULTIPLIER: [1.2, 1.4, 1.6],     // Balanced risk
  NOISE_FILTER_RATIO: [0.25, 0.3, 0.35], // Moderate noise filter
};

// Wider ranges for longer trends
// Goal: Catch larger moves, win rate is less important than profit factor.
const swingParameterRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]: number[] } = {
  EMA_FAST_PERIOD: [18, 21, 24],        // Slower, more reliable
  EMA_SLOW_PERIOD: [65, 75, 85],        // Long-term trend
  PARABOLIC_SAR_STEP: [0.01, 0.012, 0.014], // Conservative SAR
  PARABOLIC_SAR_MAX: [0.1, 0.12, 0.14], // Slow acceleration
  RSI_PERIOD: [24, 28, 32],             // Smoothed RSI
  RSI_OVERSOLD_THRESHOLD: [28, 30, 32], // Allow deeper oversold
  RSI_OVERBOUGHT_THRESHOLD: [68, 70, 72], // Allow deeper overbought
  VOLUME_PERIOD: [35, 40, 45],          // Long-term volume avg
  VOLUME_THRESHOLD_MULTIPLIER: [1.0, 1.1, 1.2], // Relaxed volume for trend starts
  VOLUME_THRESHOLD_MULTIPLIERConfirmation: [0.8, 0.9, 1.0], // Weak pullback volume ok
  ATR_PERIOD: [18, 21, 24],             // Smoothed ATR
  TAKE_PROFIT_ATR_MULTIPLIER: [4.5, 5.0, 5.5],  // Wide take-profit
  STOP_LOSS_ATR_MULTIPLIER: [2.2, 2.5, 2.8],     // Wide stop-loss
  NOISE_FILTER_RATIO: [0.4, 0.45, 0.5], // Loose noise filter
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
