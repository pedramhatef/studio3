import { NextResponse, NextRequest } from 'next/server';
import { runAndSaveOptimization } from '../../../../lib/optimizer';
import type { StrategyType, StrategyParams } from '../../../../lib/types';
import { getChartData } from '@/app/actions';

function capitalizeFirstLetter(string: string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const PARAMETER_RANGES: Record<StrategyType, Record<keyof Omit<StrategyParams, 'leverage'>, number[]>> = {
    Scalp: {
        EMA_FAST_PERIOD: [3, 5, 7, 9],
        EMA_SLOW_PERIOD: [10, 12, 15, 20],
        EMA_LONG_PERIOD: [25, 30, 40, 50],
        RSI_PERIOD: [5, 7, 9, 14],
        RSI_OVERSOLD: [20, 25, 30, 35],
        RSI_OVERBOUGHT: [65, 70, 75, 80],
        VOLUME_PERIOD: [15, 20, 30],
        VOLUME_THRESHOLD_MULTIPLIER: [1.0, 1.2, 1.5, 2.0],
        ATR_PERIOD: [7, 10, 14],
        ATR_STOP_MULT: [1.5, 2.0, 2.5],
        ATR_TRAIL_MULT: [1.8, 2.0, 2.2],
        RISK_PCT: [0.005, 0.01],
        TP_R_MULT: [1.5, 2.0, 3.0],
    },
    Day: {
        EMA_FAST_PERIOD: [10, 15, 20, 25],
        EMA_SLOW_PERIOD: [30, 40, 50, 60],
        EMA_LONG_PERIOD: [80, 100, 120, 150],
        RSI_PERIOD: [14, 18, 20],
        RSI_OVERSOLD: [30, 35, 40],
        RSI_OVERBOUGHT: [60, 65, 70],
        VOLUME_PERIOD: [25, 30, 40],
        VOLUME_THRESHOLD_MULTIPLIER: [1.5, 2.0, 2.5],
        ATR_PERIOD: [14, 20, 28],
        ATR_STOP_MULT: [2.0, 2.5, 3.5],
        ATR_TRAIL_MULT: [2.5, 3.0, 4.0],
        RISK_PCT: [0.01, 0.015, 0.02],
        TP_R_MULT: [2.0, 3.0, 5.0],
    },
    Swing: {
        EMA_FAST_PERIOD: [20, 30, 40, 50],
        EMA_SLOW_PERIOD: [60, 75, 100, 120],
        EMA_LONG_PERIOD: [150, 200, 250, 300],
        RSI_PERIOD: [20, 25, 30],
        RSI_OVERSOLD: [35, 40, 45],
        RSI_OVERBOUGHT: [55, 60, 65],
        VOLUME_PERIOD: [40, 50, 60],
        VOLUME_THRESHOLD_MULTIPLIER: [1.8, 2.0, 2.5, 3.0],
        ATR_PERIOD: [20, 30, 40],
        ATR_STOP_MULT: [3.0, 4.0, 5.0],
        ATR_TRAIL_MULT: [3.5, 4.5, 5.5],
        RISK_PCT: [0.01, 0.015],
        TP_R_MULT: [3.0, 5.0, 7.0],
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
            
            logcond(`[${strategy}] Fetched ${chartData.length} data points.`);

            await runAndSaveOptimization(strategy, parameterRanges, chartData);
        } catch (err) {
            console.error(`[API-Route] [${strategy}] CRITICAL: Uncaught error in background optimization task:`, err);
            throw err;
        }
    })();

    return NextResponse.json({ message: `Strategy optimization for ${strategy} started in the background.` });
}
