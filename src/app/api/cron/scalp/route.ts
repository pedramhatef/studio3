
import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore, getLatestOptimizationParams } from '@/app/actions';
import type { Signal, StrategyParams, StrategyType } from '@/lib/types';
import { generateSignal } from '@/lib/signal-generator';

const COOLDOWN_HIGH = 1 * 60 * 1000; // 1 minute
const COOLDOWN_MEDIUM = 2 * 60 * 1000; // 2 minutes
const STRATEGY_TYPE: StrategyType = 'Scalp';

export const revalidate = 0;

function logcond(message: string, ...args: any[]) {
    const params = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    console.log(`[Cron-Scalp] ${message}`, params);
}

export async function GET() {
    logcond(`====== CRON JOB START ======`);
    
    let strategyConfig: StrategyParams;

    try {
        logcond("--- Fetching Optimal Parameters ---");
        const latestParams = await getLatestOptimizationParams(STRATEGY_TYPE);
        if (latestParams) {
            strategyConfig = { ...latestParams } as StrategyParams;
            logcond(`Applied optimal parameters from Firestore.`);
        } else {
            logcond(`No optimization results found for ${STRATEGY_TYPE}. Attempting to fall back to 'Day' strategy parameters.`);
            const dayParams = await getLatestOptimizationParams('Day');
            if (dayParams) {
                strategyConfig = { ...dayParams } as StrategyParams;
                 logcond(`Applied FALLBACK 'Day' parameters.`);
            } else {
                logcond(`CRITICAL: No optimization results found for ${STRATEGY_TYPE} or Day. Cannot generate signal.`);
                return NextResponse.json({ message: `No strategy parameters available for ${STRATEGY_TYPE} or fallback.` }, { status: 500 });
            }
        }
    } catch (error) {
        logcond(`CRITICAL: Error fetching optimization results:`, error);
        return NextResponse.json({ message: 'Failed to fetch strategy parameters.' }, { status: 500 });
    }

    try {
        logcond("--- Fetching Chart Data ---");
        const requiredPeriods = Math.max(
            strategyConfig.EMA_SLOW_PERIOD, 
            strategyConfig.RSI_PERIOD, 
            strategyConfig.VOLUME_PERIOD,
            strategyConfig.ATR_PERIOD,
            strategyConfig.EMA_LONG_PERIOD
        ) + 50;

        const chartData = await getChartData('DOGEUSDT', 500);
        logcond(`Fetched ${chartData.length} candles. Required: ${requiredPeriods}.`);

        if (!Array.isArray(chartData) || chartData.length < requiredPeriods) { 
            logcond(`Insufficient data. DOGE=${chartData?.length ?? 0}. Aborting.`);
            return NextResponse.json({ message: 'Not enough data for indicators.' });
        }
        
        logcond("--- Checking Signal Cooldown ---");
        const recentSignals = await getSignalHistoryFromFirestore();
        const lastSignal = recentSignals?.[0] ?? null;

        if (lastSignal?.time && lastSignal.strategy === STRATEGY_TYPE) {
            const lastSignalTime = lastSignal.time;
            const latestCandleTime = chartData[chartData.length - 1].time;
            const timeSinceLastSignalMs = latestCandleTime - lastSignalTime;
            const cooldown = lastSignal.level === 'High' ? COOLDOWN_HIGH : COOLDOWN_MEDIUM;
            const cooldownActive = timeSinceLastSignalMs > 0 && timeSinceLastSignalMs < cooldown;
            
            if (cooldownActive) { 
                logcond(`In trade cooldown. Last signal was ${Math.floor(timeSinceLastSignalMs/1000)}s ago. Aborting.`);
                return NextResponse.json({ message: 'In trade cooldown.' });
            }
            logcond("Cooldown period has passed.");
        } else {
            logcond('No previous signals for this strategy found, cooldown check skipped.');
        }

        logcond("--- Generating Signal ---");
        const i = chartData.length - 1; 

        // Call generateSignal with verbose: true for detailed live logging
        const signalResult = await generateSignal(i, chartData, strategyConfig, STRATEGY_TYPE, true);

        if (signalResult.entry) {
            logcond(`SUCCESS: New signal generated. Side: ${signalResult.side}, Confidence: ${signalResult.confidence.toFixed(2)}`);
            logcond("--- Saving Signal ---");
            
            const signalToSave: Omit<Signal, 'displayTime' | 'serverTime'> = {
                type: signalResult.side === 'long' ? 'BUY' : 'SELL',
                level: signalResult.confidence > 0.65 ? 'High' : 'Medium',
                price: chartData[i].close,
                time: chartData[i].time,
                confidence: signalResult.confidence,
                strategy: STRATEGY_TYPE,
            };

            await saveSignalToFirestore(signalToSave);
            logcond('Signal saved successfully.');
            logcond(`====== CRON JOB END ======`);
            return NextResponse.json({ signal: signalToSave });
        }
        
        logcond('No signal generated based on current strategy rules.');
        logcond(`====== CRON JOB END ======`);
        return NextResponse.json({ message: 'No signal generated.' });

    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        logcond(`CRITICAL: Unhandled error in cron job: ${errorMessage}`, err);
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
