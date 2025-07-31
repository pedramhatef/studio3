'use client';

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import type { Signal } from '@/lib/types';
import { TrendingUp, TrendingDown, History } from 'lucide-react';

interface SignalHistoryProps {
  signals: Signal[];
}

const levelVariantMap: { [key in Signal['level']]: 'default' | 'secondary' | 'destructive' } = {
    'Low': 'secondary',
    'Medium': 'default',
    'High': 'destructive'
};

const levelTextMap: { [key in Signal['level']]: string } = {
    'Low': 'Low Confidence',
    'Medium': 'Medium Confidence',
    'High': 'High Confidence'
};


export function SignalHistory({ signals }: SignalHistoryProps) {
  return (
    <Card className="shadow-lg">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-6 w-6" />
          Signal History
        </CardTitle>
        <CardDescription>A log of the most recent trade signals generated.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Price (USDT)</TableHead>
              <TableHead className="text-right">Confidence</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {signals.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="text-center h-24">
                  Waiting for signals...
                </TableCell>
              </TableRow>
            ) : (
              signals.map((signal) => (
                <TableRow key={signal.time}>
                  <TableCell>{signal.displayTime}</TableCell>
                  <TableCell>
                    <div className={`flex items-center gap-2 ${signal.type === 'BUY' ? 'text-green-500' : 'text-red-500'}`}>
                      {signal.type === 'BUY' ? <TrendingUp className="text-green-500" /> : <TrendingDown className="text-red-500" />}
                      <span className="font-medium">{signal.type}</span>
                    </div>
                  </TableCell>
                  <TableCell>{signal.price.toFixed(5)}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant={levelVariantMap[signal.level]}>{levelTextMap[signal.level]}</Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
