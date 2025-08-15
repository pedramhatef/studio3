

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
    maxDrawdown: number;
    expectancy: number;
};


const getValueAt = (arr: (number | null)[], idx: number): number | null => {
    if (idx < 0 || idx >= arr.length) return null;
    const value = arr[idx];
    return value === null || typeof value === 'undefined' || isNaN(value) ? null : value;
};

const getPrevValueAt = (arr: (number | null)[], idx: number): number | null => {
    return getValueAt(arr, idx - 1);
};

const applySpread = (price: number, type: 'BUY' | 'SELL', spreadPercent: number) => {
    const spread = price * (spreadPercent / 100);
    return type === 'BUY' ? price + spread : price - spread;
};

export async function runBacktest(dogeData: ChartDataPoint[], params: StrategyParams, initialCapital: number = 10000): Promise<TradeResult[]> {
    const trades: TradeResult[] = [];
    let capital = initialCapital;
    let inTrade: InTradeState | null = null;
    
    const requiredPeriods = Math.max(
        params.EMA_SLOW_PERIOD, params.RSI_PERIOD, params.ATR_PERIOD, params.EMA_LONG_PERIOD, params.VOLUME_PERIOD, 26
    ) + 1;

    if (dogeData.length < requiredPeriods) {
        return trades;
    }

    const dogeClose = dogeData.map(d => d.close);
    const emaFastArr = indicators.calculateEMA(dogeClose, params.EMA_FAST_PERIOD);
    const emaSlowArr = indicators.calculateEMA(dogeClose, params.EMA_SLOW_PERIOD);
    const rsiArr = indicators.calculateRSI(dogeClose, params.RSI_PERIOD);
    const atrArr = indicators.calculateATR(dogeData, params.ATR_PERIOD);
    
    const allIndicatorArrays = [emaFastArr, emaSlowArr, rsiArr, atrArr];
    if (allIndicatorArrays.some(arr => arr.length === 0)) {
        console.warn("Indicator calculation resulted in an empty array. Skipping backtest for this parameter set due to insufficient data for the lookback period.");
        return [];
    }


    for (let i = requiredPeriods; i < dogeData.length; i++) {
        const currentCandle = dogeData[i]; 
        const prevCandle = dogeData[i-1]; 
        
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
            } else { 
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
        
        if (!inTrade) {
             const cache = {
                emaFast: getValueAt(emaFastArr, i - 1),
                emaSlow: getValueAt(emaSlowArr, i - 1),
                rsi: getValueAt(rsiArr, i - 1),
                atr: getValueAt(atrArr, i - 1)
            };
    
            if (Object.values(cache).some(v => v === null)) {
                continue;
            }
            
            let signalType: Signal['type'] | null = null;

            const emaFastPrev = getPrevValueAt(emaFastArr, i - 1);
            const emaSlowPrev = getPrevValueAt(emaSlowArr, i - 1);

            // High-Confidence Crossover Logic
            const emaCrossedUp = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev <= emaSlowPrev && (cache.emaFast as number) > (cache.emaSlow as number);
            const rsiInRangeBuy = (cache.rsi as number) < params.RSI_OVERBOUGHT_THRESHOLD;

            if (emaCrossedUp && rsiInRangeBuy) {
                signalType = 'BUY';
            }

            const emaCrossedDown = emaFastPrev !== null && emaSlowPrev !== null && emaFastPrev >= emaSlowPrev && (cache.emaFast as number) < (cache.emaSlow as number);
            const rsiInRangeSell = (cache.rsi as number) > params.RSI_OVERSOLD_THRESHOLD;
            
            if (!signalType && emaCrossedDown && rsiInRangeSell) {
                signalType = 'SELL';
            }
            
            if (signalType) {
                const atrValue = cache.atr;
                if (atrValue === null) continue;

                const entryPrice = applySpread(currentCandle.open, signalType, params.SPREAD_PERCENT);

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
        const lastCandle = dogeData[dogeData.length - 1];
        const exitPrice = lastCandle.close;
        const effectiveExitPrice = applySpread(exitPrice, inTrade.type === 'BUY' ? 'SELL' : 'BUY', params.SPREAD_PERCENT);
        const profit = (inTrade.type === 'BUY' ? effectiveExitPrice - inTrade.entryPrice : inTrade.entryPrice - effectiveExitPrice);
        const profitPercentage = (profit / inTrade.entryPrice) * 100;
        const finalCapital = inTrade.initialCapital + profit;
        trades.push({
            ...inTrade,
            exitPrice: effectiveExitPrice,
            exitTime: lastCandle.time,
            exitCandleIndex: dogeData.length - 1,
            profit,
            profitPercentage,
            finalCapital,
            exitReason: 'End of Data'
        });
    }

    return trades;
}


export async function calculatePerformanceMetrics(trades: TradeResult[], initialCapital: number): Promise<PerformanceMetrics> {
    const numberOfTrades = trades.length;
    
    const finalCapital = trades.length > 0 ? trades[trades.length - 1].finalCapital : initialCapital;
    const totalProfit = finalCapital - initialCapital;
    const totalProfitPercentage = (totalProfit / initialCapital) * 100;

    const winningTrades = trades.filter(t => t.profit > 0);
    const losingTrades = trades.filter(t => t.profit <= 0);

    const totalWinAmount = winningTrades.reduce((sum, t) => sum + t.profit, 0);
    const totalLossAmount = Math.abs(losingTrades.reduce((sum, t) => sum + t.profit, 0));
    
    const winRate = numberOfTrades > 0 ? (winningTrades.length / numberOfTrades) * 100 : 0;
    const lossRate = numberOfTrades > 0 ? (losingTrades.length / numberOfTrades) * 100 : 0;
    
    const averageWin = winningTrades.length > 0 ? totalWinAmount / winningTrades.length : 0;
    const averageLoss = losingTrades.length > 0 ? totalLossAmount / losingTrades.length : 0;
    
    const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : Infinity;

    const returns = trades.map(t => t.profitPercentage / 100);
    const avgReturn = numberOfTrades > 0 ? returns.reduce((sum, r) => sum + r, 0) / numberOfTrades : 0;
    const stdDev = numberOfTrades > 1 ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (numberOfTrades - 1)) : 0;
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(numberOfTrades) : 0; 

    let peak = initialCapital;
    let maxDrawdown = 0;
    trades.forEach(trade => {
        peak = Math.max(peak, trade.finalCapital);
        const drawdown = peak > 0 ? (peak - trade.finalCapital) / peak : 0;
        maxDrawdown = Math.max(maxDrawdown, drawdown);
    });

    const winExpectancy = averageWin / initialCapital;
    const lossExpectancy = averageLoss / initialCapital;
    const expectancy = (winRate / 100) * winExpectancy - (lossRate / 100) * lossExpectancy;


    if (numberOfTrades < 2) { 
        return {
            totalProfit, totalProfitPercentage, numberOfTrades, winningTrades: winningTrades.length,
            losingTrades: losingTrades.length, winRate, lossRate, averageWin, averageLoss,
            profitFactor, sharpeRatio: 0, maxDrawdown, expectancy: 0
        };
    }

    return {
        totalProfit,
        totalProfitPercentage,
        numberOfTrades,
        winningTrades: winningTrades.length,
        losingTrades: losingTrades.length,
        winRate,
        lossRate,
        averageWin,
        averageLoss,
        profitFactor: isNaN(profitFactor) || !isFinite(profitFactor) ? 0 : profitFactor,
        sharpeRatio: isNaN(sharpeRatio) ? 0 : sharpeRatio,
        maxDrawdown: maxDrawdown * 100, 
        expectancy: expectancy * 100, 
    };
}


const POPULATION_SIZE = 50;
const GENERATIONS = 20;
const MUTATION_RATE = 0.2;
const ELITISM_RATE = 0.1;

function createIndividual(paramRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]: number[] }): Omit<StrategyParams, 'SPREAD_PERCENT'> {
    const individual: any = {};
    for (const key in paramRanges) {
        const range = paramRanges[key as keyof typeof paramRanges]!;
        individual[key] = range[Math.floor(Math.random() * range.length)];
    }
    if (individual.EMA_FAST_PERIOD >= individual.EMA_SLOW_PERIOD) {
        const fastPeriods = paramRanges.EMA_FAST_PERIOD!.filter(p => p < individual.EMA_SLOW_PERIOD);
        individual.EMA_FAST_PERIOD = fastPeriods.length > 0 ? fastPeriods[Math.floor(Math.random() * fastPeriods.length)] : paramRanges.EMA_FAST_PERIOD![0];
    }
    return individual;
}

