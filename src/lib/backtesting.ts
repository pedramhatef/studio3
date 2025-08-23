
'use server';

import type { ChartDataPoint, StrategyParams, TradeResult, InTradeState, PerformanceMetrics, BacktestResult, SignalResult, StrategyType } from './types';
import * as indicators from './indicators';
import { generateSignal } from './signal-generator';

const INITIAL_BALANCE = 1000;

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

export async function runBacktest(candles: ChartDataPoint[], params: StrategyParams): Promise<BacktestResult> {
    const trades: TradeResult[] = [];
    let balance = INITIAL_BALANCE;
    let equity = INITIAL_BALANCE;
    let position: InTradeState | null = null;
    let cooldown = 0;

    const requiredPeriods = Math.max(
        params.EMA_SLOW_PERIOD, 
        params.RSI_PERIOD, 
        params.ATR_PERIOD, 
        params.VOLUME_PERIOD, 
        params.EMA_LONG_PERIOD
    ) + 50;
    
    if (candles.length < requiredPeriods) {
        console.warn(`Not enough data for backtest. Need ${requiredPeriods}, got ${candles.length}`);
        return { trades: [], metrics: {} as PerformanceMetrics, params, initialBalance: INITIAL_BALANCE };
    }

    // Pre-calculate all indicators
    const closes = candles.map(c => c.close);
    const volumes = candles.map(c => c.volume);
    const emaFastArr = indicators.calculateEMA(closes, params.EMA_FAST_PERIOD);
    const emaSlowArr = indicators.calculateEMA(closes, params.EMA_SLOW_PERIOD);
    const emaLongArr = indicators.calculateEMA(closes, params.EMA_LONG_PERIOD);
    const rsiArr = indicators.calculateRSI(closes, params.RSI_PERIOD);
    const atrArr = indicators.calculateATR(candles, params.ATR_PERIOD);
    const volSmaArr = indicators.calculateSMA(volumes, params.VOLUME_PERIOD);
    
    for (let i = requiredPeriods; i < candles.length; i++) {
        if (cooldown > 0) {
            cooldown--;
            continue;
        }

        const candle = candles[i];
        
        // --- EXIT LOGIC ---
        if (position) {
            const currentPrice = candle.close;
            const pnl = position.side === 'long' 
                ? (currentPrice - position.entryPrice) * position.qty 
                : (position.entryPrice - currentPrice) * position.qty;
            equity = balance + pnl;

            // ATR Trailing Stop Loss
            const atrValue = indicators.getValueAt(atrArr, i) ?? 0;
            if (position.side === 'long') {
                position.stopLossPrice = Math.max(position.stopLossPrice, currentPrice - atrValue * params.ATR_TRAIL_MULT);
            } else {
                position.stopLossPrice = Math.min(position.stopLossPrice, currentPrice + atrValue * params.ATR_TRAIL_MULT);
            }

            const hitStop = (position.side === 'long' && candle.low <= position.stopLossPrice) || (position.side === 'short' && candle.high >= position.stopLossPrice);
            const hitTP = (position.side === 'long' && candle.high >= position.takeProfitPrice) || (position.side === 'short' && candle.low <= position.takeProfitPrice);
            
            const signal = await generateSignal(i, candles, params, emaFastArr, emaSlowArr, emaLongArr, rsiArr, atrArr, volSmaArr);
            const signalExit = signal.exit && ((position.side === 'long' && signal.side !== 'long') || (position.side === 'short' && signal.side !== 'short'));

            if (hitStop || hitTP || signalExit) {
                let exitPrice: number;
                let reason: TradeResult['reason'];

                if (hitStop) {
                    exitPrice = position.stopLossPrice;
                    reason = 'stop-loss';
                } else if (hitTP) {
                    exitPrice = position.takeProfitPrice;
                    reason = 'take-profit';
                } else {
                    exitPrice = candle.close;
                    reason = signal.exitReason || 'signal';
                }
                
                const finalPnl = position.side === 'long' 
                    ? (exitPrice - position.entryPrice) * position.qty 
                    : (position.entryPrice - exitPrice) * position.qty;

                balance += finalPnl;

                trades.push({
                    side: position.side,
                    entryPrice: position.entryPrice,
                    exitPrice: exitPrice,
                    qty: position.qty,
                    pnl: finalPnl,
                    entryTime: position.entryTime,
                    exitTime: candle.time,
                    reason: reason,
                });

                position = null;
                cooldown = 3; // 3-bar cooldown
            }
        }
        
        // --- ENTRY LOGIC ---
        if (!position) {
            const signal = await generateSignal(i, candles, params, emaFastArr, emaSlowArr, emaLongArr, rsiArr, atrArr, volSmaArr);
            if (signal.entry && signal.side) {
                const atrValue = indicators.getValueAt(atrArr, i) ?? 0;
                if (atrValue === 0) continue;

                const entryPrice = candle.close;
                const stopLossDist = atrValue * params.ATR_STOP_MULT;
                
                const riskAmount = balance * params.RISK_PCT;
                const positionSize = riskAmount / stopLossDist;
                const qty = positionSize;


                const stopLossPrice = signal.side === 'long' ? entryPrice - stopLossDist : entryPrice + stopLossDist;
                const takeProfitPrice = signal.side === 'long' ? entryPrice + (stopLossDist * params.TP_R_MULT) : entryPrice - (stopLossDist * params.TP_R_MULT);

                position = {
                    side: signal.side,
                    entryPrice: entryPrice,
                    qty: qty,
                    entryTime: candle.time,
                    stopLossPrice: stopLossPrice,
                    takeProfitPrice: takeProfitPrice
                };
            }
        }
    }

    const metrics = await calculatePerformanceMetrics(trades, INITIAL_BALANCE);
    return { trades, metrics, params, initialBalance: INITIAL_BALANCE };
}


