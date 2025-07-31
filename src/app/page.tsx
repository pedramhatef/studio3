'use client';

import { useState, useEffect } from 'react';
import { SetupForm } from '@/components/SetupForm';
import { BalanceDashboard } from '@/components/BalanceDashboard';
import { Loader2 } from 'lucide-react';
import { SignalDashboard } from '@/components/SignalDashboard';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"


export default function Home() {
  const [credentials, setCredentials] = useState<{ apiKey: string; apiSecret: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    try {
      const storedKey = localStorage.getItem('bybit-apiKey');
      const storedSecret = localStorage.getItem('bybit-apiSecret');
      if (storedKey && storedSecret) {
        setCredentials({ apiKey: storedKey, apiSecret: storedSecret });
      }
    } catch (error) {
      console.error('Could not access localStorage', error);
    }
    setIsLoading(false);
  }, []);

  const handleCredentialsSave = (apiKey: string, apiSecret: string) => {
    localStorage.setItem('bybit-apiKey', apiKey);
    localStorage.setItem('bybit-apiSecret', apiSecret);
    setCredentials({ apiKey, apiSecret });
  };

  const handleClearCredentials = () => {
    localStorage.removeItem('bybit-apiKey');
    localStorage.removeItem('bybit-apiSecret');
    setCredentials(null);
  };

  const renderContent = () => {
    if (isLoading) {
      return <div className="flex justify-center items-center h-64"><Loader2 className="h-12 w-12 animate-spin text-primary" /></div>;
    }

    if (credentials) {
      return (
         <Tabs defaultValue="signals" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="signals">Signal Engine</TabsTrigger>
              <TabsTrigger value="balance">Account Balance</TabsTrigger>
            </TabsList>
            <TabsContent value="signals" forceMount>
              <SignalDashboard />
            </TabsContent>
            <TabsContent value="balance" forceMount>
              <BalanceDashboard 
                apiKey={credentials.apiKey} 
                apiSecret={credentials.apiSecret} 
                onClearCredentials={handleClearCredentials} 
              />
            </TabsContent>
          </Tabs>
      );
    }

    return <SetupForm onCredentialsSave={handleCredentialsSave} />;
  }

  return (
    <main className="flex min-h-screen w-full flex-col items-start bg-background p-4 md:p-8">
       <div className="w-full flex items-center justify-between mb-6">
         <div className="flex items-center gap-2">
           <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-primary">
            <path d="M12 2L2 7V17L12 22L22 17V7L12 2Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M2 7L12 12L22 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M12 12V22" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
           </svg>
           <h1 className="text-xl font-bold text-foreground">Bybit Balance View</h1>
         </div>
       </div>
      <div className="w-full max-w-7xl mx-auto">
        {renderContent()}
      </div>
    </main>
  );
}
