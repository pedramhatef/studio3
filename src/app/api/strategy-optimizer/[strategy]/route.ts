import { NextResponse, NextRequest } from 'next/server';
import { runAndSaveOptimization } from '../../../../lib/optimizer';
import type { StrategyType, StrategyParams } from '../../../../lib/types';
import { getChartData } from '@/app/actions';

function capitalizeFirstLetter(string: string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const PARAMETER_RANGES: Record<StrategyType, Record<keyof Omit<StrategyParams, 'leverage'>, number[]>> = {
    Scalp: {
        EMA_FAST_PERIOD: [3, 5, 7, 9, 12],
        EMA_SLOW_PERIOD: [9, 12, 15, 18],
        EMA_LONG_PERIOD: [3, 21, 34],
        RSI_PERIOD: [5, 7, 9, 14],
        RSI_OVERSOLD: [20, 25, 30],
        RSI_OVERBOUGHT: [70, 75, 80],
        VOLUME_PERIOD: [15, 20, 30],
        VOLUME_THRESHOLD_MULTIPLIER: [1.0, 1.2, 1.5, 2.0],
        ATR_PERIOD: [7, 10, 14],
        ATR_STOP_MULT: [1.5, 2, 2.5],
        ATR_TRAIL_MULT: [1.8, 2.0],
        RISK_PCT: [0.005, 0.01],
        TP_R_MULT: [1.3, 2.0, 2.7],
    },
    Day: {
        EMA_FAST_PERIOD: [10, 15, 20, 25],        // slower than scalp but still responsive
        EMA_SLOW_PERIOD: [30, 40, 50, 60],        // smoother trend detection
        EMA_LONG_PERIOD: [80, 100, 120, 150, 200],// extended horizon for day context
        RSI_PERIOD: [14, 18, 20],                 // longer RSI for stability
        RSI_OVERSOLD: [30, 35, 40],               // tighter for day-trend reversals
        RSI_OVERBOUGHT: [60, 65, 70],             // softer to catch trend exhaustion
        VOLUME_PERIOD: [25, 30, 40],              // longer volume lookback
        VOLUME_THRESHOLD_MULTIPLIER: [1.5, 2.0, 2.5], // stronger confirmation
        ATR_PERIOD: [14, 20, 28],                 // slower ATR for day swings
        ATR_STOP_MULT: [2.0, 2.5, 3.5],           // wider stops for volatility
        ATR_TRAIL_MULT: [2.5, 3.0, 4.0],          // trail looser, fit swing
        RISK_PCT: [0.01, 0.015, 0.02],            // slightly adjustable risk
        TP_R_MULT: [2.0, 3.0, 5.0],               // bigger targets for day moves
    },
    
    Swing: {
        EMA_FAST_PERIOD: [20, 30, 40],              // fast for swing is still relatively slow
        EMA_SLOW_PERIOD: [50, 75, 100],             // medium-term trend anchor
        EMA_LONG_PERIOD: [150, 200, 250, 300],      // long horizon, trend backbone
        RSI_PERIOD: [20, 25, 30],                   // much smoother RSI
        RSI_OVERSOLD: [35, 40, 45],                 // softer thresholds for strong swings
        RSI_OVERBOUGHT: [55, 60, 65],               // allow long trends to run
        VOLUME_PERIOD: [40, 50, 60],                // slower accumulation/distribution
        VOLUME_THRESHOLD_MULTIPLIER: [1.8, 2.0, 2.5, 3.0], // strong confirmation needed
        ATR_PERIOD: [20, 30, 40],                   // smooths volatility across days
        ATR_STOP_MULT: [3.0, 4.0, 5.0],             // wider stops for big swings
        ATR_TRAIL_MULT: [3.5, 4.0, 5.5],            // wide trailing to not cut early
        RISK_PCT: [0.01, 0.015],                    // controlled risk (can pyramid entries)
        TP_R_MULT: [3.0, 5.0, 7.0],                 // bigger R targets for multi-day holds
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
