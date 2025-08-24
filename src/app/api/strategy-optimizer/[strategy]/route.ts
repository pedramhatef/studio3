import { NextResponse, NextRequest } from 'next/server';
import { runAndSaveOptimization } from '../../../../lib/optimizer';
import type { StrategyParams, StrategyType } from '../../../../lib/types';

export const PARAMETER_RANGES: Record<StrategyType, Record<keyof Omit<StrategyParams, 'leverage'>, number[]>> = {
    Scalp: {
        EMA_FAST_PERIOD: [5, 6, 7, 8, 9, 10],
        EMA_SLOW_PERIOD: [11, 12, 13, 14, 15, 16, 18, 20],
        EMA_LONG_PERIOD: [30, 35, 40, 45, 50],
        RSI_PERIOD: [8, 9, 10, 11, 12, 13],
        RSI_OVERSOLD: [20, 25, 28, 30, 32],
        RSI_OVERBOUGHT: [68, 70, 72, 75, 80],
        VOLUME_PERIOD: [10, 12, 15, 18, 20],
        VOLUME_THRESHOLD_MULTIPLIER: [1.8, 2.0, 2.2, 2.5, 3.0, 3.5],
        ATR_PERIOD: [8, 9, 10, 11, 12],
        ATR_STOP_MULT: [0.8, 1.0, 1.2, 1.4, 1.6],
        ATR_TRAIL_MULT: [1.0, 1.2, 1.5, 1.8],
        RISK_PCT: [0.005, 0.0075, 0.01],
        TP_R_MULT: [1.2, 1.5, 1.8, 2.0, 2.2],
    },
    Day: {
        EMA_FAST_PERIOD: [10, 12, 15, 18, 20],
        EMA_SLOW_PERIOD: [22, 25, 30, 35, 40],
        EMA_LONG_PERIOD: [80, 90, 100, 110, 120],
        RSI_PERIOD: [13, 14, 15, 16, 18],
        RSI_OVERSOLD: [28, 30, 32, 35, 38],
        RSI_OVERBOUGHT: [62, 65, 68, 70, 72],
        VOLUME_PERIOD: [20, 22, 25, 30],
        VOLUME_THRESHOLD_MULTIPLIER: [1.5, 1.8, 2.0, 2.2],
        ATR_PERIOD: [13, 14, 15, 16, 18],
        ATR_STOP_MULT: [1.5, 1.8, 2.0, 2.5, 3.0],
        ATR_TRAIL_MULT: [2.0, 2.5, 3.0, 3.5],
        RISK_PCT: [0.01, 0.015, 0.02],
        TP_R_MULT: [2.0, 2.5, 3.0, 3.5, 4.0],
    },
    Swing: {
        EMA_FAST_PERIOD: [20, 25, 30, 35, 40],
        EMA_SLOW_PERIOD: [45, 50, 60, 70, 80],
        EMA_LONG_PERIOD: [150, 180, 200, 220, 250],
        RSI_PERIOD: [18, 20, 22, 25],
        RSI_OVERSOLD: [25, 28, 30, 33],
        RSI_OVERBOUGHT: [67, 70, 72, 75],
        VOLUME_PERIOD: [30, 35, 40, 50],
        VOLUME_THRESHOLD_MULTIPLIER: [1.2, 1.5, 1.8, 2.0],
        ATR_PERIOD: [18, 20, 22, 25],
        ATR_STOP_MULT: [2.5, 3.0, 3.5, 4.0, 4.5],
        ATR_TRAIL_MULT: [3.0, 3.5, 4.0, 5.0],
        RISK_PCT: [0.015, 0.02, 0.025],
        TP_R_MULT: [3.0, 4.0, 5.0, 6.0],
    },
};

function capitalizeFirstLetter(string: string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

export async function GET(
    _request: NextRequest,
    { params }: { params: { strategy: string } }
) {
    const strategyParam = params.strategy;
    const strategy = capitalizeFirstLetter(strategyParam) as StrategyType;

    if (!Object.keys(PARAMETER_RANGES).includes(strategy)) {
        return NextResponse.json({ message: `Invalid strategy type: ${strategy}` }, { status: 400 });
    }

    const parameterRanges = PARAMETER_RANGES[strategy];

    // Run the optimization in the background. Don't await it.
    // The request will return immediately, and the optimization will continue processing.
    runAndSaveOptimization(strategy, parameterRanges).catch(err => {
        console.error(`[Optimization Task Error] Failed to run optimization for ${strategy}:`, err);
    });

    return NextResponse.json({ message: `Strategy optimization for ${strategy} started in the background.` });
}
