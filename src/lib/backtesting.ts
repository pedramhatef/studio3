
'use server';

import type { ChartDataPoint, Signal, StrategyParams, TradeResult, InTradeState } from '@/lib/types';
import * as indicators from '@/lib/indicators';
import { generateSignal } from '@/lib/signal-generator';

const POPULATION_SIZE = 30;
const GENERATIONS = 20;
const MUTATION_RATE = 0.2;
const ELITISM_RATE = 0.1;
const CONVERGENCE_THRESHOLD = 5; // Generations to wait for improvement before stopping


const applySpread = (price: number, type: 'BUY' | 'SELL', spreadPercent: number) => {
    const spread = price * (spreadPercent / 100);
    return type === 'BUY' ? price + spread : price - spread;
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

    // Calculate all indicators once
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
            let shouldExit = false;

            if (inTrade.type === 'BUY') {
                if (currentCandle.low <= inTrade.stopLossPrice) {
                    exitPrice = inTrade.stopLossPrice;
                    exitReason = 'Stop Loss';
                    shouldExit = true;
                } else if (currentCandle.high >= inTrade.takeProfitPrice) {
                    exitPrice = inTrade.takeProfitPrice;
                    exitReason = 'Take Profit';
                    shouldExit = true;
                }
            } else { // SELL trade
                if (currentCandle.high >= inTrade.stopLossPrice) {
                    exitPrice = inTrade.stopLossPrice;
                    exitReason = 'Stop Loss';
                    shouldExit = true;
                } else if (currentCandle.low <= inTrade.takeProfitPrice) {
                    exitPrice = inTrade.takeProfitPrice;
                    exitReason = 'Take Profit';
                    shouldExit = true;
                }
            }
            
            // Check for opposite signal as an exit condition
            if (!shouldExit) {
                const oppositeSignal = await generateSignal(i, dogeData, params, emaFastArr, emaSlowArr, rsiArr, psarArr, avgVolumeArr, atrArr);
                if (oppositeSignal && oppositeSignal.type !== inTrade.type) {
                    exitPrice = currentCandle.open;
                    exitReason = 'Opposite Signal';
                    shouldExit = true;
                }
            }


            if (shouldExit && exitPrice !== null && exitReason !== null) {
                const effectiveExitPrice = applySpread(exitPrice, inTrade.type === 'BUY' ? 'SELL' : 'BUY', params.SPREAD_PERCENT);
                const profit = (inTrade.type === 'BUY' ? effectiveExitPrice - inTrade.entryPrice : inTrade.entryPrice - effectiveExitPrice);
                const profitPercentage = (profit / inTrade.entryPrice) * 100;
                const finalCapital = capital + profit;

                trades.push({
                    entryPrice: inTrade.entryPrice,
                    exitPrice: effectiveExitPrice,
                    entryTime: inTrade.entryTime,
                    exitTime: currentCandle.time,
                    type: inTrade.type,
                    profit,
                    profitPercentage,
                    entryCandleIndex: inTrade.entryCandleIndex,
                    exitCandleIndex: i,
                    initialCapital: capital,
                    finalCapital,
                    exitReason,
                });
                capital = finalCapital;
                inTrade = null;
            }
        }
        
        // --- ENTRY LOGIC ---
        if (!inTrade) {
            const signal = await generateSignal(i, dogeData, params, emaFastArr, emaSlowArr, rsiArr, psarArr, avgVolumeArr, atrArr);
            
            if (signal) {
                const atrValue = indicators.getValueAt(atrArr, i-1) ?? 0;
                if (atrValue > 0) { // Ensure ATR is valid before entering
                    const entryPrice = applySpread(signal.price, signal.type, params.SPREAD_PERCENT);

                    inTrade = {
                        entryPrice: entryPrice,
                        entryTime: signal.time,
                        type: signal.type,
                        entryCandleIndex: i,
                        initialCapital: capital,
                        stopLossPrice: signal.type === 'BUY' 
                            ? entryPrice - (atrValue * params.STOP_LOSS_ATR_MULTIPLIER) 
                            : entryPrice + (atrValue * params.STOP_LOSS_ATR_MULTIPLIER),
                        takeProfitPrice: signal.type === 'BUY' 
                            ? entryPrice + (atrValue * params.TAKE_PROFIT_ATR_MULTIPLIER) 
                            : entryPrice - (atrValue * params.TAKE_PROFIT_ATR_MULTIPLIER),
                    };
                }
            }
        }
    }

    if (inTrade) {
        const lastCandle = dogeData[dogeData.length - 1];
        const exitPrice = lastCandle.close;
        const effectiveExitPrice = applySpread(exitPrice, inTrade.type === 'BUY' ? 'SELL' : 'BUY', params.SPREAD_PERCENT);
        const profit = (inTrade.type === 'BUY' ? effectiveExitPrice - inTrade.entryPrice : inTrade.entryPrice - effectiveExitPrice);
        const profitPercentage = (profit / inTrade.entryPrice) * 100;
        const finalCapital = capital + profit;
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
    
    if (numberOfTrades === 0) {
        return {
            totalProfit: 0,
            totalProfitPercentage: 0,
            numberOfTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            winRate: 0,
            lossRate: 0,
            averageWin: 0,
            averageLoss: 0,
            profitFactor: 0,
            sharpeRatio: 0,
            maxDrawdown: 0,
            expectancy: 0,
        };
    }

    const finalCapital = trades[trades.length - 1].finalCapital;
    const totalProfit = finalCapital - initialCapital;
    const totalProfitPercentage = initialCapital > 0 ? (totalProfit / initialCapital) * 100 : 0;

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
    const stdDev = numberOfTrades > 1 ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (numberOfTrades - 1)) : 0;
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252 * 24 * 60) : 0; // Annualized for 1-minute data

    let peak = initialCapital;
    let maxDrawdown = 0;
    let equityCurve = [initialCapital];
    trades.forEach(trade => {
        const newCapital = equityCurve[equityCurve.length - 1] + trade.profit;
        equityCurve.push(newCapital);
        peak = Math.max(peak, newCapital);
        const drawdown = peak > 0 ? (peak - newCapital) / peak : 0;
        maxDrawdown = Math.max(maxDrawdown, drawdown);
    });

    const averageWinPct = winningTrades.length > 0 ? winningTrades.reduce((acc, t) => acc + t.profitPercentage, 0) / winningTrades.length : 0;
    const averageLossPct = losingTrades.length > 0 ? Math.abs(losingTrades.reduce((acc, t) => acc + t.profitPercentage, 0) / losingTrades.length) : 0;
    const expectancy = ((winRate / 100) * averageWinPct) - ((lossRate / 100) * averageLossPct);

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
        sharpeRatio: isNaN(sharpeRatio) ? 0 : sharpeRatio,
        maxDrawdown: maxDrawdown * 100, 
        expectancy: isNaN(expectancy) ? 0 : expectancy,
    };
}


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
    if (!performance || performance.numberOfTrades < 10) return -1e9; // Penalize no trades or very few trades heavily

    const profitFactor = performance.totalProfit > 0 ? performance.totalProfit : performance.totalProfit * 2;
    const sharpeFactor = performance.sharpeRatio > 0 ? performance.sharpeRatio : 0;
    const drawdownFactor = Math.exp(-performance.maxDrawdown / 20); // Penalize high drawdown; 20% is a reasonable threshold
    const winRateFactor = performance.winRate / 100;
    const tradeCountFactor = 1 - Math.exp(-performance.numberOfTrades / 50); // Encourage a reasonable number of trades

    // Weighted score
    let fitness =
        profitFactor * 0.4 +   // Heavily weighted towards net profit
        sharpeFactor * 0.2 +   // Rewards consistency of returns
        winRateFactor * 0.1 +  // Prefers strategies that win more often
        performance.profitFactor * 0.1 + // Rewards strategies where wins are larger than losses
        performance.expectancy * 0.2; // Rewards positive expectancy per trade

    fitness *= drawdownFactor;  // Scale fitness by drawdown penalty
    fitness *= tradeCountFactor; // Scale fitness by trade count encouragement

    return isFinite(fitness) ? fitness : -1e9; // Ensure we don't return NaN or Infinity
}