function calculateFitness(performance: PerformanceMetrics): number {
    if (!performance || performance.numberOfTrades < 5) return -1e9; 
    
    const profitScore = performance.totalProfit;
    const stabilityScore = performance.sharpeRatio > 0 ? performance.sharpeRatio : 0; 
    const winRateScore = performance.winRate / 100;
    const drawdownPenalty = Math.exp(-performance.maxDrawdown / 10); 

    let fitness = (profitScore * 0.4) + (stabilityScore * 0.3) + (winRateScore * 0.3);
    fitness *= drawdownPenalty;

    return isNaN(fitness) ? -1e9 : fitness;
}

function select(population: any[], fitnesses: number[]): any {
    const totalFitness = fitnesses.reduce((a, b) => a + b, 0);
    if (totalFitness <= 0) { 
        return population[Math.floor(Math.random() * population.length)];
    }
    const random = Math.random() * totalFitness;
    let currentSum = 0;
    for (let i = 0; i < population.length; i++) {
        currentSum += fitnesses[i];
        if (currentSum > random) {
            return population[i];
        }
    }
    return population[population.length - 1];
}

function crossover(parent1: any, parent2: any): any {
    const child: any = {};
    const keys = Object.keys(parent1);
    for (const key of keys) {
        child[key] = Math.random() < 0.5 ? parent1[key] : parent2[key];
    }
    return child;
}

