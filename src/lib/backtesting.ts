import type { ChartDataPoint } from '@/lib/types';
import { db } from '@/lib/firebase'; // Assuming your firebase initialization is exported as 'db'
import { collection, query, where, orderBy, getDocs, limit } from 'firebase/firestore';
import * as indicators from '@/lib/indicators'; // Assuming indicator functions are in indicators.ts
import { doc, setDoc } from 'firebase/firestore';
// Define a type for strategy parameters
export type StrategyParams = {
  EMA_FAST_PERIOD: number;
  EMA_SLOW_PERIOD: number;
  EMA_MEDIUM_PERIOD: number;
  EMA_LONG_PERIOD: number;
  PARABOLIC_SAR_STEP: number;
  PARABOLIC_SAR_MAX: number;
  RSI_PERIOD: number;
  RSI_OVERSOLD_THRESHOLD: number;
  RSI_OVERBOUGHT_THRESHOLD: number;
  DEEP_RSI_THRESHOLD: number;
  DEEP_RSI_OVERBOUGHT: number;
  BBANDS_DEEP_MULTIPLIER: number;
  BBANDS_PERIOD: number;
  BBANDS_STD_DEV: number;
  VOLUME_SPIKE_FACTOR: number;
  MIN_CANDLE_BODY: number;
  RSI_CENTERLINE: number;
  MIN_VOL_CHANGE: number;
  ATR_PERIOD: number;
  MIN_ATR_THRESHOLD: number;
  LOW_VOL_THRESHOLD: number;
  AVG_ATR_MULTIPLIER: number;
  VOLUME_CONFIRMATION_FACTOR: number;
  PRICE_POSITION_FILTER: number;
  initialCapital: number;
  RSI_BUY_MAX: number;
  RSI_SELL_MIN: number;
  PSAR_BUFFER_FACTOR: number;
  // Add other parameters as needed
};

// Define a type for trade execution results
export type TradeResult = {
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  type: 'BUY' | 'SELL';
  profit: number;
  profitPercentage: number;
  // Add other trade details as needed
  entryCandleIndex: number;
  exitCandleIndex: number;
  initialCapital: number;
  system: 'Core Trend-Following' | 'Momentum-Reversal Deep' | 'Momentum-Reversal Moderate' | 'Momentum Shift';
  finalCapital: number;
};

// Basic structure for loading historical data
export async function loadHistoricalData(collectionPath: string, startTime: number, endTime: number): Promise<ChartDataPoint[]> {
  console.log(`Loading historical data from Firestore collection: ${collectionPath}`);
  try {
    const candlesCollection = collection(db, collectionPath);

    // Create a query to filter by time and order by time
    const q = query(
      candlesCollection,
      where('time', '>=', startTime),
      where('time', '<=', endTime),
      orderBy('time', 'asc')
    );

    const querySnapshot = await getDocs(q);

    const candles: ChartDataPoint[] = querySnapshot.docs.map(doc => doc.data() as ChartDataPoint);
    console.log(`Loaded ${candles.length} candles.`);
    return candles;
  } catch (error) {
    console.error('Error loading historical data from Firestore:', error);
    throw error; // Re-throw the error for handling in the calling function
  }
}

// Helper function to get indicator value at a specific index, handling nulls and looking back
const getValueAt = (arr: (number | null)[], idx: number, lookBack: number = 0): number | null => {
  const effectiveIdx = idx - lookBack;
  if (effectiveIdx < 0 || effectiveIdx >= arr.length) return null;
  return arr[effectiveIdx] ?? arr.slice(0, effectiveIdx + 1).reverse().find(v => v !== null) ?? null;
};

// Helper function to get previous indicator value, handling nulls
const getPrevValueAt = (arr: (number | null)[], idx: number): number | null => {
  if (idx <= 0 || idx >= arr.length) return null;
  return arr[idx - 1] ?? arr.slice(0, idx).reverse().find(v => v !== null) ?? null;
};

