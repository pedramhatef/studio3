/**
 * @fileOverview Genetic Algorithm and Q-Learning based strategy optimizer.
 * This file contains the core logic for running backtests with various parameters
 * to find the most optimal configuration for a given strategy and market condition.
 */

import { runBacktest, scoreMetrics, calculatePerformanceMetrics } from './backtesting';
import type { StrategyParams, StrategyType, PerformanceMetrics, TradeResult, ChartDataPoint } from './types';
import { db } from './firebase';
import { setDoc, doc } from 'firebase/firestore';
import { detectMarketRegime } from './market-regime';
import { getBestParamsFromQTable, updateQTable } from './q-learning';

const POPULATION_SIZE = 25;
const GENERATIONS = 20;
const MUTATION_RATE = 0.3;
const ELITISM_RATE = 0.1;
const CONVERGENCE_THRESHOLD = 5; // Stop if the best score doesn't improve for this many generations

function log(strategyType: StrategyType, message: string, ...args: any[]) {
    const params = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' ');
    console.log(`[Optimizer-${strategyType}] ${message}`, params);
}

/**
 * Creates a single set of random strategy parameters.
 */
function createIndividual(paramRanges: Record<keyof Omit<StrategyParams, 'leverage'>, number[]>): Omit<StrategyParams, 'leverage'> {
    const individual: any = {};
    for (const key in paramRanges) {
        const range = paramRanges[key as keyof typeof paramRanges]!;
        individual[key] = range[Math.floor(Math.random() * range.length)];
    }
    // Ensure EMA fast is always less than EMA slow
    if (individual.EMA_FAST_PERIOD >= individual.EMA_SLOW_PERIOD) {
        individual.EMA_SLOW_PERIOD = individual.EMA_FAST_PERIOD + 5;
    }
    return individual;
}

/**
 * Selects an individual from the population based on fitness (tournament selection).
 */
function select(population: any[], fitnesses: number[]): any {
    const minFitness = Math.min(...fitnesses);
    const adjustedFitnesses = fitnesses.map(f => f - minFitness + 1e-6); // Add small epsilon to avoid total fitness of 0

    const totalFitness = adjustedFitnesses.reduce((a, b) => a + b, 0);

    if (totalFitness <= 0) { 
        return population[Math.floor(Math.random() * population.length)];
    }

    let random = Math.random() * totalFitness;
    for (let i = 0; i < population.length; i++) {
        random -= adjustedFitnesses[i];
        if (random <= 0) {
            return population[i];
        }
    }
    return population[population.length - 1];
}

/**
 * Combines two parents to create a child.
 */
function crossover(parent1: any, parent2: any): any {
    const child: any = {};
    const keys = Object.keys(parent1);
    for (const key of keys) {
        child[key] = Math.random() < 0.5 ? parent1[key] : parent2[key];
    }
    if (child.EMA_FAST_PERIOD >= child.EMA_SLOW_PERIOD) {
        child.EMA_SLOW_PERIOD = child.EMA_FAST_PERIOD + 5;
    }
    return child;
}

/**
* Randomly mutates an individual's parameters.
*/
function mutate(individual: any, paramRanges: any): any {
    const mutatedIndividual = { ...individual };
    for (const key in mutatedIndividual) {
        if (Math.random() < MUTATION_RATE) {
            const range = paramRanges[key];
            mutatedIndividual[key] = range[Math.floor(Math.random() * range.length)];
        }
    }
    if (mutatedIndividual.EMA_FAST_PERIOD >= mutatedIndividual.EMA_SLOW_PERIOD) {
        mutatedIndividual.EMA_SLOW_PERIOD = mutatedIndividual.EMA_FAST_PERIOD + 5;
    }
    return mutatedIndividual;
}


/**
 * The main function to run the genetic algorithm and save the best results.
 * @param strategyType The type of strategy to optimize ('Scalp', 'Day', 'Swing').
 * @param parameterRanges The parameter ranges for the given strategy.
 * @param chartData The historical chart data for backtesting.
 */
