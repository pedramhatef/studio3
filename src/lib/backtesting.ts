
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
    sortinoRatio: number;
    calmarRatio: number;
};

const getValueAt = (arr: (number | null)[], idx: number): number | null => {
    if (idx < 0 || idx >= arr.length) return null;
    const value = arr[idx];
    return value === null || typeof value === 'undefined' || isNaN(value) ? null : value;
};

const applySpread = (price: number, type: 'BUY' | 'SELL', spreadPercent: number) => {
    const spread = price * (spreadPercent / 100);
    return type === 'BUY' ? price + spread : price - spread;
};

const isCandleBullish = (candle: ChartDataPoint) => candle.close > candle.open;
const isCandleBearish = (candle: ChartDataPoint) => candle.close < candle.open;
const candleStrength = (candle: ChartDataPoint) => {
    const range = candle.high - candle.low;
    return range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
};

export async function runBacktest(dogeData: ChartDataPoint[], params: StrategyParams, initialCapital: number = 10000): Promise<TradeResult[]> {
    const trades: TradeResult[] = [];
    let capital = initialCapital;
    let inTrade: InTradeState | null = null;
    
    const requiredPeriods = Math.max(
        params.EMA_SLOW_PERIOD, 
        params.RSI_PERIOD, 
        params.ATR_PERIOD, 
        params.VOLUME_PERIOD
    ) + 15;

    if (dogeData.length < requiredPeriods) {
        return trades;
    }

    const dogeClose = dogeData.map(d => d.close);
    const dogeVolume = dogeData.map(d => d.volume);

    const emaFastArr = indicators.calculateEMA(dogeClose, params.EMA_FAST_PERIOD);
    const emaSlowArr = indicators.calculateEMA(dogeClose, params.EMA_SLOW_PERIOD);
    const rsiArr = indicators.calculateRSI(dogeClose, params.RSI_PERIOD);
    const atrArr = indicators.calculateATR(dogeData, params.ATR_PERIOD);
    const psarArr = indicators.calculateParabolicSAR(dogeData, params.PARABOLIC_SAR_STEP, params.PARABOLIC_SAR_MAX);
    const avgVolumeArr = indicators.calculateSMA(dogeVolume, params.VOLUME_PERIOD);
    
    for (let i = requiredPeriods; i < dogeData.length; i++) {
        const currentCandle = dogeData[i]; 
        
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
            
            const emaFastPrev = getValueAt(emaFastArr, i - 2);
            const emaSlowPrev = getValueAt(emaSlowArr, i - 2);
            const emaFast = getValueAt(emaFastArr, i - 1);
            const emaSlow = getValueAt(emaSlowArr, i - 1);
            
            const emaCrossedDownForExit = (emaFastPrev ?? 0) >= (emaSlowPrev ?? 0) && (emaFast ?? 0) < (emaSlow ?? 0);
            if (inTrade.type === 'BUY' && emaCrossedDownForExit && !exitPrice) {
                 exitPrice = currentCandle.open;
                 exitReason = 'Opposite Signal';
            }

            const emaCrossedUpForExit = (emaFastPrev ?? 0) <= (emaSlowPrev ?? 0) && (emaFast ?? 0) > (emaSlow ?? 0);
            if (inTrade.type === 'SELL' && emaCrossedUpForExit && !exitPrice) {
                 exitPrice = currentCandle.open;
                 exitReason = 'Opposite Signal';
            }

            if (exitPrice && exitReason) {
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
            const prevCandle = dogeData[i-1];
            
            const emaFast = getValueAt(emaFastArr, i - 1);
            const emaSlow = getValueAt(emaSlowArr, i - 1);
            const rsi = getValueAt(rsiArr, i - 1);
            const psar = getValueAt(psarArr, i - 1);
            const volume = getValueAt(dogeVolume, i - 1);
            const avgVolume = getValueAt(avgVolumeArr, i - 1);
            const atr = getValueAt(atrArr, i - 1);
            const emaFastPrev = getValueAt(emaFastArr, i - 2);
            const emaSlowPrev = getValueAt(emaSlowArr, i - 2);

            const allIndicatorsValid = [emaFast, emaSlow, rsi, psar, volume, avgVolume, atr, emaFastPrev, emaSlowPrev].every(v => v !== null);
            
            if (allIndicatorsValid) {
                let signalType: Signal['type'] | null = null;
                
                const emaCrossedUp = (emaFastPrev!) <= (emaSlowPrev!) && (emaFast!) > (emaSlow!);
                const volumeConditionHigh = (volume!) > ((avgVolume!) * params.VOLUME_THRESHOLD_MULTIPLIER);
                if (emaCrossedUp && (rsi!) < params.RSI_OVERBOUGHT_THRESHOLD && (psar!) < prevCandle.close && volumeConditionHigh) {
                    signalType = 'BUY';
                } 
                
                const emaCrossedDown = (emaFastPrev!) >= (emaSlowPrev!) && (emaFast!) < (emaSlow!);
                if (!signalType && emaCrossedDown && (rsi!) > params.RSI_OVERSOLD_THRESHOLD && (psar!) > prevCandle.close && volumeConditionHigh) {
                    signalType = 'SELL';
                }
                
                if (!signalType) {
                    const volumeConditionMedium = (volume!) > ((avgVolume!) * params.VOLUME_THRESHOLD_MULTIPLIERConfirmation);
                    
                    const isPullbackBuy = (emaFast!) > (emaSlow!) && prevCandle.low <= (emaSlow!) && prevCandle.close > (emaSlow!);
                    const rsiOkForBuyPullback = (rsi!) > 40 && (rsi!) < params.RSI_OVERBOUGHT_THRESHOLD;
                    if (isPullbackBuy && rsiOkForBuyPullback && (psar!) < prevCandle.close && volumeConditionMedium) {
                        signalType = 'BUY';
                    }
                    
                    const isPullbackSell = (emaFast!) < (emaSlow!) && prevCandle.high >= (emaSlow!) && prevCandle.close < (emaSlow!);
                    const rsiOkForSellPullback = (rsi!) < 60 && (rsi!) > params.RSI_OVERSOLD_THRESHOLD;
                    if (!signalType && isPullbackSell && rsiOkForSellPullback && (psar!) > prevCandle.close && volumeConditionMedium) {
                        signalType = 'SELL';
                    }
                }

                if (signalType) {
                    const minPriceMovement = (atr!) * params.NOISE_FILTER_RATIO;
                    const priceChange = Math.abs(currentCandle.open - prevCandle.close);
                    const atrFilterPassed = priceChange >= minPriceMovement;

                    const isBullishConfirm = isCandleBullish(currentCandle) && candleStrength(currentCandle) > 0.3;
                    const isBearishConfirm = isCandleBearish(currentCandle) && candleStrength(currentCandle) > 0.3;
                    
                    const buySignalValid = signalType === 'BUY' && isBullishConfirm && atrFilterPassed;
                    const sellSignalValid = signalType === 'SELL' && isBearishConfirm && atrFilterPassed;

                    if (buySignalValid || sellSignalValid) {
                         const entryPrice = applySpread(currentCandle.open, signalType, params.SPREAD_PERCENT);
                         inTrade = {
                             entryPrice: entryPrice,
                             entryTime: currentCandle.time,
                             type: signalType,
                             entryCandleIndex: i,
                             initialCapital: capital,
                             stopLossPrice: signalType === 'BUY' 
                                 ? entryPrice - ((atr!) * params.STOP_LOSS_ATR_MULTIPLIER) 
                                 : entryPrice + ((atr!) * params.STOP_LOSS_ATR_MULTIPLIER),
                             takeProfitPrice: signalType === 'BUY' 
                                 ? entryPrice + ((atr!) * params.TAKE_PROFIT_ATR_MULTIPLIER) 
                                 : entryPrice - ((atr!) * params.TAKE_PROFIT_ATR_MULTIPLIER),
                         };
                    }
                }
            }
        }
    }

    if (inTrade) {
        const lastCandle = dogeData[dogeData.length - 1];
        const effectiveExitPrice = applySpread(lastCandle.close, inTrade.type === 'BUY' ? 'SELL' : 'BUY', params.SPREAD_PERCENT);
        const profit = (inTrade.type === 'BUY' ? effectiveExitPrice - inTrade.entryPrice : inTrade.entryPrice - effectiveExitPrice);
        
        trades.push({
            ...inTrade,
            exitPrice: effectiveExitPrice,
            exitTime: lastCandle.time,
            exitCandleIndex: dogeData.length - 1,
            profit: profit,
            profitPercentage: (profit / inTrade.entryPrice) * 100,
            finalCapital: inTrade.initialCapital + profit,
            exitReason: 'End of Data'
        });
    }

    return trades;
}