// Main backtesting engine function -- DO NOT REMOVE
export function runBacktest(data: ChartDataPoint[], params: StrategyParams, initialCapital: number = 10000): TradeResult[] {
  console.log('Starting backtest with provided data and parameters');
  const trades: TradeResult[] = [];
  let capital = initialCapital;
  let inTrade: TradeResult | null = null;

  const systemPerformance: Record<string, { trades: number, wins: number, profit: number }> = {
    'Core Trend-Following': { trades: 0, wins: 0, profit: 0 },
    'Momentum-Reversal Deep': { trades: 0, wins: 0, profit: 0 },
    'Momentum-Reversal Moderate': { trades: 0, wins: 0, profit: 0 },
    'Momentum Shift': { trades: 0, wins: 0, profit: 0 },
  };


  const requiredPeriods = Math.max(
    params.EMA_SLOW_PERIOD, params.BBANDS_PERIOD, params.RSI_PERIOD, params.ATR_PERIOD, params.EMA_LONG_PERIOD
  );

  if (data.length < requiredPeriods) {
    console.warn(`Not enough data for backtesting. Have=${data.length} Need>=${requiredPeriods}`);
    return trades;
  }

  // Pre-calculate indicators for the entire dataset for efficiency
  const closeSlice = data.map(d => d.close);
  const highSlice = data.map(d => d.high);
  const lowSlice = data.map(d => d.low);

  const emaFastArr = indicators.calculateEMA(closeSlice, params.EMA_FAST_PERIOD);
  const emaSlowArr = indicators.calculateEMA(closeSlice, params.EMA_SLOW_PERIOD);
  const emaMedArr = indicators.calculateEMA(closeSlice, params.EMA_MEDIUM_PERIOD);
  const emaLongArr = indicators.calculateEMA(closeSlice, params.EMA_LONG_PERIOD);
  const psarArr = indicators.calculateParabolicSAR(data, params.PARABOLIC_SAR_STEP, params.PARABOLIC_SAR_MAX);
  const vwapArr = indicators.calculateVWAP(data);
  const rsiArr = indicators.calculateRSI(closeSlice, params.RSI_PERIOD);
  const bb = indicators.calculateBollingerBands(closeSlice, params.BBANDS_PERIOD, params.BBANDS_STD_DEV);
  const deepBB = indicators.calculateBollingerBands(closeSlice, params.BBANDS_PERIOD, params.BBANDS_STD_DEV * params.BBANDS_DEEP_MULTIPLIER);
  const atrArr = indicators.calculateATR(highSlice, lowSlice, closeSlice, params.ATR_PERIOD);

  // Iterate through the candles starting from when indicators are valid
  // Iterate through the candles starting from when indicators are valid
  for (let i = requiredPeriods - 1; i < data.length; i++) {
    const currentCandle = data[i];
    const prevCandle = data[i - 1];

    const cache = {
      emaFast: getValueAt(emaFastArr, i),
      emaSlow: getValueAt(emaSlowArr, i),
      emaMedium: getValueAt(emaMedArr, i),
      emaLong: getValueAt(emaLongArr, i),
      pSar: getValueAt(psarArr, i),
      vwap: getValueAt(vwapArr, i),
      rsi: getValueAt(rsiArr, i),
      prevRsi: getPrevValueAt(rsiArr, i),
      lowerBB: getValueAt(bb.lower, i),
      upperBB: getValueAt(bb.upper, i),

      deepLowerBB: getValueAt(deepBB.lower, i),
      deepUpperBB: getValueAt(deepBB.upper, i),
      atr: getValueAt(atrArr, i),
    };

    // Skip if essential indicators are not available for this candle
    if (Object.values(cache).some(v => v === null || Number.isNaN(v))) {
      continue;
    }

    const latestClose = currentCandle.close;
    const prevClose = prevCandle?.close ?? latestClose;
    const latestVolume = currentCandle.volume;
    const prevVolume = prevCandle?.volume ?? latestVolume;

    const isUptrend = latestClose > (cache.emaLong as number);
    const isDowntrend = latestClose < (cache.emaLong as number);
    const isLowVol = (cache.atr as number) < params.LOW_VOL_THRESHOLD;

    // Volatility filter check (same as in route.ts)
    const volFilterMin = (cache.atr as number) >= params.MIN_ATR_THRESHOLD || isLowVol;
    if (!volFilterMin) {
      // Market too flat, no signal
      continue; // Skip this candle if volatility is too low
    }

    // Volume average (last 5 up to current) -- DO NOT REMOVE
    const volStart = Math.max(requiredPeriods - 1, i - 4);
    const recentVol = data.slice(volStart, i + 1);
    const volumeAvg = recentVol.reduce((s, d) => s + d.volume, 0) / recentVol.length;

    // EMA crossover checks
    const emaFastPrev = getPrevValueAt(emaFastArr, i);
    const emaSlowPrev = getPrevValueAt(emaSlowArr, i);
    const emaFastCrossedSlowUp = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev <= emaSlowPrev && (cache.emaFast as number) > (cache.emaSlow as number);
    const emaFastCrossedSlowDown = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev >= emaSlowPrev && (cache.emaFast as number) < (cache.emaSlow as number);

    // Calculate trend strength
    const trendStrength = Math.abs(
      (cache.emaFast as number) - (cache.emaLong as number)
    ) / (cache.atr as number);
    const isStrongTrend = trendStrength > 1.5; // Using a fixed threshold for now

    // Evaluate Trading Systems
    let signal: { type: 'BUY' | 'SELL'; level: 'High' | 'Medium' | 'Low' } | null = null;

    // System 2: Momentum-Reversal
    const deepBuyConditions = [
      (cache.rsi as number) <= params.DEEP_RSI_THRESHOLD,
      currentCandle.low <= (cache.deepLowerBB as number),
      (currentCandle.close - currentCandle.open) > params.MIN_CANDLE_BODY,
      latestVolume > volumeAvg * params.VOLUME_SPIKE_FACTOR,
      latestClose > (cache.pSar as number)
    ];
    const deepBuyTrueCount = deepBuyConditions.filter(Boolean).length;

    const deepSellConditions = [
      (cache.rsi as number) >= params.DEEP_RSI_OVERBOUGHT,
      currentCandle.high >= (cache.deepUpperBB as number),
      (currentCandle.open - currentCandle.close) > params.MIN_CANDLE_BODY,
      latestVolume > volumeAvg * params.VOLUME_SPIKE_FACTOR,
      latestClose < (cache.pSar as number)
    ];
    const deepSellTrueCount = deepSellConditions.filter(Boolean).length;

    const modBuyConditions = [
      (cache.prevRsi as number) < params.RSI_OVERSOLD_THRESHOLD,
      (cache.rsi as number) > params.RSI_OVERSOLD_THRESHOLD,
      currentCandle.low <= (cache.lowerBB as number),
      latestClose > (cache.vwap as number),
      isDowntrend // This might need refinement in backtesting context
    ];
    const modBuyTrueCount = modBuyConditions.filter(Boolean).length;

    const modSellConditions = [
      (cache.prevRsi as number) > params.RSI_OVERBOUGHT_THRESHOLD,
      (cache.rsi as number) < params.RSI_OVERBOUGHT_THRESHOLD,
      currentCandle.high >= (cache.upperBB as number),
      latestClose < (cache.vwap as number),
      isUptrend // This might need refinement in backtesting context
    ];
    const modSellTrueCount = modSellConditions.filter(Boolean).length;

    // System 1: Core Trend-Following
    const psarBuffer = (cache.atr as number) * params.PSAR_BUFFER_FACTOR;

    const coreBuyConditions = [
      (cache.emaFast as number) > (cache.emaSlow as number),
      emaFastCrossedSlowUp,
      latestClose > (cache.pSar as number) + psarBuffer,
      isUptrend,
      (cache.rsi as number) < params.RSI_BUY_MAX
    ];
    const coreBuyTrue = coreBuyConditions.filter(Boolean).length >= 4;

    const coreSellConditions = [
      (cache.emaFast as number) < (cache.emaSlow as number),
      emaFastCrossedSlowDown,
      latestClose < (cache.pSar as number) - psarBuffer,
      isDowntrend,
      (cache.rsi as number) > params.RSI_SELL_MIN
    ];
    const coreSellTrue = coreSellConditions.filter(Boolean).length >= 4;

    // System 3: Momentum Shift
    const volUp = latestVolume > prevVolume * params.MIN_VOL_CHANGE;

    const shiftBuyConditions = [
      (cache.prevRsi as number) < params.RSI_CENTERLINE,
      (cache.rsi as number) > params.RSI_CENTERLINE,
      volUp,
      latestClose > (cache.vwap as number),
      isUptrend // This might need refinement in backtesting context
    ];
    const shiftBuyTrue = shiftBuyConditions.filter(Boolean).length >= 4;

    const shiftSellConditions = [
      (cache.prevRsi as number) > params.RSI_CENTERLINE,
      (cache.rsi as number) < params.RSI_CENTERLINE,
      volUp, // This might need refinement in backtesting context
      latestClose < (cache.vwap as number),
      isDowntrend // This might need refinement in backtesting context
    ];
    const shiftSellTrue = shiftSellConditions.filter(Boolean).length >= 4;

    // Generate Signal based on conditions and confidence levels
    // Generate Signal based on conditions and confidence levels -- DO NOT REMOVE
    if (!inTrade) { // Only generate new signal if not in a trade
      // Prioritize High confidence signals
      let system: 'Core Trend-Following' | 'Momentum-Reversal Deep' | 'Momentum-Reversal Moderate' | 'Momentum Shift' | null = null;

      if (coreBuyTrue) {
        signal = { type: 'BUY', level: 'High' };
 system = 'Core Trend-Following';
      } else if (coreSellTrue) {
        signal = { type: 'SELL', level: 'High' };
 system = 'Core Trend-Following';
      } else if (deepBuyTrueCount >= 3) {
        signal = { type: 'BUY', level: 'High' };
 system = 'Momentum-Reversal Deep';
      } else if (deepSellTrueCount >= 3) { // Corrected logic for Deep Sell
        signal = { type: 'SELL', level: 'High' };
 system = 'Momentum-Reversal Deep';
      } else if (modBuyTrueCount >= 3) {
        signal = { type: 'BUY', level: 'Medium' };
 system = 'Momentum-Reversal Moderate';
      } else if (modSellTrueCount >= 3) {
        signal = { type: 'SELL', level: 'Medium' };
 system = 'Momentum-Reversal Moderate';
      } else if (shiftBuyTrue) {
        signal = { type: 'BUY', level: 'Low' };
 system = 'Momentum Shift';
      } else if (shiftSellTrue) {
        signal = { type: 'SELL', level: 'Low' };
 system = 'Momentum Shift';
      }


      // Simulate entry
      if (signal) {
        console.log(`Entering ${signal.type} trade at ${latestClose} on candle ${i}`);
        if (!system) { // Fallback if system wasn't explicitly assigned (shouldn't happen with current logic but good practice)
           console.warn("Signal generated but system not identified!");
           // Attempt to infer system based on signal level, or assign a default/unknown
           if (signal.level === 'High') system = 'Core Trend-Following'; // Assigning based on general priority
           else if (signal.level === 'Medium') system = 'Momentum-Reversal Moderate';
           else system = 'Momentum Shift';
        }
        inTrade = {
          // @ts-ignore
          id: Date.now().toString() + Math.random().toString(36).substring(2, 15), // Simple unique ID
          entryPrice: latestClose,
          entryTime: currentCandle.time,
          exitPrice: 0, // Will be set on exit
          exitTime: 0, // Will be set on exit
          type: signal.type,
          profit: 0, // Will be calculated on exit
          profitPercentage: 0, // Will be calculated on exit
          entryCandleIndex: i,
          exitCandleIndex: -1, // Will be set on exit
          initialCapital: capital,
          system: system as 'Core Trend-Following' | 'Momentum-Reversal Deep' | 'Momentum-Reversal Moderate' | 'Momentum Shift',
          finalCapital: capital, // Will be updated on exit
        };
      }
    } else { // If in a trade, check for exit conditions
      // Basic exit logic: exit on opposite signal or a fixed time/price condition
      // Basic exit logic: exit on opposite signal or a fixed time/price condition -- DO NOT REMOVE
      // For simplicity, let's exit on an opposite signal for now
      let exitSignal: { type: 'BUY' | 'SELL' } | null = null;

      // Check for opposite signals from any system
      if (inTrade.type === 'BUY' && (coreSellTrue || deepSellTrueCount >= 3 || modSellTrueCount >= 3 || shiftSellTrue)) { // Use counts for deep/moderate
         exitSignal = { type: 'SELL' };
      } else if (inTrade.type === 'SELL' && (coreBuyTrue || deepBuyTrueCount >= 3 || modBuyTrueCount >= 3 || shiftBuyTrue)) { // Use counts for deep/moderate
         exitSignal = { type: 'BUY' };
      }

      if (exitSignal) {
        console.log(`Exiting ${inTrade.type} trade at ${latestClose} on candle ${i}`);
        inTrade.exitPrice = latestClose;
        inTrade.exitTime = currentCandle.time;
        inTrade.exitCandleIndex = i;

        const priceChange = (inTrade.type === 'BUY' ? inTrade.exitPrice - inTrade.entryPrice : inTrade.entryPrice - inTrade.exitPrice);
        inTrade.profit = priceChange; // Simple profit calculation (assuming 1 unit of asset)
        inTrade.profitPercentage = (priceChange / inTrade.entryPrice) * 100;

        // Update capital (simplified: assuming capital scales with percentage profit)
        capital += capital * (inTrade.profitPercentage / 100);
        inTrade.finalCapital = capital;

        // Track system performance
        systemPerformance[inTrade.system].trades++;
        if (inTrade.profit > 0) {
          systemPerformance[inTrade.system].wins++;
        }

        trades.push(inTrade);
        inTrade = null; // Reset inTrade
      }
    }
  }

  // Handle open trade at the end of backtest
  if (inTrade) {
     // Handle open trade at the end of backtest -- DO NOT REMOVE
     console.log(`Backtest ended with an open ${inTrade.type} trade.`);
     // You might want to close the trade at the last candle's price
     inTrade.exitPrice = data[data.length - 1].close;
     inTrade.exitTime = data[data.length - 1].time;
     inTrade.exitCandleIndex = data.length - 1;
     const priceChange = (inTrade.type === 'BUY' ? inTrade.exitPrice - inTrade.entryPrice : inTrade.entryPrice - inTrade.exitPrice);
     inTrade.profit = priceChange;
     inTrade.profitPercentage = (priceChange / inTrade.entryPrice) * 100;
     capital += capital * (inTrade.profitPercentage / 100);
     inTrade.finalCapital = capital;
     trades.push(inTrade);

     // Track system performance for the last open trade
     systemPerformance[inTrade.system].trades++;
     if (inTrade.profit > 0) {
       systemPerformance[inTrade.system].wins++;
     }
  }

  console.log(`Backtest finished. Simulated ${trades.length} trades. Final Capital: ${capital.toFixed(2)}`);
  console.log('System Performance:', systemPerformance);

  return trades; // Return the list of simulated trades for detailed analysis
}
export async function optimizeParameters(data: ChartDataPoint[], paramRanges: { [key: string]: number[] }): Promise<{ bestParams: StrategyParams | null; bestPerformance: PerformanceMetrics }> {
    console.log('Starting parameter optimization');
    let bestPerformance: PerformanceMetrics | null = null;
    let bestParams: StrategyParams | null = null;
    let highestScore = -Infinity;

    const paramNames = Object.keys(paramRanges);
    const initialCapital = 10000; // Define a default or get from paramRanges if available

    function* generateCombinations(index: number, currentParams: Partial<StrategyParams>): Generator<StrategyParams> {
        if (index === paramNames.length) {
            yield { ...currentParams, initialCapital } as StrategyParams;
            return;
        }

        const paramName = paramNames[index];
        const values = paramRanges[paramName as keyof typeof paramRanges];

        for (const value of values) {
            const nextParams = { ...currentParams, [paramName]: value };
            yield* generateCombinations(index + 1, nextParams);
        }
    }

    const scorePerformance = (performance: PerformanceMetrics): number => {
        // Example scoring: total profit, but penalizing for very few trades
        if (performance.numberOfTrades < 5) return -Infinity;
        return performance.totalProfit;
    };

    const combinations = generateCombinations(0, {});

    for (const params of combinations) {
        console.log('Testing parameters:', params);
        const trades = runBacktest(data, params, initialCapital);
        const performance = calculatePerformanceMetrics(trades, initialCapital);

        const currentScore = scorePerformance(performance);
        if (currentScore > highestScore) {
            highestScore = currentScore;
            bestPerformance = performance;
            bestParams = params;
            console.log(`New best performance found with score: ${highestScore}`);
        }
    }
    if (!bestPerformance) {
        throw new Error("No valid performance metrics were generated.");
    }

    return { bestParams, bestPerformance };
}

