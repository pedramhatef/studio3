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
      totalWalletBalance: string;
      coin: BybitBalance[];
    }[];
  };
  time: number;
}

export interface BybitOrderParameters {
    category: 'linear' | 'spot' | 'option';
    symbol: string;
    side: 'Buy' | 'Sell';
    orderType: 'Market' | 'Limit';
    qty: string;
    price?: string; // Required for Limit orders
}

export interface BybitApiResponse {
    retCode: number;
    retMsg: string;
    result: any;
    retExtInfo: any;
    time: number;
}

async function makeRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    apiKey: string,
    apiSecret: string,
    params: Record<string, any> = {},
): Promise<T> {
  const host = 'https://api-demo.bybit.com';
  const timestamp = Date.now().toString();
  const recvWindow = '5000'; // Bybit's default is 5000ms

  let payload: string;
  let url: string;

  if (method === 'GET') {
    payload = new URLSearchParams(params).toString();
    url = `${host}${path}${payload ? `?${payload}` : ''}`;
  } else { // POST
    payload = JSON.stringify(params);
    url = `${host}${path}`;
  }

  const signPayload = timestamp + apiKey + recvWindow + payload;
  const signature = CryptoJS.HmacSHA256(signPayload, apiSecret).toString(CryptoJS.enc.Hex);

  const headers = new Headers();
  headers.append('X-BAPI-API-KEY', apiKey);
  headers.append('X-BAPI-TIMESTAMP', timestamp);
  headers.append('X-BAPI-RECV-WINDOW', recvWindow);
  headers.append('X-BAPI-SIGN', signature);
  headers.append('X-BAPI-SIGN-TYPE', '2');
  
  const requestOptions: RequestInit = {
    method: method,
    headers: headers,
  };

  if (method === 'POST') {
      headers.append('Content-Type', 'application/json');
      requestOptions.body = payload;
  }

  try {
    const response = await fetch(url, requestOptions);
    const responseText = await response.text();

    if (!response.ok) {
      console.error(`Bybit API Error (${response.status}) for ${method} ${path}:`, responseText);
      // Try to parse the error for a better message
      try {
        const errorJson = JSON.parse(responseText);
        throw new Error(errorJson.retMsg || `Bybit API request failed with status ${response.status}`);
      } catch {
        throw new Error(`Bybit API request failed with status ${response.status}: ${responseText}`);
      }
    }
    
    return JSON.parse(responseText) as T;

  } catch (error) {
    console.error(`Failed to make Bybit API request to ${path}:`, error);
    throw error;
  }
}


export async function fetchWalletBalance(apiKey: string, apiSecret: string): Promise<BybitWalletResponse> {
    const params = { accountType: 'UNIFIED' };
    const response = await makeRequest<BybitWalletResponse>('GET', '/v5/account/wallet-balance', apiKey, apiSecret, params);
     // The structure from the user's example is nested differently.
    // We adapt the response to match what the UI expects.
    if (response.result && response.result.list && response.result.list.length > 0) {
      const adaptedResult = {
        ...response,
        result: {
          list: response.result.list[0].coin.map((c: BybitBalance) => ({
            ...c,
            // Ensure availableToWithdraw has a value for the UI. Use equity as fallback.
            availableToWithdraw: c.availableToWithdraw || c.equity, 
          }))
        }
      };
      return adaptedResult as unknown as BybitWalletResponse;
    }
    return response;
}

export async function setLeverage(apiKey: string, apiSecret: string, symbol: string, leverage: string): Promise<BybitApiResponse> {
    const params = {
        category: 'linear',
        symbol,
        buyLeverage: leverage,
        sellLeverage: leverage,
    };
    return makeRequest<BybitApiResponse>('POST', '/v5/position/set-leverage', apiKey, apiSecret, params);
}

export async function placeOrder(apiKey: string, apiSecret: string, order: BybitOrderParameters): Promise<BybitApiResponse> {
    return makeRequest<BybitApiResponse>('POST', '/v5/order/create', apiKey, apiSecret, order);
}
