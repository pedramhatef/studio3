
'use server';

import { NextResponse, NextRequest } from 'next/server';
import { runAndSaveOptimization } from '../../../../lib/optimizer';
import type { StrategyType } from '../../../../lib/types';

function capitalizeFirstLetter(string: string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

export async function GET(
    request: NextRequest,
    { params }: { params: { strategy: string } }
) {
    const strategyParam = params.strategy;
    const strategy = capitalizeFirstLetter(strategyParam) as StrategyType;

    // Run the optimization in the background. Don't await it.
    // The request will return immediately, and the optimization will continue processing.
    runAndSaveOptimization(strategy).catch(err => {
        console.error(`[Optimization Task Error] Failed to run optimization for ${strategy}:`, err);
    });

    return NextResponse.json({ message: `Strategy optimization for ${strategy} started in the background.` });
}
