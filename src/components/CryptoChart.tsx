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
    color: 'hsl(var(--chart-1))',
  },
};

const CustomTooltipContent = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      const data = payload[0].payload;
      return (
        <div className="p-2 rounded-lg border bg-background/90 shadow-lg backdrop-blur-lg">
          <p className="font-bold text-foreground">{`Time: ${label}`}</p>
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
  const chartData = useMemo(() => {
    return data.map(d => ({
      ...d,
      time: new Date(d.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    }));
  }, [data]);

  const yDomain = useMemo(() => {
    if (!data.length) return ['auto', 'auto'];
    const prices = data.map(d => d.close);
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const padding = (max - min) * 0.1;
    return [min - padding, max + padding];
  }, [data]);

  return (
    <ChartContainer config={chartConfig} className="min-h-[400px] w-full">
      <AreaChart
        data={chartData}
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
            interval="preserveStartEnd"
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
           const dataPoint = data.find(d => d.time === signal.time);
           if (!dataPoint) return null;
           const displayTime = new Date(dataPoint.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
           const isBuy = signal.type === 'BUY';
           return (
            <ReferenceDot
              key={index}
              x={displayTime}
              y={signal.price}
              r={10}
              fill={isBuy ? chartConfig.buy.color : chartConfig.sell.color}
              fillOpacity={0.3}
              stroke={isBuy ? chartConfig.buy.color : chartConfig.sell.color}
              strokeWidth={2}
              isFront={true}
            />
           )
        })}
      </AreaChart>
    </ChartContainer>
  );
}