function select(population: any[], fitnesses: number[]): any {
    // Normalize fitness scores to be non-negative for wheel selection
    const minFitness = Math.min(...fitnesses);
    const adjustedFitnesses = fitnesses.map(f => f - minFitness);

    const totalFitness = adjustedFitnesses.reduce((a, b) => a + b, 0);

    if (totalFitness <= 0) { 
        return population[Math.floor(Math.random() * population.length)];
    }

    const random = Math.random() * totalFitness;
    let currentSum = 0;
    for (let i = 0; i < population.length; i++) {
        currentSum += adjustedFitnesses[i];
        if (currentSum > random) {
            return population[i];
        }
    }
    return population[population.length - 1]; // Fallback
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
    (global as any).ENABLE_DETAILED_LOGS = false; // Disable detailed logging for optimizer runs
    const initialCapital = 10000;

    let population = Array.from({ length: POPULATION_SIZE }, () => createIndividual(paramRanges as any));
    let bestIndividualFromAllGens: any = null;
    let bestFitnessFromAllGens = -Infinity;
    let bestPerformanceFromAllGens: PerformanceMetrics | null = null;
    let bestTradesFromAllGens: TradeResult[] = [];
    let generationsWithoutImprovement = 0;

    for (let gen = 0; gen < GENERATIONS; gen++) {
        const fitnessPromises = population.map(async (individual) => {
            const params: StrategyParams = { ...individual, SPREAD_PERCENT: 0.01 };
            const trades = await runBacktest(dogeData, params, initialCapital);
            const performance = await calculatePerformanceMetrics(trades, initialCapital);
            const fitness = calculateFitness(performance);
            return { individual, performance, fitness, trades };
        });

        const results = await Promise.all(fitnessPromises);
        
        results.sort((a, b) => b.fitness - a.fitness);
        const bestResultOfGen = results[0];

        if (bestResultOfGen.fitness > bestFitnessFromAllGens) {
            bestFitnessFromAllGens = bestResultOfGen.fitness;
            bestIndividualFromAllGens = bestResultOfGen.individual;
            bestPerformanceFromAllGens = bestResultOfGen.performance;
            bestTradesFromAllGens = bestResultOfGen.trades;
            generationsWithoutImprovement = 0;
            console.log(`New best in Gen ${gen + 1}! Fitness: ${bestFitnessFromAllGens.toPrecision(4)}, Trades: ${bestPerformanceFromAllGens?.numberOfTrades}, Profit: ${bestPerformanceFromAllGens?.totalProfitPercentage.toFixed(2)}%`);
        } else {
            generationsWithoutImprovement++;
        }

        console.log(`Gen ${gen + 1}/${GENERATIONS} | Best Fitness: ${bestResultOfGen.fitness.toPrecision(4)} | Trades: ${bestResultOfGen.performance.numberOfTrades} | Profit: ${bestResultOfGen.performance.totalProfitPercentage.toFixed(2)}% | Win Rate: ${bestResultOfGen.performance.winRate.toFixed(1)}%`);

        if (generationsWithoutImprovement >= CONVERGENCE_THRESHOLD && bestPerformanceFromAllGens && bestPerformanceFromAllGens.numberOfTrades > 10) {
            console.log("Stopping early due to convergence on a good result.");
            break;
        }

        const newPopulation = [];
        const eliteCount = Math.floor(POPULATION_SIZE * ELITISM_RATE);
        
        for (let i = 0; i < eliteCount; i++) {
            newPopulation.push(results[i].individual);
        }
        
        const fitnesses = results.map(r => r.fitness);

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
