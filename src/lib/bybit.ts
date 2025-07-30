import CryptoJS from 'crypto-js';

export interface BybitBalance {
  coin: string;
  walletBalance: string;
  availableToWithdraw: string;
}

export interface BybitWalletResponse {
  retCode: number;
  retMsg: string;
  result: {
    list: BybitBalance[];
  };
  time: number;
}

export async function fetchWalletBalance(apiKey: string, apiSecret: string): Promise<BybitWalletResponse> {
  const host = 'https://api-testnet.bybit.com';
  const path = '/v5/account/wallet-balance';
  const timestamp = Date.now().toString();
  const recvWindow = '20000';
  const params = 'accountType=UNIFIED';

  const toSign = timestamp + apiKey + recvWindow + params;
  const signature = CryptoJS.HmacSHA256(toSign, apiSecret).toString(CryptoJS.enc.Hex);

  const headers = new Headers();
  headers.append('X-BAPI-API-KEY', apiKey);
  headers.append('X-BAPI-TIMESTAMP', timestamp);
  headers.append('X-BAPI-SIGN', signature);
  headers.append('X-BAPI-RECV-WINDOW', recvWindow);
  headers.append('Content-Type', 'application/json');

  const url = `${host}${path}?${params}`;

  const response = await fetch(url, {
    method: 'GET',
    headers,
  });

  const responseText = await response.text();
  
  if (!response.ok) {
    console.error('Bybit API Error Response:', responseText);
    throw new Error(`Bybit API request failed with status ${response.status}: ${responseText}`);
  }

  if (!responseText) {
    throw new Error('Bybit API returned an empty response.');
  }

  try {
    return JSON.parse(responseText);
  } catch (e) {
    console.error("Failed to parse Bybit API response:", responseText);
    throw new Error(`Unexpected end of JSON input. The API may have returned an HTML error page. Response: ${responseText}`);
  }
}
