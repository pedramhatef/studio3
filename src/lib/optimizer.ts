/**
 * @fileOverview Genetic Algorithm and Q-Learning based strategy optimizer.
 * This file contains the core logic for running backtests with various parameters
 * to find the most optimal configuration for a given strategy and market condition.
 */
'use server';

import { getChartData } from '../app/actions';
import { runBacktest, scoreMetrics, calculatePerformanceMetrics, PARAMETER_RANGES } from './backtesting';
import type { StrategyParams, StrategyType, PerformanceMetrics, TradeResult } from './types';
import { db } from './firebase';
import { setDoc, doc, terminate } from 'firebase/firestore';
import { detectMarketRegime } from './market-regime';
import { getBestParamsFromQTable, updateQTable } from './q-learning';

const POPULATION_SIZE = 25;
const GENERATIONS = 20;
const MUTATION_RATE = 0.3;
const ELITISM_RATE = 0.1;
const CONVERGENCE_THRESHOLD = 5; // Stop if the best score doesn't improve for this many generations

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
    const adjustedFitnesses = fitnesses.map(f => f - minFitness);

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
 */
export async function runAndSaveOptimization(strategyType: StrategyType, parameterRanges: Record<keyof Omit<StrategyParams, 'leverage'>, number[]>) {
    
    try {
        console.log(`=== STRATEGY OPTIMIZATION (${strategyType}) STARTING ===`);
        
        const chartData = await getChartData('DOGEUSDT', 1000);
        console.log(`Loaded ${chartData.length} DOGE data points for backtesting.`);

        if (chartData.length < 500) {
            console.error("Not enough historical data to run optimization.");
            return;
        }
        
        const marketRegime = await detectMarketRegime(chartData);
        console.log(`Current Market Regime Detected: ${marketRegime}`);

        const bestKnownParams = await getBestParamsFromQTable(marketRegime);

        let population: Omit<StrategyParams, 'leverage'>[] = [];
        if (bestKnownParams) {
            console.log("Seeding population with best known parameters from Q-Table.");
            population.push(bestKnownParams); 
        }
        while(population.length < POPULATION_SIZE) {
            population.push(createIndividual(parameterRanges));
        }

        let bestIndividualFromAllGens: any = null;
        let bestPerformanceFromAllGens: PerformanceMetrics | null = null;
        let bestTradesFromAllGens: TradeResult[] = [];
        let generationsWithoutImprovement = 0;
        let bestScore = -Infinity;

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
                console.log(`New best in Gen ${gen + 1}! Score: ${bestScore.toFixed(4)}, Profit: ${bestPerformanceFromAllGens?.netProfit.toFixed(2)}%, Trades: ${bestPerformanceFromAllGens?.numberOfTrades}`);
            } else {
                generationsWithoutImprovement++;
            }
            
            console.log(`Gen ${gen + 1}/${GENERATIONS} | Best Score: ${bestOfGen.score.toFixed(4)}`);

            if (generationsWithoutImprovement >= CONVERGENCE_THRESHOLD && bestScore > 0) {
                console.log("Stopping early due to convergence on a good result.");
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

        if (!bestIndividualFromAllGens || !bestPerformanceFromAllGens || bestPerformanceFromAllGens.numberOfTrades < 5) {
            console.error(`Optimization failed for ${strategyType}: did not find a suitable strategy with enough trades.`);
            return;
        }

        await updateQTable(marketRegime, bestIndividualFromAllGens, bestScore);
        
        console.log(`Saving best parameters to Firestore document: latest-${strategyType}`);
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
        console.log(`Successfully saved ${strategyType} optimization results to Firestore.`);

    } catch (error) {
        console.error(`[Optimization Task Error] Failed to run optimization for ${strategyType}:`, error);
    } finally {
        await terminate(db);
        console.log(`Firestore connection terminated for ${strategyType} optimizer.`);
    }
}