export async function calculatePerformanceMetrics(trades: TradeResult[], initialCapital: number): Promise<PerformanceMetrics> {
    const numberOfTrades = trades.length;

    if (numberOfTrades === 0) {
        return {
            totalProfit: 0, totalProfitPercentage: 0, numberOfTrades: 0, winningTrades: 0,
            losingTrades: 0, winRate: 0, lossRate: 0, averageWin: 0, averageLoss: 0,
            profitFactor: 0, sharpeRatio: 0, maxDrawdown: 0, expectancy: 0,
            sortinoRatio: 0, calmarRatio: 0,
        };
    }
    
    const finalCapital = trades.length > 0 ? trades[trades.length - 1].finalCapital : initialCapital;
    const totalProfit = finalCapital - initialCapital;
    const totalProfitPercentage = (totalProfit / initialCapital) * 100;

    const winningTrades = trades.filter(t => t.profit > 0);
    const losingTrades = trades.filter(t => t.profit <= 0);

    const totalWinAmount = winningTrades.reduce((sum, t) => sum + t.profit, 0);
    const totalLossAmount = Math.abs(losingTrades.reduce((sum, t) => sum + t.profit, 0));
    
    const winRate = (winningTrades.length / numberOfTrades) * 100;
    const lossRate = (losingTrades.length / numberOfTrades) * 100;
    
    const averageWin = winningTrades.length > 0 ? totalWinAmount / winningTrades.length : 0;
    const averageLoss = losingTrades.length > 0 ? totalLossAmount / losingTrades.length : 0;
    
    const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : Infinity;

    const returns = trades.map(t => t.profitPercentage / 100);
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / numberOfTrades;
    
    const returnsStdDev = Math.sqrt(returns.map(x => Math.pow(x - avgReturn, 2)).reduce((a, b) => a + b) / returns.length);
    const sharpeRatio = returnsStdDev > 0 ? avgReturn / returnsStdDev : 0;
    
    const downsideReturns = returns.filter(r => r < 0);
    const downsideDev = downsideReturns.length > 1 ? 
        Math.sqrt(downsideReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / downsideReturns.length) : 0;
    
    const sortinoRatio = downsideDev > 0 ? avgReturn / downsideDev : 0;
    
    let peak = initialCapital;
    let maxDrawdown = 0;
    const equityCurve = [initialCapital, ...trades.map(trade => trade.finalCapital)];

    for (const equity of equityCurve) {
        if (equity > peak) {
            peak = equity;
        }
        const drawdown = (peak - equity) / peak;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
        }
    }

    const durationDays = (trades[trades.length-1].exitTime - trades[0].entryTime) / (1000 * 60 * 60 * 24);
    if(durationDays <= 0) {
         return {
            totalProfit, totalProfitPercentage, numberOfTrades, winningTrades: winningTrades.length,
            losingTrades: losingTrades.length, winRate, lossRate, averageWin, averageLoss,
            profitFactor: isFinite(profitFactor) ? profitFactor : 0, sharpeRatio: isFinite(sharpeRatio) ? sharpeRatio : 0, 
            maxDrawdown: maxDrawdown * 100, expectancy: 0,
            sortinoRatio: isFinite(sortinoRatio) ? sortinoRatio : 0, calmarRatio: 0,
        };
    }
    const annualizedReturn = Math.pow(1 + totalProfit / initialCapital, 365 / durationDays ) -1;
    const calmarRatio = maxDrawdown > 0 ? (annualizedReturn) / maxDrawdown : 0;

    const winExpectancy = averageWin / initialCapital;
    const lossExpectancy = averageLoss / initialCapital;
    const expectancy = (winRate / 100) * winExpectancy - (lossRate / 100) * lossExpectancy;

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
        profitFactor: isFinite(profitFactor) ? profitFactor : 0,
        sharpeRatio: isFinite(sharpeRatio) ? sharpeRatio * Math.sqrt(365 * 24 * 60) : 0, // Annualized for 1-minute data
        maxDrawdown: maxDrawdown * 100,
        expectancy: expectancy * 100,
        sortinoRatio: isFinite(sortinoRatio) ? sortinoRatio * Math.sqrt(365*24*60) : 0,
        calmarRatio: isFinite(calmarRatio) ? calmarRatio : 0,
    };
}