function mutate(individual: any, paramRanges: any): any {
    const mutatedIndividual = { ...individual };
    for (const key in mutatedIndividual) {
        if (Math.random() < MUTATION_RATE) {
            const range = paramRanges[key];
            mutatedIndividual[key] = range[Math.floor(Math.random() * range.length)];
        }
    }
    if (mutatedIndividual.EMA_FAST_PERIOD >= mutatedIndividual.EMA_SLOW_PERIOD) {
        const fastPeriods = paramRanges.EMA_FAST_PERIOD!.filter((p: number) => p < mutatedIndividual.EMA_SLOW_PERIOD);
        mutatedIndividual.EMA_FAST_PERIOD = fastPeriods.length > 0 ? fastPeriods[Math.floor(Math.random() * fastPeriods.length)] : paramRanges.EMA_FAST_PERIOD![0];
    }
    return mutatedIndividual;
}


export async function optimizeParameters(
    dogeData: ChartDataPoint[], 
    paramRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]?: number[] }
): Promise<{ bestParams: StrategyParams | null; bestPerformance: PerformanceMetrics | null; bestTrades: TradeResult[] }> {
    console.log('Starting genetic algorithm optimization...');
    const initialCapital = 10000;

    let population = Array.from({ length: POPULATION_SIZE }, () => createIndividual(paramRanges as any));
    let bestIndividualFromAllGens: any = null;
    let bestFitnessFromAllGens = -Infinity;
    let bestPerformanceFromAllGens: PerformanceMetrics | null = null;
    let bestTradesFromAllGens: TradeResult[] = [];

    for (let gen = 0; gen < GENERATIONS; gen++) {
        const results = await Promise.all(
            population.map(async (individual) => {
                const params: StrategyParams = { ...individual, SPREAD_PERCENT: 0.01 };
                const trades = await runBacktest(dogeData, params, initialCapital);
                const performance = await calculatePerformanceMetrics(trades, initialCapital);
                const fitness = calculateFitness(performance);
                return { individual, performance, fitness, trades };
            })
        );
        
        results.sort((a, b) => b.fitness - a.fitness);

        if (results[0].fitness > bestFitnessFromAllGens) {
            bestFitnessFromAllGens = results[0].fitness;
            bestIndividualFromAllGens = results[0].individual;
            bestPerformanceFromAllGens = results[0].performance;
            bestTradesFromAllGens = results[0].trades;
        }

        console.log(`Generation ${gen + 1}/${GENERATIONS} | Best Fitness: ${results[0].fitness.toPrecision(4)} | Trades: ${results[0].performance.numberOfTrades} | Profit: ${results[0].performance.totalProfit.toPrecision(4)}`);

        const newPopulation = [];
        const eliteCount = Math.floor(POPULATION_SIZE * ELITISM_RATE);
        
        for (let i = 0; i < eliteCount; i++) {
            newPopulation.push(results[i].individual);
        }
        
        const fitnesses = results.map(r => Math.max(0, r.fitness)); 

        for (let i = eliteCount; i < POPULATION_SIZE; i++) {
            const parent1 = select(population, fitnesses);
            const parent2 = select(population, fitnesses);
            let child = crossover(parent1, parent2);
            child = mutate(child, paramRanges);
            newPopulation.push(child);
        }
        
        population = newPopulation;
    }

    if (bestIndividualFromAllGens) {
        console.log('Genetic algorithm optimization complete.');
        console.log('Best Parameters:', bestIndividualFromAllGens);
        console.log('Best Performance:', bestPerformanceFromAllGens);
    } else {
        console.warn("Genetic algorithm did not find a suitable strategy.");
    }
    
    const bestParams: StrategyParams | null = bestIndividualFromAllGens ? { ...bestIndividualFromAllGens, SPREAD_PERCENT: 0.01 } : null;

    return { bestParams, bestPerformance: bestPerformanceFromAllGens, bestTrades: bestTradesFromAllGens };
}

    