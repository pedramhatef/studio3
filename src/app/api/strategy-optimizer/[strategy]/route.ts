import { NextResponse, NextRequest } from 'next/server';
import { runAndSaveOptimization } from '../../../../lib/optimizer';
import type { StrategyType } from '../../../../lib/types';
import { PARAMETER_RANGES } from '../../../../lib/backtesting';

function capitalizeFirstLetter(string: string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

export async function GET(
    request: NextRequest,
    { params }: { params: { strategy: string } }
) {
    const strategyParam = params.strategy;
    const strategy = capitalizeFirstLetter(strategyParam) as StrategyType;

    if (!PARAMETER_RANGES[strategy]) {
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
