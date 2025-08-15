

'use server';

import type { ChartDataPoint, Signal, StrategyParams } from '@/lib/types';
import * as indicators from '@/lib/indicators';

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

const getValueAt = (arr: (number | null)[], idx: number): number | null => {
    if (idx < 0 || idx >= arr.length) return null;
    return arr[idx] ?? arr.slice(0, idx + 1).reverse().find(v => v !== null) ?? null;
};

const getPrevValueAt = (arr: (number | null)[], idx: number): number | null => {
    if (idx <= 0 || idx >= arr.length) return null;
    return arr[idx - 1] ?? arr.slice(0, idx).reverse().find(v => v !== null) ?? null;
};

const applySpread = (price: number, type: 'BUY' | 'SELL', spreadPercent: number): number => {
    const spread = price * (spreadPercent / 100);
    return type === 'BUY' ? price + spread : price - spread;
};
    
export async function runBacktest(data: ChartDataPoint[], params: StrategyParams, initialCapital: number = 10000): Promise<TradeResult[]> {
    const trades: TradeResult[] = [];
    let capital = initialCapital;
    let inTrade: InTradeState | null = null;
    
    const requiredPeriods = Math.max(
        params.EMA_SLOW_PERIOD, params.RSI_PERIOD, params.ATR_PERIOD, params.EMA_LONG_PERIOD, params.VOLUME_PERIOD, 26
    );

    if (data.length < requiredPeriods) {
        return trades;
    }

    const closeSlice = data.map(d => d.close);

    const emaFastArr = indicators.calculateEMA(closeSlice, params.EMA_FAST_PERIOD);
    const emaSlowArr = indicators.calculateEMA(closeSlice, params.EMA_SLOW_PERIOD);
    const emaLongArr = indicators.calculateEMA(closeSlice, params.EMA_LONG_PERIOD);
    const psarArr = indicators.calculateParabolicSAR(data, params.PARABOLIC_SAR_STEP, params.PARABOLIC_SAR_MAX);
    const rsiArr = indicators.calculateRSI(closeSlice, params.RSI_PERIOD);
    const atrArr = indicators.calculateATR(data, params.ATR_PERIOD);

    for (let i = requiredPeriods; i < data.length; i++) {
        const currentCandle = data[i];
        const atrValue = getValueAt(atrArr, i);

        // --- EXIT LOGIC ---
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
                const effectiveExitPrice = applySpread(exitPrice, inTrade.type === 'BUY' ? 'SELL' : 'BUY', params.SPREAD_PERCENT);
                const profit = (inTrade.type === 'BUY' ? effectiveExitPrice - inTrade.entryPrice : inTrade.entryPrice - effectiveExitPrice);
                const profitPercentage = (profit / inTrade.entryPrice) * 100;
                const finalCapital = inTrade.initialCapital + profit;
                
                trades.push({
                    entryPrice: inTrade.entryPrice,
                    entryTime: inTrade.entryTime,
                    type: inTrade.type,
                    entryCandleIndex: inTrade.entryCandleIndex,
                    initialCapital: inTrade.initialCapital,
                    exitPrice: effectiveExitPrice,
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
        if (!inTrade) {
            const cache = {
                emaFast: getValueAt(emaFastArr, i),
                emaSlow: getValueAt(emaSlowArr, i),
                emaLong: getValueAt(emaLongArr, i),
                pSar: getValueAt(psarArr, i),
                rsi: getValueAt(rsiArr, i),
            };
    
            if (Object.values(cache).some(v => v === null || Number.isNaN(v)) || atrValue === null) {
                continue;
            }
            
            let signal: Omit<Signal, 'displayTime' | 'serverTime'> | null = null;
            const emaFastPrev = getPrevValueAt(emaFastArr, i);
            const emaSlowPrev = getPrevValueAt(emaSlowArr, i);
            
            const isUptrend = currentCandle.close > (cache.emaLong as number);
            const isDowntrend = currentCandle.close < (cache.emaLong as number);

            // BUY Logic
            const emaCrossedUp = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev <= emaSlowPrev && (cache.emaFast as number) > (cache.emaSlow as number);
            const rsiInRangeBuy = (cache.rsi as number) < params.RSI_OVERBOUGHT_THRESHOLD;
            const psarConfirmBuy = currentCandle.close > (cache.pSar as number);

            if (emaCrossedUp && rsiInRangeBuy && psarConfirmBuy && isUptrend) {
                signal = { type: 'BUY', level: 'High', price: currentCandle.close, time: currentCandle.time };
            }

            const isPullbackBuy = currentCandle.low <= (cache.emaFast as number) && currentCandle.close > (cache.emaFast as number);
            const rsiPullbackOkBuy = (cache.rsi as number) > 40 && rsiInRangeBuy;
            if (!signal && isPullbackBuy && rsiPullbackOkBuy && psarConfirmBuy && isUptrend) {
                signal = { type: 'BUY', level: 'Medium', price: currentCandle.close, time: currentCandle.time };
            }

            // SELL Logic
            const emaCrossedDown = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev >= emaSlowPrev && (cache.emaFast as number) < (cache.emaSlow as number);
            const rsiInRangeSell = (cache.rsi as number) > params.RSI_OVERSOLD_THRESHOLD;
            const psarConfirmSell = currentCandle.close < (cache.pSar as number);

            if (!signal && emaCrossedDown && rsiInRangeSell && psarConfirmSell && isDowntrend) {
                signal = { type: 'SELL', level: 'High', price: currentCandle.close, time: currentCandle.time };
            }

            const isPullbackSell = currentCandle.high >= (cache.emaFast as number) && currentCandle.close < (cache.emaFast as number);
            const rsiPullbackOkSell = (cache.rsi as number) < 60 && rsiInRangeSell;
            if (!signal && isPullbackSell && rsiPullbackOkSell && psarConfirmSell && isDowntrend) {
                signal = { type: 'SELL', level: 'Medium', price: currentCandle.close, time: currentCandle.time };
            }
            
            if (signal) {
                const entryPrice = applySpread(currentCandle.close, signal.type, params.SPREAD_PERCENT);
                inTrade = {
                    entryPrice: entryPrice,
                    entryTime: currentCandle.time,
                    type: signal.type,
                    entryCandleIndex: i,
                    initialCapital: capital,
                    stopLossPrice: signal.type === 'BUY' ? entryPrice - (atrValue * params.STOP_LOSS_ATR_MULTIPLIER) : entryPrice + (atrValue * params.STOP_LOSS_ATR_MULTIPLIER),
                    takeProfitPrice: signal.type === 'BUY' ? entryPrice + (atrValue * params.TAKE_PROFIT_ATR_MULTIPLIER) : entryPrice - (atrValue * params.TAKE_PROFIT_ATR_MULTIPLIER),
                };
            }
        }
    }

    if (inTrade) {
        const lastCandle = data[data.length - 1];
        const exitPrice = lastCandle.close;
        const effectiveExitPrice = applySpread(exitPrice, inTrade.type === 'BUY' ? 'SELL' : 'BUY', params.SPREAD_PERCENT);
        const profit = (inTrade.type === 'BUY' ? effectiveExitPrice - inTrade.entryPrice : inTrade.entryPrice - effectiveExitPrice);
        const profitPercentage = (profit / inTrade.entryPrice) * 100;
        const finalCapital = inTrade.initialCapital + profit;
        trades.push({
            ...inTrade,
            exitPrice: effectiveExitPrice,
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
    profitFactor: number;
    sharpeRatio: number;
};

export async function calculatePerformanceMetrics(trades: TradeResult[], initialCapital: number): Promise<PerformanceMetrics> {
    const numberOfTrades = trades.length;
    if (numberOfTrades < 2) { 
        return {
            totalProfit: 0, totalProfitPercentage: 0, numberOfTrades: 0, winningTrades: 0,
            losingTrades: 0, winRate: 0, lossRate: 0, averageWin: 0, averageLoss: 0,
            profitFactor: 0, sharpeRatio: 0
        };
    }
    
    const finalCapital = trades[trades.length - 1].finalCapital;
    const totalProfit = finalCapital - initialCapital;
    const totalProfitPercentage = (totalProfit / initialCapital) * 100;

    const winningTrades = trades.filter(t => t.profit > 0);
    const losingTrades = trades.filter(t => t.profit <= 0);

    const totalWinAmount = winningTrades.reduce((sum, t) => sum + t.profit, 0);
    const totalLossAmount = Math.abs(losingTrades.reduce((sum, t) => sum + t.profit, 0));
    
    const returns = trades.map(t => t.profitPercentage / 100);
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / numberOfTrades;
    const stdDev = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (numberOfTrades - 1));
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(numberOfTrades) : 0; 

    return {
        totalProfit,
        totalProfitPercentage,
        numberOfTrades,
        winningTrades: winningTrades.length,
        losingTrades: losingTrades.length,
        winRate: (winningTrades.length / numberOfTrades) * 100,
        lossRate: (losingTrades.length / numberOfTrades) * 100,
        averageWin: winningTrades.length > 0 ? totalWinAmount / winningTrades.length : 0,
        averageLoss: losingTrades.length > 0 ? totalLossAmount / losingTrades.length : 0,
        profitFactor: totalLossAmount > 0 ? totalWinAmount / totalLossAmount : Infinity,
        sharpeRatio: isNaN(sharpeRatio) ? 0 : sharpeRatio,
    };
}

export async function optimizeParameters(data: ChartDataPoint[], paramRanges: { [key in keyof Partial<StrategyParams>]?: number[] }): Promise<{ bestParams: StrategyParams | null; bestPerformance: PerformanceMetrics | null; bestTrades: TradeResult[] }> {
    console.log('Starting parameter optimization...');
    let bestPerformance: PerformanceMetrics | null = null;
    let bestParams: StrategyParams | null = null;
    let bestTrades: TradeResult[] = [];
    let highestScore = -Infinity;

    const initialCapital = 10000;
    
    const keys = Object.keys(paramRanges) as (keyof typeof paramRanges)[];
    const combinations: StrategyParams[] = [];
    
    const defaultFullParams: StrategyParams = {
        EMA_FAST_PERIOD: 10,
        EMA_SLOW_PERIOD: 20,
        EMA_LONG_PERIOD: 50,
        PARABOLIC_SAR_STEP: 0.02,
        PARABOLIC_SAR_MAX: 0.2,
        RSI_PERIOD: 14,
        RSI_OVERSOLD_THRESHOLD: 30,
        RSI_OVERBOUGHT_THRESHOLD: 70,
        RSI_BREAKOUT_THRESHOLD: 55,
        RSI_BREAKDOWN_THRESHOLD: 45,
        ATR_PERIOD: 14,
        ATR_VOLATILITY_THRESHOLD: 1,
        VOLUME_PERIOD: 20,
        VOLUME_THRESHOLD_MULTIPLIER: 2,
        TAKE_PROFIT_ATR_MULTIPLIER: 3,
        STOP_LOSS_ATR_MULTIPLIER: 1.5,
        SPREAD_PERCENT: 0.01,
    };

    function generateCombinations(index: number, currentCombination: Partial<StrategyParams>) {
        if (index === keys.length) {
            combinations.push({ ...defaultFullParams, ...currentCombination });
            return;
        }
        const key = keys[index];
        const values = paramRanges[key]!;
        for (const value of values) {
            generateCombinations(index + 1, { ...currentCombination, [key]: value });
        }
    }
    
    generateCombinations(0, {});
    
    console.log(`Generated ${combinations.length} parameter combinations to test.`);

    for (const currentParams of combinations) {
        const trades = await runBacktest(data, currentParams, initialCapital);

        if (trades.length < 2) continue;

        const performance = await calculatePerformanceMetrics(trades, initialCapital);
        
        const pf = isFinite(performance.profitFactor) ? performance.profitFactor : 0;
        const sr = isFinite(performance.sharpeRatio) ? performance.sharpeRatio : 0;
        
        const score = (performance.totalProfit * 1000) + (performance.winRate * 0.5) + (pf * 0.3) + (sr * 0.2);


        if (score > highestScore) {
            highestScore = score;
            bestPerformance = performance;
            bestParams = currentParams;
            bestTrades = trades;
        }
    }
    
    if (bestPerformance && bestParams) {
        console.log(`Optimization complete. Best performance found: Sharpe=${bestPerformance.sharpeRatio.toFixed(2)}, Profit=${bestPerformance.totalProfit.toFixed(6)}, Win Rate=${bestPerformance.winRate.toFixed(2)}%, Trades=${bestPerformance.numberOfTrades}`);
        console.log('Best Parameters:', bestParams);
    } else {
        console.warn("No valid performance metrics were generated. The backtest might not have produced any trades with the given parameters.");
    }

    return { bestParams, bestPerformance, bestTrades };
}
