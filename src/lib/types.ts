
export interface ChartDataPoint {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Signal {
  type: 'BUY' | 'SELL';
  level: 'High' | 'Medium';
  price: number;
  time: number;
  strategy: StrategyType;
  confidence: number;
  displayTime?: string;
  serverTime?: any;
}

export type StrategyType = 'Scalp' | 'Day' | 'Swing';
export type MarketRegime = 'trending_up' | 'trending_down' | 'ranging';

export interface StrategyParams {
    EMA_FAST_PERIOD: number;
    EMA_SLOW_PERIOD: number;
    EMA_LONG_PERIOD: number;
    RSI_PERIOD: number;
    RSI_OVERSOLD: number;
    RSI_OVERBOUGHT: number;
    ATR_PERIOD: number;
    ATR_STOP_MULT: number;
    ATR_TRAIL_MULT: number;
    VOLUME_PERIOD: number;
    VOLUME_THRESHOLD_MULTIPLIER: number;
    RISK_PCT: number;
    TP_R_MULT: number; // Take-Profit as a multiple of Risk (R)
    leverage: number;
}

export interface InTradeState {
    side: 'long' | 'short';
    entryPrice: number;
    qty: number;
    entryTime: number;
    stopLossPrice: number;
    takeProfitPrice: number;
}

export interface TradeResult {
    side: 'long' | 'short';
    entryPrice: number;
    exitPrice: number;
    qty: number;
    pnl: number;
    entryTime: number;
    exitTime: number;
    reason: 'take-profit' | 'stop-loss' | 'signal' | 'end-of-data' | string;
}

export interface PerformanceMetrics {
    wins: number;
    losses: number;
    winRate: number;
    netProfit: number;
    maxDrawdown: number;
    profitFactor: number;
    sharpe: number;
    averageWin: number;
    averageLoss: number;
    numberOfTrades: number;
    totalProfitPercentage: number;
}

export interface BacktestResult {
    trades: TradeResult[];
    metrics: PerformanceMetrics;
    params: StrategyParams;
    initialBalance: number;
}

export interface SignalResult {
    entry?: boolean;
    exit?: boolean;
    side?: 'long' | 'short';
    confidence: number;
    exitReason?: string;
}

export interface QTableEntry {
    params: Omit<StrategyParams, 'leverage'>;
    scores: {
        [key in MarketRegime]?: number;
    };
    lastUpdated: Date;
    uses: number;
}
