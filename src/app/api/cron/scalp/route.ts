
import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore, getLatestOptimizationParams } from '@/app/actions';
import type { Signal, StrategyParams } from '@/lib/types';
import { generateSignal } from '@/lib/signal-generator';
import * as indicators from '@/lib/indicators';

const COOLDOWN_HIGH = 1 * 60 * 1000; // 1 minute
const COOLDOWN_MEDIUM = 2 * 60 * 1000; // 2 minutes
const STRATEGY_TYPE = 'Scalp';

export const revalidate = 0;

function log(message: string, ...args: any[]) {
    console.log(`[Cron-Scalp] ${message}`, ...args);
}

export async function GET() {
    log(`====== CRON JOB START ======`);
    
    let strategyConfig: StrategyParams;

    try {
        log("--- Fetching Optimal Parameters ---");
        const latestParams = await getLatestOptimizationParams(STRATEGY_TYPE);
        if (latestParams) {
            strategyConfig = { ...latestParams } as StrategyParams;
            log(`Applied optimal parameters from Firestore.`);
        } else {
            log(`No optimization results found for ${STRATEGY_TYPE}. Attempting to fall back to 'Day' strategy parameters.`);
            const dayParams = await getLatestOptimizationParams('Day');
            if (dayParams) {
                strategyConfig = { ...dayParams } as StrategyParams;
                 log(`Applied FALLBACK 'Day' parameters.`);
            } else {
                log(`CRITICAL: No optimization results found for ${STRATEGY_TYPE} or Day. Cannot generate signal.`);
                return NextResponse.json({ message: `No strategy parameters available for ${STRATEGY_TYPE} or fallback.` }, { status: 500 });
            }
        }
    } catch (error) {
        log(`CRITICAL: Error fetching optimization results:`, error);
        return NextResponse.json({ message: 'Failed to fetch strategy parameters.' }, { status: 500 });
    }

    try {
        log("--- Fetching Chart Data ---");
        const requiredPeriods = Math.max(
            strategyConfig.EMA_SLOW_PERIOD, 
            strategyConfig.RSI_PERIOD, 
            strategyConfig.VOLUME_PERIOD,
            strategyConfig.ATR_PERIOD,
            strategyConfig.EMA_LONG_PERIOD
        ) + 50;

        const chartData = await getChartData('DOGEUSDT', 500);
        log(`Fetched ${chartData.length} candles. Required: ${requiredPeriods}.`);

        if (!Array.isArray(chartData) || chartData.length < requiredPeriods) { 
            log(`Insufficient data. DOGE=${chartData?.length ?? 0}. Aborting.`);
            return NextResponse.json({ message: 'Not enough data for indicators.' });
        }
        
        log("--- Checking Signal Cooldown ---");
        const recentSignals = await getSignalHistoryFromFirestore();
        const lastSignal = recentSignals?.[0] ?? null;

        if (lastSignal?.time && lastSignal.strategy === STRATEGY_TYPE) {
            const lastSignalTime = lastSignal.time;
            const latestCandleTime = chartData[chartData.length - 1].time;
            const timeSinceLastSignalMs = latestCandleTime - lastSignalTime;
            const cooldown = lastSignal.level === 'High' ? COOLDOWN_HIGH : COOLDOWN_MEDIUM;
            const cooldownActive = timeSinceLastSignalMs > 0 && timeSinceLastSignalMs < cooldown;
            
            if (cooldownActive) { 
                log(`In trade cooldown. Last signal was ${Math.floor(timeSinceLastSignalMs/1000)}s ago. Aborting.`);
                return NextResponse.json({ message: 'In trade cooldown.' });
            }
            log("Cooldown period has passed.");
        } else {
            log('No previous signals for this strategy found, cooldown check skipped.');
        }

        log("--- Generating Signal ---");
        const i = chartData.length - 1; 

        const closes = chartData.map(d => d.close);
        const volumes = chartData.map(d => d.volume);
        const emaFastArr = indicators.calculateEMA(closes, strategyConfig.EMA_FAST_PERIOD);
        const emaSlowArr = indicators.calculateEMA(closes, strategyConfig.EMA_SLOW_PERIOD);
        const emaLongArr = indicators.calculateEMA(closes, strategyConfig.EMA_LONG_PERIOD);
        const rsiArr = indicators.calculateRSI(closes, strategyConfig.RSI_PERIOD);
        const atrArr = indicators.calculateATR(chartData, strategyConfig.ATR_PERIOD);
        const volSmaArr = indicators.calculateSMA(volumes, strategyConfig.VOLUME_PERIOD);
        
        const signalResult = await generateSignal(i, chartData, strategyConfig, emaFastArr, emaSlowArr, emaLongArr, rsiArr, atrArr, volSmaArr);

        if (signalResult.entry) {
            log(`SUCCESS: New signal generated. Side: ${signalResult.side}, Confidence: ${signalResult.confidence.toFixed(2)}`);
            log("--- Saving Signal ---");
            
            const signalToSave: Omit<Signal, 'displayTime' | 'serverTime'> = {
                type: signalResult.side === 'long' ? 'BUY' : 'SELL',
                level: signalResult.confidence > 0.65 ? 'High' : 'Medium',
                price: chartData[i].close,
                time: chartData[i].time,
                confidence: signalResult.confidence,
                strategy: STRATEGY_TYPE,
            };

            await saveSignalToFirestore(signalToSave);
            log('Signal saved successfully.');
            log(`====== CRON JOB END ======`);
            return NextResponse.json({ signal: signalToSave });
        }

        log('No signal generated based on current strategy rules.');
        log(`====== CRON JOB END ======`);
        return NextResponse.json({ message: 'No signal generated.' });

    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log(`CRITICAL: Unhandled error in cron job: ${errorMessage}`, err);
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
