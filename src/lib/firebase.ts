// Import the functions you need from the SDKs you need
import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  "projectId": "bybit-balance-view",
  "appId": "1:701023944234:web:fc234862537d441eae0d53",
  "storageBucket": "bybit-balance-view.firebasestorage.app",
  "apiKey": "AIzaSyBTKk45FMy6sGdeErxwTfx8gP_Upz1oqKY",
  "authDomain": "bybit-balance-view.firebaseapp.com",
  "measurementId": "",
  "messagingSenderId": "701023944234"
};

// Initialize Firebase
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
const db = getFirestore(app);

export { db };