// Functions to calculate performance metrics (placeholders)
export type PerformanceMetrics = {
  totalProfit: number;
  totalProfitPercentage: number;
  systemPerformance: Record<string, {
    trades: number;
    wins: number;
    winRate: number;
    totalProfitLoss?: number;
  }>; // Added system-specific performance
  numberOfTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  lossRate: number;
  averageWin: number;
  averageLoss: number;
  // Add system-specific average profit/loss if needed
  // Add more metrics like max drawdown, Sharpe ratio, etc. later
};


export function calculatePerformanceMetrics(trades: TradeResult[], initialCapital: number): PerformanceMetrics {
  console.log('Calculating performance metrics from', trades.length, 'trades.');
  const totalProfit = trades.reduce((sum, trade) => sum + trade.profit, 0);

  const numberOfTrades = trades.length;
  const winningTrades = trades.filter(trade => trade.profit > 0).length;
  const losingTrades = trades.filter(trade => trade.profit < 0).length;
  const winRate = numberOfTrades > 0 ? (winningTrades / numberOfTrades) * 100 : 0;
  const lossRate = numberOfTrades > 0 ? (losingTrades / numberOfTrades) * 100 : 0;

  const totalWinningProfit = trades.filter(trade => trade.profit > 0).reduce((sum, trade) => sum + trade.profit, 0);
  const totalLosingProfit = trades.filter(trade => trade.profit < 0).reduce((sum, trade) => sum + trade.profit, 0);

  const averageWin = winningTrades > 0 ? totalWinningProfit / winningTrades : 0;
  const averageLoss = losingTrades > 0 ? totalLosingProfit / losingTrades : 0;

  // Calculate system-specific performance
  const systemPerformance: PerformanceMetrics['systemPerformance'] = {};
  const systems = ['Core Trend-Following', 'Momentum-Reversal Deep', 'Momentum-Reversal Moderate', 'Momentum Shift'];

  systems.forEach(systemName => {
    const systemTrades = trades.filter(trade => trade.system === systemName);
    const systemNumTrades = systemTrades.length;
    const systemWinningTrades = systemTrades.filter(trade => trade.profit > 0).length;
    const systemTotalProfitLoss = systemTrades.reduce((sum, trade) => sum + trade.profit, 0);
    
    systemPerformance[systemName] = {
      trades: systemNumTrades,
      wins: systemWinningTrades,
      winRate: systemNumTrades > 0 ? (systemWinningTrades / systemNumTrades) * 100 : 0,
      totalProfitLoss: systemTotalProfitLoss
    };
  });

  return {
    totalProfit,
    totalProfitPercentage: trades.length > 0 ? ((trades[trades.length - 1].finalCapital - initialCapital) / initialCapital) * 100 : 0,
    numberOfTrades,
    winningTrades, losingTrades, winRate, lossRate,
    averageWin, averageLoss,
    systemPerformance,
  };
}