export async function runAndSaveOptimization(
    strategyType: StrategyType, 
    parameterRanges: Record<keyof Omit<StrategyParams, 'leverage'>, number[]>,
    chartData: ChartDataPoint[]
) {
    
    try {
        log(strategyType, `====== OPTIMIZATION START ======`);
        
        log(strategyType, "Step 1: Detecting market regime...");
        const marketRegime = await detectMarketRegime(chartData);
        log(strategyType, `Market Regime Detected: ${marketRegime}`);
        
        log(strategyType, "Step 2: Initializing population with Q-Learning...");
        const bestKnownParams = await getBestParamsFromQTable(marketRegime);

        let population: Omit<StrategyParams, 'leverage'>[] = [];
        if (bestKnownParams) {
            log(strategyType, "Seeding population with best known parameters from Q-Table.");
            population.push(bestKnownParams); 
        } else {
            log(strategyType, "No best known params in Q-Table for this regime. Starting with random population.");
        }
        while(population.length < POPULATION_SIZE) {
            population.push(createIndividual(parameterRanges));
        }

        let bestIndividualFromAllGens: any = null;
        let bestPerformanceFromAllGens: PerformanceMetrics | null = null;
        let bestTradesFromAllGens: TradeResult[] = [];
        let generationsWithoutImprovement = 0;
        let bestScore = -Infinity;

        log(strategyType, `Step 3: Starting Genetic Algorithm for ${GENERATIONS} generations...`);
        for (let gen = 0; gen < GENERATIONS; gen++) {
            const fitnessPromises = population.map(async (individual) => {
                const params: StrategyParams = { ...individual, leverage: 10 };
                const backtestResult = await runBacktest(chartData, params);
                const performance = await calculatePerformanceMetrics(backtestResult.trades, backtestResult.initialBalance);
                const score = await scoreMetrics(performance);
                return { individual, performance, score, trades: backtestResult.trades };
            });

            const results = await Promise.all(fitnessPromises);
            results.sort((a, b) => b.score - a.score);
            
            const bestOfGen = results[0];

            if (bestOfGen.score > bestScore) {
                bestScore = bestOfGen.score;
                bestIndividualFromAllGens = bestOfGen.individual;
                bestPerformanceFromAllGens = bestOfGen.performance;
                bestTradesFromAllGens = bestOfGen.trades;
                generationsWithoutImprovement = 0;
                log(strategyType, `Gen ${gen + 1}: New best! Score: ${bestScore.toFixed(4)}, Profit: ${bestPerformanceFromAllGens?.netProfit.toFixed(2)}%, Trades: ${bestPerformanceFromAllGens?.numberOfTrades}`);
            } else {
                generationsWithoutImprovement++;
                log(strategyType, `Gen ${gen + 1}: No improvement. Best score remains ${bestScore.toFixed(4)}.`);
            }

            if (generationsWithoutImprovement >= CONVERGENCE_THRESHOLD && bestScore > 0) {
                log(strategyType, `Stopping early at Gen ${gen + 1} due to convergence on a good result.`);
                break;
            }

            const newPopulation = [];
            const eliteCount = Math.floor(POPULATION_SIZE * ELITISM_RATE);
            for (let i = 0; i < eliteCount; i++) {
                newPopulation.push(results[i].individual);
            }
            
            const fitnesses = results.map(r => r.score);

            for (let i = eliteCount; i < POPULATION_SIZE; i++) {
                const parent1 = select(population, fitnesses);
                const parent2 = select(population, fitnesses);
                let child = crossover(parent1, parent2);
                child = mutate(child, parameterRanges);
                newPopulation.push(child);
            }
            
            population = newPopulation;
        }
        log(strategyType, `Genetic Algorithm finished.`);

        if (!bestIndividualFromAllGens || !bestPerformanceFromAllGens || bestPerformanceFromAllGens.numberOfTrades < 5) {
            log(strategyType, `CRITICAL: Optimization failed. Did not find a suitable strategy with enough trades. Aborting save.`);
            return;
        }

        log(strategyType, "Step 4: Updating AI long-term memory (Q-Table)...");
        await updateQTable(marketRegime, bestIndividualFromAllGens, bestScore);
        
        log(strategyType, `Step 5: Saving best parameters to Firestore document: latest-${strategyType}`);
        const docId = `latest-${strategyType}`;
        const optimizationResultDoc = doc(db, 'optimizationResults', docId);
        await setDoc(optimizationResultDoc, {
            strategyType,
            marketRegime,
            bestParams: bestIndividualFromAllGens,
            bestPerformance: bestPerformanceFromAllGens,
            bestTrades: bestTradesFromAllGens.slice(0, 20),
            score: bestScore,
            timestamp: new Date(),
        });
        log(strategyType, `Successfully saved results to Firestore.`);
        log(strategyType, `====== OPTIMIZATION COMPLETE ======`);

    } catch (error) {
        log(strategyType, `CRITICAL: Unhandled error in optimization task:`, error);
    }
}
