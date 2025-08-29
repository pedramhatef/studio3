import { NextResponse, NextRequest } from 'next/server';
import { runAndSaveOptimization } from '../../../../lib/optimizer';
import type { StrategyType, StrategyParams } from '../../../../lib/types';
import { getChartData } from '@/app/actions';

function capitalizeFirstLetter(string: string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const PARAMETER_RANGES: Record<StrategyType, Record<keyof Omit<StrategyParams, 'leverage'>, number[]>> = {
    Scalp: {
        EMA_FAST_PERIOD: [5, 8, 10],
        EMA_SLOW_PERIOD: [12, 15, 20],
        EMA_LONG_PERIOD: [30, 40, 50],
        RSI_PERIOD: [9, 12, 14],
        RSI_OVERSOLD: [25, 30, 35],
        RSI_OVERBOUGHT: [65, 70, 75],
        VOLUME_PERIOD: [10, 15, 20],
        VOLUME_THRESHOLD_MULTIPLIER: [2.0, 2.5, 3.0],
        ATR_PERIOD: [8, 10, 12],
        ATR_STOP_MULT: [1.0, 1.5, 2.0],
        ATR_TRAIL_MULT: [1.2, 1.6],
        RISK_PCT: [0.005, 0.01],
        TP_R_MULT: [1.5, 2.0, 2.5],
    },
    Day: {
        EMA_FAST_PERIOD: [10, 15, 20],
        EMA_SLOW_PERIOD: [25, 30, 40],
        EMA_LONG_PERIOD: [80, 100, 120],
        RSI_PERIOD: [14, 16],
        RSI_OVERSOLD: [28, 32, 38],
        RSI_OVERBOUGHT: [62, 68, 72],
        VOLUME_PERIOD: [20, 25, 30],
        VOLUME_THRESHOLD_MULTIPLIER: [1.5, 2.0],
        ATR_PERIOD: [14, 16],
        ATR_STOP_MULT: [1.8, 2.5, 3.0],
        ATR_TRAIL_MULT: [2.0, 3.0, 3.5],
        RISK_PCT: [0.01, 0.02],
        TP_R_MULT: [2.0, 3.0, 4.0],
    },
    Swing: {
        EMA_FAST_PERIOD: [20, 30, 40],
        EMA_SLOW_PERIOD: [50, 60, 80],
        EMA_LONG_PERIOD: [150, 200, 250],
        RSI_PERIOD: [18, 22, 25],
        RSI_OVERSOLD: [25, 30],
        RSI_OVERBOUGHT: [70, 75],
        VOLUME_PERIOD: [30, 40, 50],
        VOLUME_THRESHOLD_MULTIPLIER: [1.5, 2.0],
        ATR_PERIOD: [18, 22, 25],
        ATR_STOP_MULT: [2.5, 3.5, 4.5],
        ATR_TRAIL_MULT: [3.0, 4.0, 5.0],
        RISK_PCT: [0.015, 0.025],
        TP_R_MULT: [3.0, 5.0, 6.0],
    },
};

function logcond(message: string, ...args: any[]) {
    const params = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
    console.log(`[API-Route] ${message}`, params);
}

export async function GET(
    _request: NextRequest,
    { params }: { params: { strategy: string } }
) {
    const strategyParam = params.strategy;
    const strategy = capitalizeFirstLetter(strategyParam) as StrategyType;
    const parameterRanges = PARAMETER_RANGES[strategy];

    if (!parameterRanges) {
        return NextResponse.json({ message: `Invalid strategy type: ${strategy}` }, { status: 400 });
    }
    
    // Run the optimization in the background. Don't await it.
    // The request will return immediately, and the optimization will continue processing.
    (async () => {
        try {
            logcond(`Received request to start optimization for strategy: ${strategy}`);
            
            logcond(`[${strategy}] Fetching chart data for optimization...`);
            const chartData = await getChartData('DOGEUSDT', 1000);
            if (!chartData || chartData.length < 500) {
                // This check is important, but getChartData will throw on network failure now.
                console.error(`[API-Route] [${strategy}] Not enough historical data to run optimization. Aborting.`);
                return;
            }
            logcond(`[${strategy}] Fetched ${chartData.length} data points.`);

            await runAndSaveOptimization(strategy, parameterRanges, chartData);
        } catch (err) {
            // This is the critical change. We log the error, but also re-throw it
            // so that Vercel knows the background task has failed.
            console.error(`[API-Route] [${strategy}] CRITICAL: Uncaught error in background optimization task:`, err);
            throw err; // Re-throw the error to ensure the serverless function exits with a failure status.
        }
    })();

    return NextResponse.json({ message: `Strategy optimization for ${strategy} started in the background.` });
}