const POPULATION_SIZE = 50;
const GENERATIONS = 20;
const MUTATION_RATE = 0.15;
const ELITISM_RATE = 0.1;

function createIndividual(paramRanges: { [key in keyof Omit<StrategyParams, 'SPREAD_PERCENT'>]: number[] }): Omit<StrategyParams, 'SPREAD_PERCENT'> {
    const individual: any = {};
    for (const key in paramRanges) {
        const range = paramRanges[key as keyof typeof paramRanges]!;
        individual[key] = range[Math.floor(Math.random() * range.length)];
    }
    if (individual.EMA_FAST_PERIOD >= individual.EMA_SLOW_PERIOD) {
        const fastPeriods = paramRanges.EMA_FAST_PERIOD!.filter(p => p < individual.EMA_SLOW_PERIOD);
        individual.EMA_FAST_PERIOD = fastPeriods.length > 0 
            ? fastPeriods[Math.floor(Math.random() * fastPeriods.length)] 
            : paramRanges.EMA_FAST_PERIOD![0];
    }
    return individual;
}

function calculateFitness(performance: PerformanceMetrics): number {
    if (!performance || performance.numberOfTrades < 10) return -1e9; 
    
    const profitScore = performance.totalProfitPercentage > 0 ? Math.log(1 + performance.totalProfitPercentage) : -10;
    const stabilityScore = (performance.sortinoRatio > 0 ? performance.sortinoRatio : 0) * 1.5;
    
    const winRateScore = performance.winRate / 100;
    const profitFactorScore = performance.profitFactor > 1.1 ? Math.log(performance.profitFactor) : -1;

    const drawdownPenalty = Math.exp(-performance.maxDrawdown / 15);
    
    let fitness = 
        (profitScore * 0.4) + 
        (stabilityScore * 0.3) + 
        (winRateScore * 0.1) + 
        (profitFactorScore * 0.2);
        
    fitness *= drawdownPenalty;
    
    if (performance.numberOfTrades < 25) {
        fitness *= Math.pow(performance.numberOfTrades / 25, 2);
    }
    
    return isFinite(fitness) ? fitness : -1e9;
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
        mutatedIndividual.EMA_FAST_PERIOD = fastPeriods.length > 0 
            ? fastPeriods[Math.floor(Math.random() * fastPeriods.length)] 
            : paramRanges.EMA_FAST_PERIOD![0];
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
    let generationsWithoutImprovement = 0;

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
        const bestResultThisGen = results[0];

        if (bestResultThisGen.fitness > bestFitnessFromAllGens) {
            bestFitnessFromAllGens = bestResultThisGen.fitness;
            bestIndividualFromAllGens = bestResultThisGen.individual;
            bestPerformanceFromAllGens = bestResultThisGen.performance;
            bestTradesFromAllGens = bestResultThisGen.trades;
            generationsWithoutImprovement = 0;
        } else {
            generationsWithoutImprovement++;
        }

        console.log(`Generation ${gen + 1}/${GENERATIONS} | Best Fitness: ${bestResultThisGen.fitness.toPrecision(4)} | Trades: ${bestResultThisGen.performance.numberOfTrades} | Profit: ${bestResultThisGen.performance.totalProfitPercentage.toFixed(2)}% | Win Rate: ${bestResultThisGen.performance.winRate.toFixed(1)}%`);

        if (generationsWithoutImprovement >= 5 && bestFitnessFromAllGens > -1e9) {
            console.log("Stopping early due to convergence on a valid strategy.");
            break;
        }

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
        const bestParams: StrategyParams = { ...bestIndividualFromAllGens, SPREAD_PERCENT: 0.01 };
        return { bestParams, bestPerformance: bestPerformanceFromAllGens, bestTrades: bestTradesFromAllGens };
    } else {
        console.warn("Genetic algorithm did not find a suitable strategy.");
        return { bestParams: null, bestPerformance: null, bestTrades: [] };
    }
}
