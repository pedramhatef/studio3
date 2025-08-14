
import type { ChartDataPoint } from '@/lib/types';
import { db } from '@/lib/firebase';
import { collection, query, where, orderBy, getDocs, limit } from 'firebase/firestore';
import * as indicators from '@/lib/indicators';
import { doc, setDoc } from 'firebase/firestore';

export type StrategyParams = {
    // Core Trend-Following
    EMA_FAST_PERIOD: number;
    EMA_SLOW_PERIOD: number;
    EMA_LONG_PERIOD: number;
    PARABOLIC_SAR_STEP: number;
    PARABOLIC_SAR_MAX: number;
  
    // Momentum
    RSI_PERIOD: number;
    RSI_OVERSOLD_THRESHOLD: number;
    RSI_OVERBOUGHT_THRESHOLD: number;
  
    // Volatility Filter
    ATR_PERIOD: number;
    ATR_VOLATILITY_THRESHOLD: number;
    
    // Backtesting Simulation
    TAKE_PROFIT_ATR_MULTIPLIER: number;
    STOP_LOSS_ATR_MULTIPLIER: number;
};

export type TradeResult = {
    entryPrice: number;
    exitPrice: number;
    entryTime: number;
    exitTime: number;
    type: 'BUY' | 'SELL';
    profit: number;
    profitPercentage: number;
    entryCandleIndex: number;
    exitCandleIndex: number;
    initialCapital: number;
    finalCapital: number;
    exitReason: 'Opposite Signal' | 'Take Profit' | 'Stop Loss' | 'End of Data';
};

type InTradeState = {
    entryPrice: number;
    entryTime: number;
    type: 'BUY' | 'SELL';
    entryCandleIndex: number;
    initialCapital: number;
    stopLossPrice: number;
    takeProfitPrice: number;
};


export async function loadHistoricalData(collectionPath: string, startTime: number, endTime: number): Promise<ChartDataPoint[]> {
    console.log(`Loading historical data from Firestore collection: ${collectionPath}`);
    try {
        const candlesCollection = collection(db, collectionPath);
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
        throw error;
    }
}

const getValueAt = (arr: (number | null)[], idx: number): number | null => {
    if (idx < 0 || idx >= arr.length) return null;
    return arr[idx] ?? arr.slice(0, idx + 1).reverse().find(v => v !== null) ?? null;
};

const getPrevValueAt = (arr: (number | null)[], idx: number): number | null => {
    if (idx <= 0 || idx >= arr.length) return null;
    return arr[idx - 1] ?? arr.slice(0, idx).reverse().find(v => v !== null) ?? null;
};