export async function calculatePerformanceMetrics(trades: TradeResult[], initialBalance: number): Promise<PerformanceMetrics> {
    let wins = 0, losses = 0, grossProfit = 0, grossLoss = 0, balance = initialBalance, peak = initialBalance, maxDrawdown = 0;
    const returns: number[] = [];

    for (const t of trades) {
        balance += t.pnl;
        peak = Math.max(peak, balance);
        maxDrawdown = Math.max(maxDrawdown, peak - balance);

        if (t.pnl >= 0) {
            wins++;
            grossProfit += t.pnl;
        } else {
            losses++;
            grossLoss += Math.abs(t.pnl);
        }
        returns.push(t.pnl / initialBalance);
    }

    const totalTrades = trades.length;
    if (totalTrades === 0) {
        return {
            wins: 0, losses: 0, winRate: 0, netProfit: 0, maxDrawdown: 0, profitFactor: 0, sharpe: 0,
            averageWin: 0, averageLoss: 0, numberOfTrades: 0, totalProfitPercentage: 0
        };
    }
    
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const netProfit = balance - initialBalance;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : Infinity;

    const avgReturn = returns.reduce((a, b) => a + b, 0) / totalTrades;
    const stdDev = Math.sqrt(returns.map(x => Math.pow(x - avgReturn, 2)).reduce((a, b) => a + b, 0) / totalTrades);
    const sharpe = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252 * (1440/1)) : 0; // Annualized for 1-min data

    return {
        wins,
        losses,
        winRate,
        netProfit,
        maxDrawdown,
        profitFactor: isFinite(profitFactor) ? profitFactor : 0,
        sharpe: isNaN(sharpe) ? 0 : sharpe,
        averageWin: wins > 0 ? grossProfit / wins : 0,
        averageLoss: losses > 0 ? grossLoss / losses : 0,
        numberOfTrades: totalTrades,
        totalProfitPercentage: (netProfit / initialBalance) * 100
    };
}


export async function scoreMetrics(metrics: PerformanceMetrics): Promise<number> {
    if (!metrics || metrics.numberOfTrades < 10) {
        return -1; // Heavily penalize strategies with too few trades
    }

    // Normalize components to a similar scale
    const sharpeComponent = (metrics.sharpe || 0); // Sharpe can be negative
    const profitFactorComponent = Math.log1p(metrics.profitFactor || 0); // Log transform to handle large values
    const winRateComponent = metrics.winRate || 0;
    const drawdownComponent = Math.exp(-(metrics.maxDrawdown / 1000)); // Exponential penalty for drawdown
    const profitComponent = Math.tanh((metrics.netProfit / 1000)); // Use tanh to bound the profit influence

    // Weighted score
    const score =
        profitComponent * 0.3 +
        sharpeComponent * 0.3 +
        profitFactorComponent * 0.2 +
        winRateComponent * 0.1 +
        drawdownComponent * 0.1;
    
    return isNaN(score) ? -1 : score;
}
