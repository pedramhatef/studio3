
'use client';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartDataPoint, Signal } from '@/lib/types';
import { useMemo } from 'react';

interface CryptoChartProps {
  data: ChartDataPoint[];
  signals: Signal[];
}

const chartConfig = {
  close: {
    label: 'Price',
    color: 'hsl(var(--primary))',
  },
  buy: {
    label: 'Buy Signal',
    color: 'hsl(var(--chart-2))',
  },
  sell: {
    label: 'Sell Signal',
    color: '#ef4444',
  },
  lowConfidence: {
    label: 'Low Confidence',
    color: '#FFC107',
  },
};

const CustomTooltipContent = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      const time = new Date(data.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      return (
        <div className="p-2 rounded-lg border bg-background/90 shadow-lg backdrop-blur-lg">
          <p className="font-bold text-foreground">{`Time: ${time}`}</p>
          <p className="text-sm text-primary">{`Price: $${data.close.toFixed(5)}`}</p>
          <div className="mt-1 text-xs text-muted-foreground">
            <p>{`Open: $${data.open.toFixed(5)}`}</p>
            <p>{`High: $${data.high.toFixed(5)}`}</p>
            <p>{`Low: $${data.low.toFixed(5)}`}</p>
            <p>{`Volume: ${data.volume.toLocaleString()}`}</p>
          </div>
        </div>
      );
    }
  
    return null;
  };

export function CryptoChart({ data, signals }: CryptoChartProps) {

  const yDomain = useMemo(() => {
    if (!data.length) return ['auto', 'auto'];

    const prices = data.map(d => d.close);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const padding = (max - min) * 0.1;
    return [min - padding, max + padding];
  }, [data]);

  const getSignalColor = (level: Signal['level'], type: 'BUY' | 'SELL') => {
    if (level === 'Low') {
      return chartConfig.lowConfidence.color;
    }
    return type === 'BUY' ? chartConfig.buy.color : chartConfig.sell.color;
  };

  const formatTime = (time: number) => {
    return new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // Create a map for quick lookup of close prices by time
  const priceDataMap = useMemo(() => {
    const map = new Map<number, number>();
    data.forEach(d => {
      map.set(d.time, d.close);
    });
    return map;
  }, [data]);


  return (
    <ChartContainer config={chartConfig} className="min-h-[400px] w-full">
      <AreaChart
        data={data}
        margin={{
          top: 10,
          right: 30,
          left: 0,
          bottom: 0,
        }}
      >
        <defs>
          <linearGradient id="colorClose" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
            <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.05} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border) / 0.5)" />
        <XAxis 
            dataKey="time" 
            tickMargin={10} 
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} 
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={formatTime}
        />
        <YAxis 
            domain={yDomain} 
            tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} 
            tickFormatter={(value: number) => value.toFixed(5)} 
            orientation="right" 
            tickMargin={10}
        />
        <ChartTooltip
          cursor={{ stroke: 'hsl(var(--foreground))', strokeWidth: 1, strokeDasharray: '3 3' }}
          content={<CustomTooltipContent />}
        />
        <Area
          type="monotone"
          dataKey="close"
          stroke="hsl(var(--primary))"
          strokeWidth={2}
          fillOpacity={1}
          fill="url(#colorClose)"
        />
        {signals.map((signal, index) => {
           const signalColor = getSignalColor(signal.level, signal.type);
           // High confidence is a solid circle, Medium/Low are rings.
           const fillOpacity = signal.level === 'High' ? 1 : 0.3;
           const chartPrice = priceDataMap.get(signal.time);
          
           // Render dot only if its time exists in the chart data
           if (chartPrice === undefined) {
             return null;
           }

           return (
            <ReferenceDot
              key={`signal-${index}`}
              x={signal.time}
              y={chartPrice}
              r={8}
              fill={signalColor}
              fillOpacity={fillOpacity}
              stroke={signalColor}
              strokeWidth={2}
              isFront={true}
            />
           )
        })}
      </AreaChart>
    </ChartContainer>
  );
}