export function runBacktest(data: ChartDataPoint[], params: StrategyParams, initialCapital: number = 10000): TradeResult[] {
    const trades: TradeResult[] = [];
    let capital = initialCapital;
    let inTrade: InTradeState | null = null;
    let lastSignalType: 'BUY' | 'SELL' | null = null;
    let lastSignalTime = 0;

    const requiredPeriods = Math.max(
        params.EMA_SLOW_PERIOD, params.RSI_PERIOD, params.ATR_PERIOD, params.EMA_LONG_PERIOD
    );

    if (data.length < requiredPeriods) {
        return trades;
    }

    const closeSlice = data.map(d => d.close);
    const highSlice = data.map(d => d.high);
    const lowSlice = data.map(d => d.low);

    const emaFastArr = indicators.calculateEMA(closeSlice, params.EMA_FAST_PERIOD);
    const emaSlowArr = indicators.calculateEMA(closeSlice, params.EMA_SLOW_PERIOD);
    const emaLongArr = indicators.calculateEMA(closeSlice, params.EMA_LONG_PERIOD);
    const psarArr = indicators.calculateParabolicSAR(data, params.PARABOLIC_SAR_STEP, params.PARABOLIC_SAR_MAX);
    const rsiArr = indicators.calculateRSI(closeSlice, params.RSI_PERIOD);
    const atrArr = indicators.calculateATR(highSlice, lowSlice, closeSlice, params.ATR_PERIOD);

    for (let i = requiredPeriods; i < data.length; i++) {
        const currentCandle = data[i];

        // --- EXIT LOGIC ---
        // Check for exits on every candle if a trade is open
        if (inTrade) {
            let exitPrice: number | null = null;
            let exitReason: TradeResult['exitReason'] | null = null;

            if (inTrade.type === 'BUY') {
                if (currentCandle.low <= inTrade.stopLossPrice) {
                    exitPrice = inTrade.stopLossPrice;
                    exitReason = 'Stop Loss';
                } else if (currentCandle.high >= inTrade.takeProfitPrice) {
                    exitPrice = inTrade.takeProfitPrice;
                    exitReason = 'Take Profit';
                }
            } else { // SELL trade
                if (currentCandle.high >= inTrade.stopLossPrice) {
                    exitPrice = inTrade.stopLossPrice;
                    exitReason = 'Stop Loss';
                } else if (currentCandle.low <= inTrade.takeProfitPrice) {
                    exitPrice = inTrade.takeProfitPrice;
                    exitReason = 'Take Profit';
                }
            }
            
            if (exitPrice !== null && exitReason !== null) {
                const profit = (inTrade.type === 'BUY' ? exitPrice - inTrade.entryPrice : inTrade.entryPrice - exitPrice);
                const profitPercentage = (profit / inTrade.entryPrice) * 100;
                const finalCapital = inTrade.initialCapital + profit;
                
                trades.push({
                    entryPrice: inTrade.entryPrice,
                    entryTime: inTrade.entryTime,
                    type: inTrade.type,
                    entryCandleIndex: inTrade.entryCandleIndex,
                    initialCapital: inTrade.initialCapital,
                    exitPrice,
                    exitTime: currentCandle.time,
                    exitCandleIndex: i,
                    profit,
                    profitPercentage,
                    finalCapital,
                    exitReason
                });
                capital = finalCapital;
                inTrade = null;
            }
        }
        
        // --- ENTRY LOGIC ---
        // If we are not in a trade, check for a new entry signal
        if (!inTrade) {
            const cache = {
                emaFast: getValueAt(emaFastArr, i),
                emaSlow: getValueAt(emaSlowArr, i),
                emaLong: getValueAt(emaLongArr, i),
                pSar: getValueAt(psarArr, i),
                rsi: getValueAt(rsiArr, i),
                atr: getValueAt(atrArr, i),
            };

            if (Object.values(cache).some(v => v === null || Number.isNaN(v))) {
                continue;
            }
            
            const isUptrend = currentCandle.close > (cache.emaLong as number);
            const isDowntrend = currentCandle.close < (cache.emaLong as number);
            
            const recentAtrSlice = atrArr.slice(Math.max(0, i - 10), i).filter(v => v !== null) as number[];
            const avgAtr = recentAtrSlice.length > 0 ? recentAtrSlice.reduce((s, v) => s + v, 0) / recentAtrSlice.length : 0;
            const isVolatileEnough = (cache.atr as number) > (avgAtr * params.ATR_VOLATILITY_THRESHOLD);
            
            let signalType: 'BUY' | 'SELL' | null = null;
            
            if (isVolatileEnough) {
                const emaFastPrev = getPrevValueAt(emaFastArr, i);
                const emaSlowPrev = getPrevValueAt(emaSlowArr, i);
                
                if (isUptrend) {
                    const rsiOk = (cache.rsi as number) > 50 && (cache.rsi as number) < params.RSI_OVERBOUGHT_THRESHOLD;
                    const psarOk = currentCandle.close > (cache.pSar as number);
                    const emaCrossedUp = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev <= emaSlowPrev && (cache.emaFast as number) > (cache.emaSlow as number);
                    const isPullback = currentCandle.low <= (cache.emaFast as number) && currentCandle.close > (cache.emaFast as number);
                    
                    if ((emaCrossedUp || isPullback) && rsiOk && psarOk) {
                        signalType = 'BUY';
                    }
                } else if (isDowntrend) {
                    const rsiOk = (cache.rsi as number) < 50 && (cache.rsi as number) > params.RSI_OVERSOLD_THRESHOLD;
                    const psarOk = currentCandle.close < (cache.pSar as number);
                    const emaCrossedDown = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev >= emaSlowPrev && (cache.emaFast as number) < (cache.emaSlow as number);
                    const isPullback = currentCandle.high >= (cache.emaFast as number) && currentCandle.close < (cache.emaFast as number);
                    
                    if ((emaCrossedDown || isPullback) && rsiOk && psarOk) {
                        signalType = 'SELL';
                    }
                }
            }

            if (signalType) {
                 const timeDeltaMin = Math.abs(currentCandle.time - lastSignalTime) / 60000;
                 let canEnter = false;
     
                 if (lastSignalType === null) {
                     canEnter = true;
                 } else if (lastSignalType === signalType && timeDeltaMin >= 5) {
                     canEnter = true;
                 } else if (lastSignalType !== signalType && timeDeltaMin >= 2) {
                     canEnter = true;
                 }
     
                 if (canEnter) {
                     lastSignalType = signalType;
                     lastSignalTime = currentCandle.time;
                     const atrValue = cache.atr as number;
                     
                     // Close any existing trade if an opposite signal appears
                     if (inTrade && inTrade.type !== signalType) {
                         const exitPrice = currentCandle.close;
                         const profit = (inTrade.type === 'BUY' ? exitPrice - inTrade.entryPrice : inTrade.entryPrice - exitPrice);
                         const profitPercentage = (profit / inTrade.entryPrice) * 100;
                         const finalCapital = inTrade.initialCapital + profit;
                         trades.push({ ...inTrade, exitPrice, exitTime: currentCandle.time, exitCandleIndex: i, profit, profitPercentage, finalCapital, exitReason: 'Opposite Signal' });
                         capital = finalCapital;
                         inTrade = null;
                     }
                     
                     // Enter new trade
                     inTrade = {
                         entryPrice: currentCandle.close,
                         entryTime: currentCandle.time,
                         type: signalType,
                         entryCandleIndex: i,
                         initialCapital: capital,
                         stopLossPrice: signalType === 'BUY' ? currentCandle.close - (atrValue * params.STOP_LOSS_ATR_MULTIPLIER) : currentCandle.close + (atrValue * params.STOP_LOSS_ATR_MULTIPLIER),
                         takeProfitPrice: signalType === 'BUY' ? currentCandle.close + (atrValue * params.TAKE_PROFIT_ATR_MULTIPLIER) : currentCandle.close - (atrValue * params.TAKE_PROFIT_ATR_MULTIPLIER),
                     };
                 }
            }
        }
    }

    if (inTrade) {
        const lastCandle = data[data.length - 1];
        const exitPrice = lastCandle.close;
        const profit = (inTrade.type === 'BUY' ? exitPrice - inTrade.entryPrice : inTrade.entryPrice - exitPrice);
        const profitPercentage = (profit / inTrade.entryPrice) * 100;
        const finalCapital = inTrade.initialCapital + profit;
        trades.push({
            ...inTrade,
            exitPrice,
            exitTime: lastCandle.time,
            exitCandleIndex: data.length - 1,
            profit,
            profitPercentage,
            finalCapital,
            exitReason: 'End of Data'
        });
    }

    return trades;
}

