/**
 * @fileOverview Q-Learning inspired optimizer for managing and improving strategy parameters.
 * This system uses a Q-table stored in Firestore to associate strategy parameters
 * with market regimes, learning over time which parameters perform best under
 * different conditions.
 */
import { db } from './firebase';
import { doc, getDoc, setDoc, updateDoc, collection, query, orderBy, limit, getDocs } from 'firebase/firestore';
import type { StrategyParams, MarketRegime, QTableEntry, StrategyType } from './types';
import crypto from 'crypto';

const Q_TABLE_COLLECTION = 'qLearningTable';
const LEARNING_RATE = 0.05; // Alpha: How much we accept the new value.

function log(message: string, ...args: any[]) {
    const params = args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' ');
    console.log(`[Q-Learning] ${message}`, params);
}

/**
 * Creates a stable, string-based key from a strategy parameters object.
 */
function getParamsKey(params: Omit<StrategyParams, 'leverage'>): string {
    return Object.entries(params)
        .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
        .map(([key, value]) => `${key}:${value}`)
        .join('|');
}

/**
 * Retrieves the best-performing parameters for a given market regime from the Q-table.
 * @param regime The current market regime.
 * @returns The best known StrategyParams or null if none are found.
 */
export async function getBestParamsFromQTable(strategy: StrategyType, regime: MarketRegime): Promise<Omit<StrategyParams, 'leverage'> | null> {
    try {
        log(`[${strategy}] Searching for best params for regime: ${regime}`);
        const qTableRef = collection(db, Q_TABLE_COLLECTION);
        const q = query(
            qTableRef,
            orderBy(`scores.${regime}`, 'desc'),
            limit(1)
        );
        
        const snapshot = await getDocs(q);

        if (snapshot.empty) {
            log(`[${strategy}] No entries found in Q-Table for regime '${regime}'.`);
            return null;
        }

        const bestEntry = snapshot.docs[0].data() as QTableEntry;
        const bestScore = bestEntry.scores[regime];

        if (typeof bestScore !== 'number') {
            log(`[${strategy}] Found an entry for regime '${regime}', but its score is invalid.`, bestEntry);
            return null;
        }

        log(`[${strategy}] Found best params for regime '${regime}' with score ${bestScore.toFixed(4)}.`);
        return bestEntry.params;

    } catch (error) {
        log(`[${strategy}] Error getting best params from Q-Table for regime ${regime}:`, error);
        return null;
    }
}

/**
 * Updates the Q-table with the performance of a given set of parameters.
 * @param regime The market regime during which the parameters were tested.
 * @param params The strategy parameters that were tested.
 * @param newScore The performance score achieved by the parameters.
 */
export async function updateQTable(strategy: StrategyType, regime: MarketRegime, params: Omit<StrategyParams, 'leverage'>, newScore: number) {
    const paramsKey = getParamsKey(params);
    const docId = createHash(paramsKey);
    const docRef = doc(db, Q_TABLE_COLLECTION, docId);

    try {
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            // Update existing entry
            const existingData = docSnap.data() as QTableEntry;
            const oldScore = existingData.scores[regime] || 0;
            
            // Q-learning formula: Q(s,a) = Q(s,a) + alpha * (R - Q(s,a))
            // Simplified for our use case: NewScore = OldScore + alpha * (Reward - OldScore)
            const updatedScore = oldScore + LEARNING_RATE * (newScore - oldScore);

            await updateDoc(docRef, {
                [`scores.${regime}`]: updatedScore,
                lastUpdated: new Date(),
                uses: (existingData.uses || 0) + 1,
            });
            log(`[${strategy}] Q-Table updated for regime '${regime}'. Old score: ${oldScore.toFixed(4)}, New score: ${updatedScore.toFixed(4)}.`);

        } else {
            // Create new entry
            const newEntry: QTableEntry = {
                params,
                scores: {
                    [regime]: newScore,
                },
                lastUpdated: new Date(),
                uses: 1,
            };
            await setDoc(docRef, newEntry);
            log(`[${strategy}] Q-Table new entry created for regime '${regime}' with score ${newScore.toFixed(4)}.`);
        }
    } catch (error) {
        log(`[${strategy}] Error updating Q-Table:`, error);
    }
}


// Simple hash function to create a consistent doc ID using Node.js crypto.
function createHash(input: string): string {
    return crypto.createHash('sha1').update(input).digest('hex');
}
