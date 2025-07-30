import CryptoJS from 'crypto-js';

export interface BybitBalance {
  coin: string;
  walletBalance: string;
  availableToWithdraw: string;
  equity: string;
}

export interface BybitWalletResponse {
  retCode: number;
  retMsg: string;
  result: {
    list: {
      accountType: string;
      coin: BybitBalance[];
    }[];
  };
  time: number;
}

// This function is adapted from the user's provided working NodeJS example.
export async function fetchWalletBalance(apiKey: string, apiSecret: string): Promise<BybitWalletResponse> {
  const host = 'https://api-demo.bybit.com';
  const path = '/v5/account/wallet-balance';
  
  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const queryString = 'accountType=UNIFIED';
  
  // Signature payload must be: timestamp + apiKey + recvWindow + queryString
  const toSign = timestamp + apiKey + recvWindow + queryString;
  const signature = CryptoJS.HmacSHA256(toSign, apiSecret).toString(CryptoJS.enc.Hex);

  const headers = new Headers();
  headers.append('X-BAPI-API-KEY', apiKey);
  headers.append('X-BAPI-TIMESTAMP', timestamp);
  headers.append('X-BAPI-RECV-WINDOW', recvWindow);
  headers.append('X-BAPI-SIGN', signature);
  // This header is required as per the user's working example.
  headers.append('X-BAPI-SIGN-TYPE', '2'); 
  headers.append('Content-Type', 'application/json');

  const url = `${host}${path}?${queryString}`;

  const response = await fetch(url, {
    method: 'GET',
    headers,
  });

  const responseText = await response.text();
  
  if (!response.ok) {
    console.error('Bybit API Error Response:', responseText);
    throw new Error(`Bybit API request failed with status ${response.status}: ${responseText}`);
  }

  try {
    const data = JSON.parse(responseText);
    // The structure from the user's example is nested differently.
    // We adapt the response to match what the UI expects.
    if (data.result && data.result.list && data.result.list.length > 0) {
      const adaptedResult = {
        ...data,
        result: {
          list: data.result.list[0].coin.map((c: BybitBalance) => ({
            ...c,
            // Ensure availableToWithdraw has a value for the UI. Use equity as fallback.
            availableToWithdraw: c.availableToWithdraw || c.equity, 
          }))
        }
      };
      return adaptedResult;
    }
    return data;
  } catch (e) {
    console.error("Failed to parse Bybit API response:", responseText);
    throw new Error(`Unexpected end of JSON input. The API may have returned an HTML error page. Response: ${responseText}`);
  }
}
