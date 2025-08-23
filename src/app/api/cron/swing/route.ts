
import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore, getLatestOptimizationParams } from '@/app/actions';
import type { Signal, StrategyParams } from '@/lib/types';
import { generateSignal } from '@/lib/signal-generator';
import * as indicators from '@/lib/indicators';

const COOLDOWN_HIGH = 15 * 60 * 1000; // 15 minutes
const COOLDOWN_MEDIUM = 30 * 60 * 1000; // 30 minutes

export const revalidate = 0;

function log(message: string, ...args: any[]) {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} [info] [Swing] ${message}`, ...args);
}
function section(title: string) {
    log(`=== ${title} ===`);
}
function kv(obj: Record<string, any>) {
    log(JSON.stringify(obj, null, 2));
}

export async function GET() {
    const STRATEGY_TYPE = 'Swing';
    (global as any).ENABLE_DETAILED_LOGS = true;
    let strategyConfig: StrategyParams;

    section(`Fetch Optimal Parameters for ${STRATEGY_TYPE}`);
    try {
        const latestParams = await getLatestOptimizationParams(STRATEGY_TYPE);
        if (latestParams) {
            strategyConfig = { ...latestParams } as StrategyParams;
            log(`Applied optimal ${STRATEGY_TYPE} parameters from Firestore.`);
            kv(strategyConfig);
        } else {
            log(`No optimization results found for ${STRATEGY_TYPE}. Attempting to fall back to 'Day' strategy parameters.`);
            const dayParams = await getLatestOptimizationParams('Day');
            if (dayParams) {
                strategyConfig = { ...dayParams } as StrategyParams;
                 log(`Applied FALLBACK 'Day' parameters.`);
                 kv(strategyConfig);
            } else {
                log(`No optimization results found for ${STRATEGY_TYPE} or Day. Cannot proceed.`);
                (global as any).ENABLE_DETAILED_LOGS = false;
                return NextResponse.json({ message: `No strategy parameters available for ${STRATEGY_TYPE} or fallback.` }, { status: 500 });
            }
        }
    } catch (error) {
        console.error(`Error fetching optimization results:`, error);
        (global as any).ENABLE_DETAILED_LOGS = false;
        return NextResponse.json({ message: 'Failed to fetch strategy.' }, { status: 500 });
    }

    section(`CRON RUN @ ${new Date().toISOString()}`);

    try {
        const requiredPeriods = Math.max(
            strategyConfig.EMA_SLOW_PERIOD, 
            strategyConfig.RSI_PERIOD, 
            strategyConfig.VOLUME_PERIOD,
            strategyConfig.ATR_PERIOD,
            strategyConfig.EMA_LONG_PERIOD
        ) + 50; 

        const chartData = await getChartData('DOGEUSDT', 1000); 

        if (!Array.isArray(chartData) || chartData.length < requiredPeriods) { 
            log(`Insufficient data. DOGE=${chartData?.length ?? 0} Need=${requiredPeriods}`);
            (global as any).ENABLE_DETAILED_LOGS = false;
            return NextResponse.json({ message: 'Not enough data for indicators.' });
        }
        
        const recentSignals = await getSignalHistoryFromFirestore();
        const lastSignal = recentSignals?.[0] ?? null;

        if (lastSignal?.time && lastSignal.strategy === STRATEGY_TYPE) {
            const lastSignalTime = lastSignal.time;
            const latestCandleTime = chartData[chartData.length - 1].time;
            const timeSinceLastSignalMs = latestCandleTime - lastSignalTime;
            const cooldown = lastSignal.level === 'High' ? COOLDOWN_HIGH : COOLDOWN_MEDIUM;
            const cooldownActive = timeSinceLastSignalMs > 0 && timeSinceLastSignalMs < cooldown;
            
            if (cooldownActive) { 
                log(`In trade cooldown for ${STRATEGY_TYPE}. Last signal was ${Math.floor(timeSinceLastSignalMs/1000)}s ago.`);
                (global as any).ENABLE_DETAILED_LOGS = false;
                return NextResponse.json({ message: 'In trade cooldown.' });
            }
        } else {
            log('No previous signals for this strategy found, cooldown check skipped.');
        }

        section('Find New Signal');
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
            section('Saving Signal');
            
            const signalToSave: Omit<Signal, 'displayTime' | 'serverTime'> = {
                type: signalResult.side === 'long' ? 'BUY' : 'SELL',
                level: signalResult.confidence > 0.65 ? 'High' : 'Medium',
                price: chartData[i].close,
                time: chartData[i].time,
                confidence: signalResult.confidence,
                strategy: STRATEGY_TYPE,
            };

            await saveSignalToFirestore(signalToSave);
            log('Signal saved:', signalToSave);
            (global as any).ENABLE_DETAILED_LOGS = false;
            return NextResponse.json({ signal: signalToSave });
        }

        log('No signal generated.');
        (global as any).ENABLE_DETAILED_LOGS = false;
        return NextResponse.json({ message: 'No signal generated.' });

    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`Error in cron job: ${errorMessage}`, err);
        (global as any).ENABLE_DETAILED_LOGS = false;
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
