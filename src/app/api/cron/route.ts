
import { NextResponse } from 'next/server';
import { getChartData, saveSignalToFirestore, getSignalHistoryFromFirestore, getLatestOptimizationParams } from '@/app/actions';
import type { Signal, StrategyParams, ChartDataPoint } from '@/lib/types'; // Added ChartDataPoint import
import * as indicators from '@/lib/indicators'; 

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
function logCond(name: string, passed: boolean, details?: string) {
    log(`${passed ? '✔' : '✘'} ${name}${details ? ` → ${details}` : ''}`);
}

type CacheType = {
    emaFast: number | null;
    emaSlow: number | null;
    rsi: number | null;
    psar: number | null;
    volume: number | null;
    avgVolume: number | null;
    atr: number | null;
    volMultiplier: number | null;
};

// This is a type guard. If it returns true, TypeScript knows that all properties of `cache` are numbers.
function allIndicatorsValid(cache: CacheType): cache is Required<CacheType> {
    return (
        cache.emaFast !== null &&
        cache.emaSlow !== null &&
        cache.rsi !== null &&
        cache.psar !== null &&
        cache.volume !== null &&
        cache.avgVolume !== null &&
        cache.atr !== null &&
        cache.volMultiplier !== null
    );
}

function isCandleBullish(candle: ChartDataPoint) {
    return candle.close > candle.open;
}

function isCandleBearish(candle: ChartDataPoint) {
    return candle.close < candle.open;
}

function candleStrength(candle: ChartDataPoint) {
    const range = candle.high - candle.low;
    return range > 0 ? Math.abs(candle.close - candle.open) / range : 0;
}

