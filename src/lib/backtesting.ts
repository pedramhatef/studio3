
import type { ChartDataPoint, StrategyParams } from '@/lib/types';
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

export function runBacktest(data: ChartDataPoint[], params: StrategyParams, initialCapital: number = 10000): TradeResult[] {
    const trades: TradeResult[] = [];
    let capital = initialCapital;
    let inTrade: InTradeState | null = null;
    
    const requiredPeriods = Math.max(
        params.EMA_SLOW_PERIOD, params.RSI_PERIOD, params.ATR_PERIOD, params.EMA_LONG_PERIOD, params.VOLUME_PERIOD, 26 // MACD slow period
    );

    if (data.length < requiredPeriods) {
        return trades;
    }

    const closeSlice = data.map(d => d.close);
    const volumeSlice = data.map(d => d.volume);

    const emaFastArr = indicators.calculateEMA(closeSlice, params.EMA_FAST_PERIOD);
    const emaSlowArr = indicators.calculateEMA(closeSlice, params.EMA_SLOW_PERIOD);
    const emaLongArr = indicators.calculateEMA(closeSlice, params.EMA_LONG_PERIOD);
    const rsiArr = indicators.calculateRSI(closeSlice, params.RSI_PERIOD);
    const atrArr = indicators.calculateATR(data, params.ATR_PERIOD);
    const avgVolumeArr = indicators.calculateSMA(volumeSlice, params.VOLUME_PERIOD);
    const macd = indicators.calculateMACD(closeSlice, 12, 26, 9);

    for (let i = requiredPeriods; i < data.length; i++) {
        const currentCandle = data[i];
        const atrValue = getValueAt(atrArr, i);

        // --- EXIT LOGIC ---
        if (inTrade) {
            let exitPrice: number | null = null;
            let exitReason: TradeResult['exitReason'] | null = null;
            
            const emaFast = getValueAt(emaFastArr, i);
            const emaSlow = getValueAt(emaSlowArr, i);

            if (inTrade.type === 'BUY') {
                if (currentCandle.low <= inTrade.stopLossPrice) {
                    exitPrice = inTrade.stopLossPrice;
                    exitReason = 'Stop Loss';
                } else if (currentCandle.high >= inTrade.takeProfitPrice) {
                    exitPrice = inTrade.takeProfitPrice;
                    exitReason = 'Take Profit';
                } else if(emaFast !== null && emaSlow !== null && emaFast < emaSlow) {
                    exitPrice = currentCandle.close;
                    exitReason = 'Opposite Signal';
                }
            } else { // SELL trade
                if (currentCandle.high >= inTrade.stopLossPrice) {
                    exitPrice = inTrade.stopLossPrice;
                    exitReason = 'Stop Loss';
                } else if (currentCandle.low <= inTrade.takeProfitPrice) {
                    exitPrice = inTrade.takeProfitPrice;
                    exitReason = 'Take Profit';
                } else if(emaFast !== null && emaSlow !== null && emaFast > emaSlow) {
                    exitPrice = currentCandle.close;
                    exitReason = 'Opposite Signal';
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
                rsi: getValueAt(rsiArr, i),
                avgVolume: getValueAt(avgVolumeArr, i),
                macdHistogram: getValueAt(macd.histogram, i),
            };
    
            if (Object.values(cache).some(v => v === null || Number.isNaN(v)) || atrValue === null) {
                continue;
            }
            
            let signalType: 'BUY' | 'SELL' | null = null;
            
            const emaFastPrev = getPrevValueAt(emaFastArr, i);
            const emaSlowPrev = getPrevValueAt(emaSlowArr, i);
            const volumeOk = currentCandle.volume > (cache.avgVolume as number) * params.VOLUME_THRESHOLD_MULTIPLIER;
            const macdConfirmBuy = (cache.macdHistogram as number) > 0;
            const macdConfirmSell = (cache.macdHistogram as number) < 0;
            
            const emaCrossedUp = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev <= emaSlowPrev && (cache.emaFast as number) > (cache.emaSlow as number);
            const emaCrossedDown = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev >= emaSlowPrev && (cache.emaFast as number) < (cache.emaSlow as number);

            if (emaCrossedUp && (cache.rsi as number) < params.RSI_OVERBOUGHT_THRESHOLD && volumeOk && macdConfirmBuy) {
                signalType = 'BUY';
            }
            
            const isPullbackBuy = currentCandle.low <= (cache.emaSlow as number) && currentCandle.close > (cache.emaSlow as number);
            const rsiPullbackOkBuy = (cache.rsi as number) > 40 && (cache.rsi as number) < params.RSI_OVERBOUGHT_THRESHOLD;
            if (!signalType && isPullbackBuy && rsiPullbackOkBuy && (cache.emaFast as number) > (cache.emaLong as number)) {
                signalType = 'BUY';
            }
            
            if (emaCrossedDown && (cache.rsi as number) > params.RSI_OVERSOLD_THRESHOLD && volumeOk && macdConfirmSell) {
                signalType = 'SELL';
            }

            const isPullbackSell = currentCandle.high >= (cache.emaSlow as number) && currentCandle.close < (cache.emaSlow as number);
            const rsiPullbackOkSell = (cache.rsi as number) < 60 && (cache.rsi as number) > params.RSI_OVERSOLD_THRESHOLD;
            if (!signalType && isPullbackSell && rsiPullbackOkSell && (cache.emaFast as number) < (cache.emaLong as number)) {
                signalType = 'SELL';
            }
            
            if (signalType) {
                const entryPrice = applySpread(currentCandle.close, signalType, params.SPREAD_PERCENT);
                inTrade = {
                    entryPrice: entryPrice,
                    entryTime: currentCandle.time,
                    type: signalType,
                    entryCandleIndex: i,
                    initialCapital: capital,
                    stopLossPrice: signalType === 'BUY' ? entryPrice - (atrValue * params.STOP_LOSS_ATR_MULTIPLIER) : entryPrice + (atrValue * params.STOP_LOSS_ATR_MULTIPLIER),
                    takeProfitPrice: signalType === 'BUY' ? entryPrice + (atrValue * params.TAKE_PROFIT_ATR_MULTIPLIER) : entryPrice - (atrValue * params.TAKE_PROFIT_ATR_MULTIPLIER),
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

export function calculatePerformanceMetrics(trades: TradeResult[], initialCapital: number): PerformanceMetrics {
    const numberOfTrades = trades.length;
    if (numberOfTrades === 0) { 
        return {
            totalProfit: 0, totalProfitPercentage: 0, numberOfTrades: 0, winningTrades: 0,
            losingTrades: 0, winRate: 0, lossRate: 0, averageWin: 0, averageLoss: 0,
            profitFactor: 0, sharpeRatio: 0
        };
    }
    
    const finalCapital = trades.length > 0 ? trades[trades.length - 1].finalCapital : initialCapital;
    const totalProfit = finalCapital - initialCapital;
    const totalProfitPercentage = (totalProfit / initialCapital) * 100;

    const winningTrades = trades.filter(t => t.profit > 0);
    const losingTrades = trades.filter(t => t.profit <= 0);

    const totalWinAmount = winningTrades.reduce((sum, t) => sum + t.profit, 0);
    const totalLossAmount = Math.abs(losingTrades.reduce((sum, t) => sum + t.profit, 0));
    
    const returns = trades.map(t => t.profitPercentage / 100);
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / numberOfTrades;
    const stdDev = numberOfTrades > 1 ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (numberOfTrades - 1)) : 0;
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(numberOfTrades) : 0; 

    return {
        totalProfit,
        totalProfitPercentage,
        numberOfTrades,
        winningTrades: winningTrades.length,
        losingTrades: losingTrades.length,
        winRate: numberOfTrades > 0 ? (winningTrades.length / numberOfTrades) * 100 : 0,
        lossRate: numberOfTrades > 0 ? (losingTrades.length / numberOfTrades) * 100 : 0,
        averageWin: winningTrades.length > 0 ? totalWinAmount / winningTrades.length : 0,
        averageLoss: losingTrades.length > 0 ? totalLossAmount / losingTrades.length : 0,
        profitFactor: totalLossAmount > 0 ? totalWinAmount / totalLossAmount : Infinity,
        sharpeRatio,
    };
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
        if (trades.length < 2) continue; 

        const performance = calculatePerformanceMetrics(trades, initialCapital);
        
        // Robust scoring function
        const sharpe = isFinite(performance.sharpeRatio) ? performance.sharpeRatio : 0;
        const profitFactor = isFinite(performance.profitFactor) ? performance.profitFactor : 0;
        const winRate = isFinite(performance.winRate) ? performance.winRate : 0;
        
        const score = (sharpe * 0.5) + (profitFactor * 0.2) + (winRate * 0.2) + (Math.log10(performance.numberOfTrades + 1) * 0.1);

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