export async function optimizeParameters(data: ChartDataPoint[], paramRanges: { [key: string]: number[] }): Promise<{ bestParams: StrategyParams | null; bestPerformance: PerformanceMetrics | null; bestTrades: TradeResult[] }> {
    console.log('Starting parameter optimization...');
    let bestPerformance: PerformanceMetrics | null = null;
    let bestParams: StrategyParams | null = null;
    let bestTrades: TradeResult[] = [];
    let highestScore = -Infinity;

    const initialCapital = 10000;
    
    const keys = Object.keys(paramRanges);
    const combinations: StrategyParams[] = [];
    
    function generateCombinations(index: number, currentCombination: any) {
        if (index === keys.length) {
            combinations.push(currentCombination);
            return;
        }
        const key = keys[index];
        const values = paramRanges[key as keyof typeof paramRanges];
        for (const value of values) {
            generateCombinations(index + 1, { ...currentCombination, [key]: value });
        }
    }
    
    generateCombinations(0, {});
    
    console.log(`Generated ${combinations.length} parameter combinations to test.`);

    for (const currentParams of combinations) {
        const trades = runBacktest(data, currentParams, initialCapital);
        if (trades.length === 0) continue;

        const performance = calculatePerformanceMetrics(trades, initialCapital);

        // A scoring model that rewards profit and win rate, and penalizes having too few trades.
        const score = performance.totalProfit * (performance.winRate / 100) * Math.log10(performance.numberOfTrades + 1);

        if (score > highestScore) {
            highestScore = score;
            bestPerformance = performance;
            bestParams = currentParams;
            bestTrades = trades;
        }
    }
    
    if (bestPerformance) {
        console.log(`Optimization complete. Best performance found: Profit=${bestPerformance.totalProfit.toFixed(6)}, Win Rate=${bestPerformance.winRate.toFixed(2)}%, Trades=${bestPerformance.numberOfTrades}`);
        console.log('Best Parameters:', bestParams);
    } else {
        console.warn("No valid performance metrics were generated. The backtest might not have produced any trades with the given parameters.");
    }


    return { bestParams, bestPerformance, bestTrades };
}


export type PerformanceMetrics = {
    totalProfit: number;
    totalProfitPercentage: number;
    numberOfTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    lossRate: number;
    averageWin: number;
    averageLoss: number;
};

export function calculatePerformanceMetrics(trades: TradeResult[], initialCapital: number): PerformanceMetrics {
    const numberOfTrades = trades.length;
    if (numberOfTrades === 0) {
        return {
            totalProfit: 0, totalProfitPercentage: 0, numberOfTrades: 0, winningTrades: 0,
            losingTrades: 0, winRate: 0, lossRate: 0, averageWin: 0, averageLoss: 0,
        };
    }
    
    const finalCapital = trades.length > 0 ? trades[trades.length - 1].finalCapital : initialCapital;
    const totalProfit = finalCapital - initialCapital;
    const totalProfitPercentage = (totalProfit / initialCapital) * 100;

    const winningTrades = trades.filter(t => t.profit > 0);
    const losingTrades = trades.filter(t => t.profit <= 0);

    const totalWinAmount = winningTrades.reduce((sum, t) => sum + t.profit, 0);
    const totalLossAmount = losingTrades.reduce((sum, t) => sum + t.profit, 0);


    return {
        totalProfit,
        totalProfitPercentage,
        numberOfTrades,
        winningTrades: winningTrades.length,
        losingTrades: losingTrades.length,
        winRate: (winningTrades.length / numberOfTrades) * 100,
        lossRate: (losingTrades.length / numberOfTrades) * 100,
        averageWin: winningTrades.length > 0 ? totalWinAmount / winningTrades.length : 0,
        averageLoss: losingTrades.length > 0 ? Math.abs(totalLossAmount / losingTrades.length) : 0,
    };
}
