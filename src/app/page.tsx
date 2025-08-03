'use client';

import { SignalDashboard } from '@/components/SignalDashboard';

export default function Home() {
  return (
    <main className="flex min-h-screen w-full flex-col items-start bg-background p-4 md:p-8">
       <div className="w-full flex items-center justify-between mb-6">
         <div className="flex items-center gap-2">
           <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-primary">
            <path d="M12 2L2 7V17L12 22L22 17V7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M2 7L12 12L22 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M12 12V22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
           </svg>
           <h1 className="text-xl font-bold text-foreground">Bybit Signal Engine</h1>
         </div>
       </div>
      <div className="w-full max-w-7xl mx-auto">
        <SignalDashboard />
      </div>
    </main>
  );
}
