import { NextResponse, NextRequest } from 'next/server';
import { runAndSaveOptimization } from '../../../../lib/optimizer';
import type { StrategyParams, StrategyType } from '../../../../lib/types';
import { PARAMETER_RANGES } from '@/lib/backtesting';

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
    
    console.log(`[API] Received request to start optimization for strategy: ${strategy}`);

    // Run the optimization in the background. Don't await it.
    // The request will return immediately, and the optimization will continue processing.
    runAndSaveOptimization(strategy, parameterRanges).catch(err => {
        console.error(`[API] Uncaught error in background optimization task for ${strategy}:`, err);
    });

    return NextResponse.json({ message: `Strategy optimization for ${strategy} started in the background.` });
}
