
import type { ChartDataPoint } from '@/lib/types';
import { db } from '@/lib/firebase';
import { collection, query, where, orderBy, getDocs, limit } from 'firebase/firestore';
import * as indicators from '@/lib/indicators';
import { doc, setDoc } from 'firebase/firestore';

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
    // New parameters for improved backtesting
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
    system: 'Core Trend-Following' | 'Momentum-Reversal-Deep' | 'Momentum-Reversal-Moderate' | 'Momentum-Shift';
    finalCapital: number;
    exitReason: 'Opposite Signal' | 'Take Profit' | 'Stop Loss' | 'End of Data';
};

type InTradeState = {
    entryPrice: number;
    entryTime: number;
    type: 'BUY' | 'SELL';
    entryCandleIndex: number;
    initialCapital: number;
    system: TradeResult['system'];
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

    const requiredPeriods = Math.max(
        params.EMA_SLOW_PERIOD, params.BBANDS_PERIOD, params.RSI_PERIOD, params.ATR_PERIOD, params.EMA_LONG_PERIOD
    );

    if (data.length < requiredPeriods) {
        return trades;
    }

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

    for (let i = requiredPeriods - 1; i < data.length; i++) {
        const currentCandle = data[i];

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

        if (Object.values(cache).some(v => v === null || Number.isNaN(v))) {
            continue;
        }

        let system: TradeResult['system'] | null = null;
        let signalType: 'BUY' | 'SELL' | null = null;
        
        const isUptrend = currentCandle.close > (cache.emaLong as number);
        const isDowntrend = currentCandle.close < (cache.emaLong as number);
        
        const emaFastPrev = getPrevValueAt(emaFastArr, i);
        const emaSlowPrev = getPrevValueAt(emaSlowArr, i);
        const emaFastCrossedSlowUp = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev <= emaSlowPrev && (cache.emaFast as number) > (cache.emaSlow as number);
        const emaFastCrossedSlowDown = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev >= emaSlowPrev && (cache.emaFast as number) < (cache.emaSlow as number);

        const psarBuffer = (cache.atr as number) * params.PSAR_BUFFER_FACTOR;
        const coreBuyTrue = ((cache.emaFast as number) > (cache.emaSlow as number)) && emaFastCrossedSlowUp && (currentCandle.close > (cache.pSar as number) + psarBuffer) && isUptrend && ((cache.rsi as number) < params.RSI_BUY_MAX);
        const coreSellTrue = ((cache.emaFast as number) < (cache.emaSlow as number)) && emaFastCrossedSlowDown && (currentCandle.close < (cache.pSar as number) - psarBuffer) && isDowntrend && ((cache.rsi as number) > params.RSI_SELL_MIN);

        if (coreBuyTrue) {
            signalType = 'BUY';
            system = 'Core Trend-Following';
        } else if (coreSellTrue) {
            signalType = 'SELL';
            system = 'Core Trend-Following';
        }

        if (inTrade) {
            let exitPrice: number | null = null;
            let exitReason: TradeResult['exitReason'] | null = null;

            // Trailing Stop Loss Logic
            if (inTrade.type === 'BUY') {
                inTrade.stopLossPrice = Math.max(inTrade.stopLossPrice, currentCandle.close - (cache.atr as number) * params.STOP_LOSS_ATR_MULTIPLIER);
            } else { // SELL
                inTrade.stopLossPrice = Math.min(inTrade.stopLossPrice, currentCandle.close + (cache.atr as number) * params.STOP_LOSS_ATR_MULTIPLIER);
            }

            // Check for exit conditions
            if (inTrade.type === 'BUY') {
                if (currentCandle.low <= inTrade.stopLossPrice) {
                    exitPrice = inTrade.stopLossPrice;
                    exitReason = 'Stop Loss';
                } else if (currentCandle.high >= inTrade.takeProfitPrice) {
                    exitPrice = inTrade.takeProfitPrice;
                    exitReason = 'Take Profit';
                } else if (signalType === 'SELL') {
                    exitPrice = currentCandle.close;
                    exitReason = 'Opposite Signal';
                }
            } else { // SELL
                if (currentCandle.high >= inTrade.stopLossPrice) {
                    exitPrice = inTrade.stopLossPrice;
                    exitReason = 'Stop Loss';
                } else if (currentCandle.low <= inTrade.takeProfitPrice) {
                    exitPrice = inTrade.takeProfitPrice;
                    exitReason = 'Take Profit';
                } else if (signalType === 'BUY') {
                    exitPrice = currentCandle.close;
                    exitReason = 'Opposite Signal';
                }
            }
            
            if (exitPrice !== null && exitReason !== null) {
                const profit = (inTrade.type === 'BUY' ? exitPrice - inTrade.entryPrice : inTrade.entryPrice - exitPrice);
                const profitPercentage = (profit / inTrade.entryPrice) * 100;
                const finalCapital = capital * (1 + profitPercentage / 100);
                
                trades.push({
                    entryPrice: inTrade.entryPrice,
                    entryTime: inTrade.entryTime,
                    type: inTrade.type,
                    entryCandleIndex: inTrade.entryCandleIndex,
                    initialCapital: inTrade.initialCapital,
                    system: inTrade.system,
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

        if (!inTrade && signalType && system) {
            const atrValue = cache.atr as number;
            const takeProfitPrice = signalType === 'BUY' 
                ? currentCandle.close + atrValue * params.TAKE_PROFIT_ATR_MULTIPLIER
                : currentCandle.close - atrValue * params.TAKE_PROFIT_ATR_MULTIPLIER;
            const stopLossPrice = signalType === 'BUY' 
                ? currentCandle.close - atrValue * params.STOP_LOSS_ATR_MULTIPLIER
                : currentCandle.close + atrValue * params.STOP_LOSS_ATR_MULTIPLIER;
            
            inTrade = {
                entryPrice: currentCandle.close,
                entryTime: currentCandle.time,
                type: signalType,
                entryCandleIndex: i,
                initialCapital: capital,
                system: system,
                stopLossPrice: stopLossPrice,
                takeProfitPrice: takeProfitPrice
            };
        }
    }

    if (inTrade) {
        const lastCandle = data[data.length - 1];
        const exitPrice = lastCandle.close;
        const profit = (inTrade.type === 'BUY' ? exitPrice - inTrade.entryPrice : inTrade.entryPrice - exitPrice);
        const profitPercentage = (profit / inTrade.entryPrice) * 100;
        const finalCapital = capital * (1 + profitPercentage / 100);
        trades.push({
            entryPrice: inTrade.entryPrice,
            entryTime: inTrade.entryTime,
            type: inTrade.type,
            entryCandleIndex: inTrade.entryCandleIndex,
            initialCapital: inTrade.initialCapital,
            system: inTrade.system,
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

// A simpler, iterative approach for parameter optimization
export async function optimizeParameters(data: ChartDataPoint[], paramRanges: { [key: string]: number[] }): Promise<{ bestParams: StrategyParams | null; bestPerformance: PerformanceMetrics }> {
    console.log('Starting parameter optimization with iterative approach.');
    let bestPerformance: PerformanceMetrics | null = null;
    let bestParams: StrategyParams | null = null;
    let highestScore = -Infinity;

    const initialCapital = 10000;
    
    // This is a simplified grid search. For a large number of parameters, this can be very slow.
    // We are deliberately keeping the number of options in route.ts low.
    const keys = Object.keys(paramRanges);
    const combinations: any[] = [];
    const buildCombinations = (index: number, current: any) => {
        if (index === keys.length) {
            combinations.push(current);
            return;
        }
        const key = keys[index];
        const values = paramRanges[key as keyof typeof paramRanges];
        for (const value of values) {
            buildCombinations(index + 1, { ...current, [key]: value });
        }
    };
    buildCombinations(0, {});
    
    console.log(`Generated ${combinations.length} parameter combinations to test.`);

    for (const params of combinations) {
        const fullParams = { ...params, initialCapital } as StrategyParams;
        const trades = runBacktest(data, fullParams, initialCapital);
        if (trades.length === 0) continue;

        const performance = calculatePerformanceMetrics(trades, initialCapital);

        // Scoring: Higher profit and more trades is better. Penalize low trade count.
        const score = performance.totalProfit * Math.log(performance.numberOfTrades + 1);

        if (score > highestScore) {
            highestScore = score;
            bestPerformance = performance;
            bestParams = fullParams;
            console.log(`New best performance found. Score: ${score.toFixed(2)}, Profit: ${performance.totalProfit.toFixed(2)}, Trades: ${performance.numberOfTrades}`);
        }
    }

    if (!bestPerformance) {
        throw new Error("No valid performance metrics were generated. The backtest might not have produced any trades with the given parameters.");
    }

    return { bestParams, bestPerformance };
}


export type PerformanceMetrics = {
    totalProfit: number;
    totalProfitPercentage: number;
    systemPerformance: Record<string, {
        trades: number;
        wins: number;
        winRate: number;
        totalProfitLoss?: number;
    }>;
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
            systemPerformance: {}
        };
    }
    
    const finalCapital = trades.length > 0 ? trades[trades.length - 1].finalCapital : initialCapital;
    const totalProfit = finalCapital - initialCapital;
    const totalProfitPercentage = (totalProfit / initialCapital) * 100;

    const winningTrades = trades.filter(t => t.profit > 0);
    const losingTrades = trades.filter(t => t.profit <= 0);

    const totalWinAmount = winningTrades.reduce((sum, t) => sum + t.profit, 0);
    const totalLossAmount = losingTrades.reduce((sum, t) => sum + t.profit, 0);

    const systemPerformance: PerformanceMetrics['systemPerformance'] = {};
    const systems = [...new Set(trades.map(t => t.system))];

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
        totalProfitPercentage,
        numberOfTrades,
        winningTrades: winningTrades.length,
        losingTrades: losingTrades.length,
        winRate: (winningTrades.length / numberOfTrades) * 100,
        lossRate: (losingTrades.length / numberOfTrades) * 100,
        averageWin: winningTrades.length > 0 ? totalWinAmount / winningTrades.length : 0,
        averageLoss: losingTrades.length > 0 ? Math.abs(totalLossAmount / losingTrades.length) : 0,
        systemPerformance,
    };
}
