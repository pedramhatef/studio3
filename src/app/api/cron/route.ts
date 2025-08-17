
import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore, getLatestOptimizationParams } from '@/app/actions';
import type { Signal, StrategyParams, ChartDataPoint } from '@/lib/types'; // Added ChartDataPoint import
import * as indicators from '@/lib/indicators'; 
import { generateSignal } from '@/lib/signal-generator';

interface EnhancedSignal extends Signal {
    suggestedLeverage?: number;
    stopBuffer?: number;
    confidenceScore?: number;
}

const COOLDOWN_HIGH = 3 * 60 * 1000; // 3 minutes
const COOLDOWN_MEDIUM = 5 * 60 * 1000; // 5 minutes

export const revalidate = 0;

function log(message: string, ...args: any[]) {
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} [info] ${message}`, ...args);
}
function section(title: string) {
    log(`=== ${title} ===`);
}
function kv(obj: Record<string, any>) {
    log(JSON.stringify(obj, null, 2));
}

export async function GET() {
    // Set a global flag to enable detailed logging just for this cron run
    (global as any).ENABLE_DETAILED_LOGS = true;

    const ts = new Date().toISOString();
    let strategyConfig: StrategyParams;

    section('Fetch Optimal Parameters');
    try {
        const latestParams = await getLatestOptimizationParams();
        if (latestParams) {
            strategyConfig = { ...latestParams, SPREAD_PERCENT: 0.01 } as StrategyParams;
            log('Applied optimal parameters from Firestore.');
            kv(strategyConfig);
        } else {
            log('No optimization results found. Cannot proceed without strategy.');
            (global as any).ENABLE_DETAILED_LOGS = false;
            return NextResponse.json({ message: 'No strategy parameters available.' }, { status: 500 });
        }
    } catch (error) {
        console.error(`Error fetching optimization results:`, error);
        (global as any).ENABLE_DETAILED_LOGS = false;
        return NextResponse.json({ message: 'Failed to fetch strategy.' }, { status: 500 });
    }

    section(`CRON RUN @ ${ts}`);

    try {
        const requiredPeriods = Math.max(
            strategyConfig.EMA_SLOW_PERIOD, 
            strategyConfig.RSI_PERIOD, 
            strategyConfig.VOLUME_PERIOD,
            strategyConfig.ATR_PERIOD
        ) + 15; // Increased safety buffer

        const dogeChartData = await getChartData('DOGEUSDT');

        if (!Array.isArray(dogeChartData) || dogeChartData.length < requiredPeriods) { 
            log(`Insufficient data. DOGE=${dogeChartData?.length ?? 0} Need=${requiredPeriods}`);
            (global as any).ENABLE_DETAILED_LOGS = false;
            return NextResponse.json({ message: 'Not enough data for indicators.' });
        }
        
        const recentSignals = await getSignalHistoryFromFirestore();
        const lastSignal = recentSignals?.[0] ?? null;

        if (lastSignal) {
            const lastSignalTime = lastSignal.time;
            const latestCandleTime = dogeChartData[dogeChartData.length - 1].time;
            const timeSinceLastSignalMs = latestCandleTime - lastSignalTime;
            const cooldown = lastSignal.level === 'High' ? COOLDOWN_HIGH : COOLDOWN_MEDIUM;
            const cooldownActive = timeSinceLastSignalMs > 0 && timeSinceLastSignalMs < cooldown;
            
            if (cooldownActive) { 
                log(`In trade cooldown. Last signal was ${Math.floor(timeSinceLastSignalMs/1000)}s ago.`);
                (global as any).ENABLE_DETAILED_LOGS = false;
                return NextResponse.json({ message: 'In trade cooldown.' });
            }
        } else {
            log('No previous signals found, cooldown check skipped.');
        }

        section('Find New Signal');
        const i = dogeChartData.length - 1; 

        // Calculate all indicators
        const dogeClose = dogeChartData.map(d => d.close);
        const dogeVolume = dogeChartData.map(d => d.volume);
        const emaFastArr = indicators.calculateEMA(dogeClose, strategyConfig.EMA_FAST_PERIOD);
        const emaSlowArr = indicators.calculateEMA(dogeClose, strategyConfig.EMA_SLOW_PERIOD);
        const rsiArr = indicators.calculateRSI(dogeClose, strategyConfig.RSI_PERIOD);
        const atrArr = indicators.calculateATR(dogeChartData, strategyConfig.ATR_PERIOD);
        const psarArr = indicators.calculateParabolicSAR(dogeChartData, strategyConfig.PARABOLIC_SAR_STEP, strategyConfig.PARABOLIC_SAR_MAX);
        const avgVolumeArr = indicators.calculateSMA(dogeVolume, strategyConfig.VOLUME_PERIOD);
        const volumeRatioArr = dogeVolume.map((v, i) => v / ((indicators.getValueAt(avgVolumeArr, i) ?? 1)));
        const volumeMultiplier = indicators.calculateSMA(volumeRatioArr, 5);
        
        const signal = generateSignal(i, dogeChartData, strategyConfig, emaFastArr, emaSlowArr, rsiArr, psarArr, avgVolumeArr, atrArr, volumeMultiplier);

        if (signal) {
            section('Saving Signal');
            const atrValue = indicators.getValueAt(atrArr, i-1) ?? 0;
            const capital = 1000;
            const dollarRisk = capital * (atrValue > 0.0005 ? 0.0075 : 0.0125);
            const positionSize = dollarRisk / (atrValue * strategyConfig.STOP_LOSS_ATR_MULTIPLIER);
            const leverage = Math.min(10, Math.max(1, Math.round((positionSize * signal.price) / capital)));
            
            const enhancedSignal: EnhancedSignal = {
                ...signal,
                suggestedLeverage: leverage,
                stopBuffer: atrValue * strategyConfig.STOP_LOSS_ATR_MULTIPLIER,
                confidenceScore: signal.level === 'High' ? 0.85 : 0.65
            };

            await saveSignalToFirestore(enhancedSignal);
            log('Signal saved:', enhancedSignal);
            (global as any).ENABLE_DETAILED_LOGS = false;
            return NextResponse.json({ signal: enhancedSignal });
        }

        (global as any).ENABLE_DETAILED_LOGS = false;
        return NextResponse.json({ message: 'No signal generated.' });

    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`Error in cron job: ${errorMessage}`);
        (global as any).ENABLE_DETAILED_LOGS = false;
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}