export async function GET() {
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
            return NextResponse.json({ message: 'No strategy parameters available.' }, { status: 500 });
        }
    } catch (error) {
        console.error(`Error fetching optimization results:`, error);
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
            return NextResponse.json({ message: 'Not enough data for indicators.' });
        }
        
        const recentSignals = await getSignalHistoryFromFirestore();
        const lastSignal = recentSignals?.[0] ?? null;

        if (lastSignal) {
            const lastSignalTime = lastSignal.time;
            const latestCandleTime = dogeChartData[dogeChartData.length - 1].time;
            const timeSinceLastSignalMs = latestCandleTime - lastSignalTime;
            const cooldown = lastSignal.level === 'High' ? COOLDOWN_HIGH : COOLDOWN_MEDIUM;
            
            if (timeSinceLastSignalMs > 0 && timeSinceLastSignalMs < cooldown) { 
                log(`Cooldown active (${Math.floor(cooldown/60000)}min). Skipping signal.`);
                return NextResponse.json({ message: 'In trade cooldown.' });
            }
        }

        section('Find New Signal');
        const dogeClose = dogeChartData.map(d => d.close);
        const dogeVolume = dogeChartData.map(d => d.volume);

        const emaFastArr = indicators.calculateEMA(dogeClose, strategyConfig.EMA_FAST_PERIOD);
        const emaSlowArr = indicators.calculateEMA(dogeClose, strategyConfig.EMA_SLOW_PERIOD);
        const rsiArr = indicators.calculateRSI(dogeClose, strategyConfig.RSI_PERIOD);
        const atrArr = indicators.calculateATR(dogeChartData, strategyConfig.ATR_PERIOD);
        const psarArr = indicators.calculateParabolicSAR(dogeChartData, strategyConfig.PARABOLIC_SAR_STEP, strategyConfig.PARABOLIC_SAR_MAX);
        const avgVolumeArr = indicators.calculateSMA(dogeVolume, strategyConfig.VOLUME_PERIOD);
        const volumeRatioArr = dogeVolume.map((v, i) => 
            v / (indicators.getValueAt(avgVolumeArr, i) || 1
        ));
        const volumeMultiplier = indicators.calculateSMA(volumeRatioArr, 5);
        
        const i = dogeChartData.length - 1; 
        const prev_i = i - 1; 

        const latestCandle = dogeChartData[i];
        const prevCandle = dogeChartData[prev_i];

        log('Evaluating signal on previous candle:', {
            time: new Date(prevCandle.time).toISOString(),
            close: prevCandle.close.toFixed(6),
        });

        const cache: CacheType = {
            emaFast: indicators.getValueAt(emaFastArr, prev_i),
            emaSlow: indicators.getValueAt(emaSlowArr, prev_i),
            rsi: indicators.getValueAt(rsiArr, prev_i),
            psar: indicators.getValueAt(psarArr, prev_i),
            volume: dogeVolume[prev_i],
            avgVolume: indicators.getValueAt(avgVolumeArr, prev_i),
            atr: indicators.getValueAt(atrArr, prev_i),
            volMultiplier: indicators.getValueAt(volumeMultiplier, prev_i)
        };
        
        if (allIndicatorsValid(cache)) {
            // All cache values are guaranteed to be numbers here
            const { emaFast, emaSlow, rsi, psar, volume, avgVolume, atr } = cache;

            const emaFastPrev = indicators.getValueAt(emaFastArr, prev_i - 1);
            const emaSlowPrev = indicators.getValueAt(emaSlowArr, prev_i - 1);

            let signal: Omit<EnhancedSignal, 'displayTime' | 'serverTime'> | null = null;
            let confidence: Signal['level'] | null = null;

            const emaCrossedUp = (emaFastPrev ?? 0) <= (emaSlowPrev ?? 0) && emaFast > emaSlow;
            const emaCrossedDown = (emaFastPrev ?? 0) >= (emaSlowPrev ?? 0) && emaFast < emaSlow;

            const volumeConditionHigh = volume > (avgVolume * strategyConfig.VOLUME_THRESHOLD_MULTIPLIER);
            const volumeConditionMedium = volume > (avgVolume * strategyConfig.VOLUME_THRESHOLD_MULTIPLIERConfirmation);
            
            section('Signal Conditions');
            logCond('EMA Fast > Slow', emaFast > emaSlow, `Fast: ${emaFast.toFixed(5)} > Slow: ${emaSlow.toFixed(5)}`);
            logCond('EMA Fast < Slow', emaFast < emaSlow, `Fast: ${emaFast.toFixed(5)} < Slow: ${emaSlow.toFixed(5)}`);
            logCond('RSI Buy Range', rsi < strategyConfig.RSI_OVERBOUGHT_THRESHOLD, `RSI: ${rsi.toFixed(2)} < ${strategyConfig.RSI_OVERBOUGHT_THRESHOLD}`);
            logCond('RSI Sell Range', rsi > strategyConfig.RSI_OVERSOLD_THRESHOLD, `RSI: ${rsi.toFixed(2)} > ${strategyConfig.RSI_OVERSOLD_THRESHOLD}`);
            logCond('PSAR Buy Confirmation', psar < prevCandle.close, `PSAR: ${psar.toFixed(5)} < Close: ${prevCandle.close.toFixed(5)}`);
            logCond('PSAR Sell Confirmation', psar > prevCandle.close, `PSAR: ${psar.toFixed(5)} > Close: ${prevCandle.close.toFixed(5)}`);
            logCond('Volume Confirmation (High)', volumeConditionHigh, `Vol ${volume.toFixed(2)} > AvgVol*Multiplier (${(avgVolume * strategyConfig.VOLUME_THRESHOLD_MULTIPLIER).toFixed(2)})`);
            logCond('Volume Confirmation (Medium)', volumeConditionMedium, `Vol ${volume.toFixed(2)} > AvgVol*Multiplier (${(avgVolume * strategyConfig.VOLUME_THRESHOLD_MULTIPLIERConfirmation).toFixed(2)})`);
            logCond('EMA Crossover Up', emaCrossedUp, `Prev Fast: ${(emaFastPrev ?? 0)?.toFixed(5)} <= Prev Slow: ${(emaSlowPrev ?? 0)?.toFixed(5)} AND Curr Fast: ${emaFast.toFixed(5)} > Curr Slow: ${emaSlow.toFixed(5)}`);
            logCond('EMA Crossover Down', emaCrossedDown, `Prev Fast: ${(emaFastPrev ?? 0)?.toFixed(5)} >= Prev Slow: ${(emaSlowPrev ?? 0)?.toFixed(5)} AND Curr Fast: ${emaFast.toFixed(5)} < Curr Slow: ${emaSlow.toFixed(5)}`);
            
            // High-Confidence Crossover Logic
            if (emaCrossedUp && rsi < strategyConfig.RSI_OVERBOUGHT_THRESHOLD && psar < prevCandle.close) {
                if (volumeConditionHigh) {
                    confidence = 'High';
                    signal = { type: 'BUY', level: confidence, price: latestCandle.open, time: latestCandle.time };
                }
            } 
            else if (emaCrossedDown && rsi > strategyConfig.RSI_OVERSOLD_THRESHOLD && psar > prevCandle.close) {
                if (volumeConditionHigh) {
                    confidence = 'High';
                    signal = { type: 'SELL', level: confidence, price: latestCandle.open, time: latestCandle.time };
                }
            }
            // Medium-Confidence Pullback Logic
            else {
                const prevPrevCandle = dogeChartData[prev_i - 1];

                const isPullbackBuy = emaFast > emaSlow && prevPrevCandle.low <= emaSlow && prevCandle.close > emaSlow;
                logCond('Pullback Buy Condition', isPullbackBuy, `Fast > Slow AND PrevPrevLow (${prevPrevCandle.low.toFixed(5)}) <= SlowEMA (${emaSlow.toFixed(5)}) AND PrevClose (${prevCandle.close.toFixed(5)}) > SlowEMA (${emaSlow.toFixed(5)})`);
                
                const rsiOkForBuyPullback = rsi > 40 && rsi < strategyConfig.RSI_OVERBOUGHT_THRESHOLD;
                logCond('Pullback Buy RSI Range', rsiOkForBuyPullback, `40 < RSI (${rsi.toFixed(2)}) < ${strategyConfig.RSI_OVERBOUGHT_THRESHOLD}`);
                
                if (isPullbackBuy && rsiOkForBuyPullback && psar < prevCandle.close && volumeConditionMedium) {
                    confidence = 'Medium';
                    signal = { type: 'BUY', level: confidence, price: latestCandle.open, time: latestCandle.time };
                }
                
                const isPullbackSell = emaFast < emaSlow && prevPrevCandle.high >= emaSlow && prevCandle.close < emaSlow;
                logCond('Pullback Sell Condition', isPullbackSell, `Fast < Slow AND PrevPrevHigh (${prevPrevCandle.high.toFixed(5)}) >= SlowEMA (${emaSlow.toFixed(5)}) AND PrevClose (${prevCandle.close.toFixed(5)}) < SlowEMA (${emaSlow.toFixed(5)})`);

                const rsiOkForSellPullback = rsi < 60 && rsi > strategyConfig.RSI_OVERSOLD_THRESHOLD;
                logCond('Pullback Sell RSI Range', rsiOkForSellPullback, `${strategyConfig.RSI_OVERSOLD_THRESHOLD} < RSI (${rsi.toFixed(2)}) < 60`);

                if (isPullbackSell && rsiOkForSellPullback && psar > prevCandle.close && volumeConditionMedium) {
                    confidence = 'Medium';
                    signal = { type: 'SELL', level: confidence, price: latestCandle.open, time: latestCandle.time };
                }
            }

            // Validation for any generated signal
            if (signal) {
                section('Signal Validation');
                
                const minPriceMovement = atr * strategyConfig.NOISE_FILTER_RATIO;
                const priceChange = Math.abs(latestCandle.open - prevCandle.close);
                const atrFilterPassed = priceChange >= minPriceMovement;
                logCond('ATR Noise Filter', atrFilterPassed, `Change: ${priceChange.toFixed(6)} >= Min Move: ${minPriceMovement.toFixed(6)}`);

                const isBullishConfirm = isCandleBullish(latestCandle) && candleStrength(latestCandle) > 0.3;
                const isBearishConfirm = isCandleBearish(latestCandle) && candleStrength(latestCandle) > 0.3;
                    
                logCond('Bullish Confirm Candle', isBullishConfirm, `Curr Close ${latestCandle.close.toFixed(5)} > Curr Open ${latestCandle.open.toFixed(5)} AND Strength ${candleStrength(latestCandle).toFixed(2)} > 0.3`);
                logCond('Bearish Confirm Candle', isBearishConfirm, `Curr Close ${latestCandle.close.toFixed(5)} < Curr Open ${latestCandle.open.toFixed(5)} AND Strength ${candleStrength(latestCandle).toFixed(2)} > 0.3`);

                if ((signal.type === 'BUY' && !isBullishConfirm) || 
                    (signal.type === 'SELL' && !isBearishConfirm) || 
                    !atrFilterPassed) {
                    log(`Signal rejected: ${!atrFilterPassed ? 'ATR filter failed' : 'Missing confirmation candle'}`);
                    signal = null; // Invalidate signal
                }
            }

            // Saving the validated signal
            if (signal && confidence) {
                section('Saving Signal');
                const capital = 1000;
                const dollarRisk = capital * (atr > 0.0005 ? 0.0075 : 0.0125);
                const positionSize = dollarRisk / (atr * strategyConfig.STOP_LOSS_ATR_MULTIPLIER);
                const leverage = Math.min(10, Math.max(1, Math.round((positionSize * latestCandle.open) / capital)));
                
                const enhancedSignal: EnhancedSignal = {
                    ...signal,
                    level: confidence,
                    suggestedLeverage: leverage,
                    stopBuffer: atr * strategyConfig.STOP_LOSS_ATR_MULTIPLIER,
                    confidenceScore: confidence === 'High' ? 0.85 : 0.65
                };

                await saveSignalToFirestore(enhancedSignal);
                log('Signal saved:', enhancedSignal);
                return NextResponse.json({ signal: enhancedSignal });
            }

            log('No valid signal generated.');
            return NextResponse.json({ message: 'No signal generated.' });

        } else {
            log('Indicator calculation incomplete on previous candle:', cache);
            return NextResponse.json({ message: 'Indicator calculation failed.' });
        }

    } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${errorMessage}`);
        return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
}

    