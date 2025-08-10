// src/app/api/cron/route.ts

import { NextResponse } from 'next/server';

// This function is intentionally left blank to disable signal generation.
// The cron job will still run every minute, but it will no longer execute any trading logic.
export function GET() {
  console.log("Signal generation is currently disabled.");
  return NextResponse.json({ message: 'Signal generation is disabled.' });
}
