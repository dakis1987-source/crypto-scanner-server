// This script is the final, refactored version of the Adaptive Multi-Coin Prediction Scanner.
// 
// KEY CHANGES:
// 1. Removed `setInterval`. The script now runs once per HTTP request (via Express).
// 2. Integrated **Firestore** for persistent storage of the learned weights and accuracy.
// 3. On startup, it loads the last saved weights. After each scan, it saves the new weights.

// --- FIREBASE IMPORTS (Requires Node.js environment) ---
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken } from 'firebase/auth';
import { getFirestore, doc, setDoc, getDoc, collection } from 'firebase/firestore';

// --- SERVER IMPORTS (Requires Express) ---
import express from 'express';
import https from 'https'; // For Binance/Telegram calls

// =====================================================================
//                          --- FIREBASE SETUP ---
// =====================================================================
let db, auth;
let userId;
const app = express();
const PORT = process.env.PORT || 3000;

// Global variables provided by the Canvas environment for Firestore
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// The document path where the learned weights are stored. This is PUBLIC data
// so the single running server instance can access it permanently.
const LEARNING_DOC_PATH = `/artifacts/${appId}/public/data/crypto_scanner/adaptive_weights`;

async function initializeFirebase() {
    try {
        if (!firebaseConfig || Object.keys(firebaseConfig).length === 0) {
             console.error("FATAL: Firebase config is missing. Persistence will fail.");
             return false;
        }
        
        const firebaseApp = initializeApp(firebaseConfig);
        db = getFirestore(firebaseApp);
        auth = getAuth(firebaseApp);
        
        // Authenticate using the provided custom token or anonymously
        if (initialAuthToken) {
            await signInWithCustomToken(auth, initialAuthToken);
        } else {
            await signInAnonymously(auth);
        }
        
        userId = auth.currentUser?.uid || 'anonymous-user';
        console.log(`[DB] Firebase initialized. User ID: ${userId}`);
        return true;
        
    } catch (e) {
        console.error("FATAL: Could not initialize or authenticate Firebase:", e.message);
        return false;
    }
}

// =====================================================================
//                          --- CONFIGURATION & STATE ---
// =====================================================================

// --- Binance API Config ---
const BINANCE_API_URL = "https://api.binance.com/api/v3/klines";
const EXCHANGE_INFO_URL = "https://api.binance.com/api/v3/ticker/24hr";
const ORDER_BOOK_URL = "https://api.binance.com/api/v3/depth";
const TARGET_INTERVAL = "1h"; 
const LOOKBACK_PERIOD = 200; 
const DYNAMIC_SCAN_LIMIT = 300; 
const LEARNING_TRADE_COUNT = 50; 
const LOOKAHEAD_CANDLES = 4; 

// --- Telegram Config ---
const TELEGRAM_BOT_TOKEN = "8308285216:AAGJtJ2NA-Pg3dXY7-3N_MboLmCoqaYsgrA"; 
const TELEGRAM_CHAT_ID = "5842818456";

// --- Adaptive Weights State (Initial Hardcoded Defaults) ---
let CURRENT_WEIGHTS = {
    OBV: 30, // Money Flow
    STOCH: 25, // Momentum/Reversal
    OI_PROXY: 20, // Immediate Candle Pressure
    MACD: 10, // Trend Confirmation
};
let HISTORICAL_ACCURACY = '0.0';
const OBI_WEIGHT = 15; // STATIC weight for real-time Order Book Imbalance
const LEARNING_RATE = 0.5; 

// =====================================================================
//                          --- FIRESTORE PERSISTENCE ---
// =====================================================================

/**
 * Loads the last saved weights from Firestore.
 */
async function loadWeights() {
    if (!db) { return; }
    try {
        const docRef = doc(db, LEARNING_DOC_PATH);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            const data = docSnap.data();
            CURRENT_WEIGHTS = data.weights || CURRENT_WEIGHTS;
            HISTORICAL_ACCURACY = data.accuracy || HISTORICAL_ACCURACY;
            console.log(`[DB] Weights loaded successfully. Accuracy: ${HISTORICAL_ACCURACY}%`);
        } else {
            console.log("[DB] No weights found. Starting with default hard-coded values.");
        }
    } catch (e) {
        console.error("[DB ERROR] Failed to load weights:", e.message);
    }
}

/**
 * Saves the newly calculated weights and accuracy to Firestore.
 */
async function saveWeights(newWeights, newAccuracy) {
    if (!db) { return; }
    try {
        const docRef = doc(db, LEARNING_DOC_PATH);
        await setDoc(docRef, {
            weights: newWeights,
            accuracy: newAccuracy,
            lastUpdated: new Date().toISOString()
        });
        console.log(`[DB] New weights saved. Accuracy: ${newAccuracy}%`);
    } catch (e) {
        console.error("[DB ERROR] Failed to save weights:", e.message);
    }
}

// =====================================================================
//                          --- UTILITY FUNCTIONS ---
// =====================================================================

function sendTelegramMessage(message) {
    if (TELEGRAM_BOT_TOKEN.includes("YOUR_TELEGRAM_BOT_TOKEN_HERE") || TELEGRAM_CHAT_ID.includes("YOUR_TELEGRAM_CHAT_ID_HERE")) {
        console.error("TELEGRAM ERROR: Please configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.");
        return;
    }
    const encodedMessage = encodeURIComponent(message);
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage?chat_id=${TELEGRAM_CHAT_ID}&text=${encodedMessage}&parse_mode=Markdown`;

    https.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            const result = JSON.parse(data);
            if (!result.ok) {
                console.error(`Telegram API Failed: ${result.description}`);
            } // else { console.log(`[Telegram] Message sent successfully at ${new Date().toLocaleTimeString()}.`); }
        });
    }).on('error', (err) => {
        console.error(`Telegram Network Error: ${err.message}`);
    });
}

const calculate_ema = (data, window) => {
    let alpha = 2 / (window + 1);
    let ema = [];
    let current_ema = null;
    for (let i = 0; i < data.length; i++) {
        if (current_ema === null) {
            current_ema = data.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1);
        } else {
            current_ema = alpha * data[i] + (1 - alpha) * current_ema;
        }
        ema.push(current_ema);
    }
    return ema;
};

const calculate_macd = (data, fast = 12, slow = 26, signal = 9) => {
    const closes = data.map(d => d.close);
    const ema_fast = calculate_ema(closes, fast);
    const ema_slow = calculate_ema(closes, slow);
    const macd_line = ema_fast.map((f, i) => f - ema_slow[i]);
    const macd_hist = macd_line.map((m, i) => {
        const signal_line = calculate_ema(macd_line.slice(0, i + 1), signal);
        return m - (signal_line[signal_line.length - 1] || 0);
    });
    return { macd_hist };
};

const calculate_obv = (data) => {
    let obv = Array(data.length).fill(0);
    if (data.length === 0) return obv;
    obv[0] = data[0].volume;
    for (let i = 1; i < data.length; i++) {
        const prev_obv = obv[i - 1];
        if (data[i].close > data[i - 1].close) {
            obv[i] = prev_obv + data[i].volume; 
        } else if (data[i].close < data[i - 1].close) {
            obv[i] = prev_obv - data[i].volume; 
        } else {
            obv[i] = prev_obv; 
        }
    }
    return obv;
};

const calculate_stochastic = (data, k_window = 14) => {
    let k = Array(data.length).fill(50);
    for (let i = k_window - 1; i < data.length; i++) {
        const windowData = data.slice(i - k_window + 1, i + 1);
        const lowestLow = Math.min(...windowData.map(d => d.low));
        const highestHigh = Math.max(...windowData.map(d => d.high));
        const currentClose = data[i].close;
        const range = highestHigh - lowestLow;
        if (range > 1e-6) {
            k[i] = 100 * (currentClose - lowestLow) / range;
        }
    }
    return k;
};

const calculate_atr = (data, window = 14) => {
    let trueRanges = [];
    for (let i = 1; i < data.length; i++) {
        const high_low = data[i].high - data[i].low;
        const high_prevClose = Math.abs(data[i].high - data[i - 1].close);
        const low_prevClose = Math.abs(data[i].low - data[i - 1].close);
        trueRanges.push(Math.max(high_low, high_prevClose, low_prevClose));
    }
    let atr = [];
    if (trueRanges.length > 0) {
        let initial_sum = trueRanges.slice(0, window).reduce((a, b) => a + b, 0);
        let current_atr = initial_sum / window;
        atr.push(current_atr);
        for (let i = window; i < trueRanges.length; i++) {
            current_atr = ((current_atr * (window - 1)) + trueRanges[i]) / window;
            atr.push(current_atr);
        }
    }
    return Array(data.length - trueRanges.length).fill(atr[0] || 0).concat(atr);
};

const calculate_volume_pressure = (lastCandle) => {
    const { high, low, close } = lastCandle;
    const range = high - low;
    if (range < 1e-6) return 0;
    const close_position = (close - low) / range;
    const sentiment = (close_position * 2) - 1; 
    return sentiment * 100;
};

function fetchOrderBookData(symbol, limit = 10) {
    return new Promise((resolve, reject) => {
        const url = `${ORDER_BOOK_URL}?symbol=${symbol}&limit=${limit}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) { return reject(`HTTP Error: ${res.statusCode} for Order Book ${symbol}`); }
                try {
                    const book = JSON.parse(data);
                    resolve(book);
                } catch (e) {
                    reject(`Error parsing Order Book data for ${symbol}: ${e.message}`);
                }
            });
        }).on('error', (err) => {
            reject(`Network Error fetching Order Book for ${symbol}: ${err.message}`);
        });
    });
}

const calculate_depth_weighted_imbalance = (book) => {
    if (!book || !book.bids || !book.asks) return 0;

    const limit = book.bids.length; 

    const totalWeightedBidVolume = book.bids.reduce((sum, [price, qty], index) => {
        const weight = limit - index; 
        return sum + (parseFloat(qty) * weight);
    }, 0);

    const totalWeightedAskVolume = book.asks.reduce((sum, [price, qty], index) => {
        const weight = limit - index;
        return sum + (parseFloat(qty) * weight);
    }, 0);
    
    const totalWeightedVolume = totalWeightedBidVolume + totalWeightedAskVolume;

    if (totalWeightedVolume < 1e-6) return 50; 

    return (totalWeightedBidVolume / totalWeightedVolume) * 100;
};

const averageWeights = (allLearnedResults) => {
    const indicatorKeys = Object.keys(CURRENT_WEIGHTS);
    const averagedWeights = {};
    let totalAccuracy = 0;

    for (const key of indicatorKeys) {
        averagedWeights[key] = 0;
    }

    for (const { weights, accuracy } of allLearnedResults) {
        totalAccuracy += parseFloat(accuracy);
        for (const key of indicatorKeys) {
            averagedWeights[key] += weights[key];
        }
    }

    const count = allLearnedResults.length;
    
    for (const key of indicatorKeys) {
        averagedWeights[key] = Math.round(averagedWeights[key] / count);
    }
    
    const TARGET_TOTAL_WEIGHT = 100 - OBI_WEIGHT;
    const currentTotal = Object.values(averagedWeights).reduce((a, b) => a + b, 0);
    const normalizationFactor = TARGET_TOTAL_WEIGHT / currentTotal;
    
    for (const key of indicatorKeys) {
        averagedWeights[key] = Math.max(5, Math.round(averagedWeights[key] * normalizationFactor));
    }
    
    const finalTotal = Object.values(averagedWeights).reduce((a, b) => a + b, 0);
    const finalNormalizationFactor = TARGET_TOTAL_WEIGHT / finalTotal;
    for (const key of indicatorKeys) {
        averagedWeights[key] = Math.round(averagedWeights[key] * finalNormalizationFactor);
    }

    const averageAccuracy = (totalAccuracy / count).toFixed(1);

    return { averagedWeights, averageAccuracy };
};

const generatePrediction = (obvPctChange, stochK, macdHist, volumePressure, obiPct, weights) => {
    let score = 0;
    let componentScores = {};

    // 1. OBV (Money Flow - up to 30 points)
    let obvScore = 0;
    if (obvPctChange > 1) { obvScore = weights.OBV; } 
    else if (obvPctChange < -1) { obvScore = -weights.OBV; }
    score += obvScore;
    componentScores.OBV = obvScore;

    // 2. Stochastic %K (Momentum/Reversal - up to 25 points)
    let stochScore = 0;
    if (stochK < 25) { stochScore = weights.STOCH; } 
    else if (stochK > 75) { stochScore = -weights.STOCH; }
    score += stochScore;
    componentScores.STOCH = stochScore;

    // 3. Volume Pressure (OI Proxy - up to 20 points)
    let oiScore = 0;
    if (volumePressure > 50) { oiScore = weights.OI_PROXY; } 
    else if (volumePressure < -50) { oiScore = -weights.OI_PROXY; } 
    else if (volumePressure > 10) { oiScore = weights.OI_PROXY / 2; } 
    else if (volumePressure < -10) { oiScore = -weights.OI_PROXY / 2; }
    score += oiScore;
    componentScores.OI_PROXY = oiScore;

    // 4. MACD Histogram (Trend Confirmation - up to 10 points)
    let macdScore = 0;
    if (macdHist > 0) { macdScore = weights.MACD; } 
    else if (macdHist < 0) { macdScore = -weights.MACD; }
    score += macdScore;
    componentScores.MACD = macdScore;
    
    // 5. OBI (Order Book Imbalance - STATIC 15 points)
    let obiScore = 0;
    if (obiPct > 65) { obiScore = OBI_WEIGHT; } 
    else if (obiPct < 35) { obiScore = -OBI_WEIGHT; } 
    else if (obiPct > 55) { obiScore = OBI_WEIGHT / 2; } 
    else if (obiPct < 45) { obiScore = -OBI_WEIGHT / 2; }
    score += obiScore;
    componentScores.OBI = obiScore;


    const prediction = score >= 0 ? "UP" : "DOWN";
    const confidence = Math.min(100, Math.abs(score)); 

    return { prediction, confidence, score, componentScores };
};


function calculate_and_adjust_weights(data, initialWeights) {
    if (data.length < LEARNING_TRADE_COUNT + LOOKAHEAD_CANDLES) {
        return { newWeights: { ...initialWeights }, accuracy: 'N/A' };
    }

    let adjustedWeights = { ...initialWeights };
    let hits = 0;
    let totalTrades = LEARNING_TRADE_COUNT;
    const indicatorKeys = Object.keys(initialWeights); 

    for (let i = 0; i < totalTrades; i++) {
        const predictIndex = data.length - LOOKAHEAD_CANDLES - 1 - i; 
        const outcomeIndex = data.length - 1 - i; 
        
        if (predictIndex < 26 || outcomeIndex >= data.length) { 
            totalTrades = i;
            break;
        }

        const predictCandle = data[predictIndex];
        const outcomeCandle = data[outcomeIndex];
        
        const subData = data.slice(0, predictIndex + 1); 
        
        const obv_values = calculate_obv(subData);
        const { macd_hist } = calculate_macd(subData);
        const stoch_k = calculate_stochastic(subData)[predictIndex];
        const volume_pressure = calculate_volume_pressure(predictCandle);
        const macd_hist_val = macd_hist[predictIndex];
        
        const obv_window_start = Math.max(0, predictIndex - 20);
        const obv_window = obv_values.slice(obv_window_start, predictIndex);
        const initial_obv = obv_window[0];
        const final_obv = obv_window[obv_window.length - 1];
        const obv_pct_change = ((final_obv - initial_obv) / Math.abs(initial_obv || 1e-6)) * 100;
        
        const NEUTRAL_OBI = 50; 

        const prediction = generatePrediction(obv_pct_change, stoch_k, macd_hist_val, volume_pressure, NEUTRAL_OBI, adjustedWeights);
        
        const actualChange = outcomeCandle.close - predictCandle.close;
        const actualDirection = actualChange > 0 ? "UP" : (actualChange < 0 ? "DOWN" : "FLAT");

        const isHit = (prediction.prediction === actualDirection);

        if (isHit) {
            hits++;
            for (const key of indicatorKeys) { 
                if (prediction.componentScores[key] * prediction.score > 0) {
                    adjustedWeights[key] = Math.min(100, adjustedWeights[key] + LEARNING_RATE); 
                }
            }
        } else {
            for (const key of indicatorKeys) { 
                if (prediction.prediction === "UP" && actualDirection === "DOWN") {
                     if (prediction.componentScores[key] > 0) { 
                        adjustedWeights[key] = Math.max(5, adjustedWeights[key] - LEARNING_RATE); 
                     }
                } else if (prediction.prediction === "DOWN" && actualDirection === "UP") {
                    if (prediction.componentScores[key] < 0) { 
                        adjustedWeights[key] = Math.max(5, adjustedWeights[key] - LEARNING_RATE); 
                    }
                }
            }
        }
    }
    
    const TARGET_TOTAL_WEIGHT = 100 - OBI_WEIGHT;
    const currentTotal = Object.values(adjustedWeights).reduce((a, b) => a + b, 0);
    const normalizationFactor = TARGET_TOTAL_WEIGHT / currentTotal;
    for (const key of indicatorKeys) {
        adjustedWeights[key] = Math.round(adjustedWeights[key] * normalizationFactor);
    }
    
    const accuracy = totalTrades > 0 ? ((hits / totalTrades) * 100).toFixed(1) : '0';
    return { newWeights: adjustedWeights, accuracy };
}

function fetchTopSymbols(limit) {
    return new Promise((resolve, reject) => {
        https.get(EXCHANGE_INFO_URL, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) { return reject(`HTTP Error fetching symbols: ${res.statusCode} - ${data}`); }
                try {
                    const tickers = JSON.parse(data);
                    const usdtPairs = tickers.filter(t => 
                        t.symbol.endsWith('USDT') && 
                        !t.symbol.includes('UP') && 
                        !t.symbol.includes('DOWN') &&
                        parseFloat(t.quoteVolume) > 1000 
                    );
                    usdtPairs.sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume));
                    const topSymbols = usdtPairs.slice(0, limit).map(t => t.symbol);
                    resolve(topSymbols);
                } catch (e) {
                    reject(`Error parsing symbol data: ${e.message}`);
                }
            });
        }).on('error', (err) => {
            reject(`Network Error fetching symbols: ${err.message}`);
        });
    });
}

function fetchBinanceData(symbol, interval, limit) {
    return new Promise((resolve, reject) => {
        const url = `${BINANCE_API_URL}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) { return reject(`HTTP Error: ${res.statusCode} for ${symbol}`); }
                try {
                    const klines = JSON.parse(data);
                    const formattedData = klines.map(kline => ({
                        time: new Date(kline[0]), open: parseFloat(kline[1]), high: parseFloat(kline[2]), 
                        low: parseFloat(kline[3]), close: parseFloat(kline[4]), volume: parseFloat(kline[5]),
                    }));
                    resolve(formattedData);
                } catch (e) {
                    reject(`Error parsing Binance data for ${symbol}: ${e.message}`);
                }
            });
        }).on('error', (err) => {
            reject(`Network Error for ${symbol}: ${err.message}`);
        });
    });
}

// =====================================================================
//                          --- MAIN SCANNER LOGIC ---
// =====================================================================

async function scanAndReport() {
    console.log(`\n=============================================================`);
    console.log(`[RUN] Starting ADAPTIVE INTELLIGENCE SCAN at ${new Date().toLocaleTimeString()}...`);
    
    // Use the persistent weights
    const currentWeightsSnapshot = { ...CURRENT_WEIGHTS };
    
    let symbolsToScan;
    try {
        symbolsToScan = await fetchTopSymbols(DYNAMIC_SCAN_LIMIT);
    } catch (e) {
        console.error(`\n[FATAL] Could not fetch dynamic symbol list. Aborting scan. Error: ${e}`);
        return;
    }

    console.log(`[INFO] Scanning ${symbolsToScan.length} high-volume coins on ${TARGET_INTERVAL} chart.`);

    const results = [];
    let allLearningResults = [];
    
    const specificLearningSymbols = [
        { symbol: 'BTCUSDT', category: 'Large Cap' }, 
        { symbol: 'AVAXUSDT', category: 'Medium Cap' }, 
        { symbol: 'XVGUSDT', category: 'Small Cap 1' }, 
        { symbol: 'ROSEUSDT', category: 'Small Cap 2' },
        { symbol: 'PHBUSDT', category: 'Very Small Cap' }
    ];

    const learningSymbols = [];
    const symbolsSet = new Set(symbolsToScan); 

    for (const { symbol, category } of specificLearningSymbols) {
        if (symbolsSet.has(symbol)) {
            learningSymbols.push({ symbol, category });
        } else {
             console.log(`[WARN] Requested learning symbol ${symbol} not found in the Top ${DYNAMIC_SCAN_LIMIT} list. Skipping learning cycle for this coin.`);
        }
    }
    
    if (learningSymbols.length === 0 && symbolsToScan.length > 0) {
        learningSymbols.push({ symbol: symbolsToScan[0], category: 'Primary Fallback' });
    }

    // 1. Perform Learning Cycles on Selected Symbols (uses currentWeightsSnapshot)
    for (const { symbol, category } of learningSymbols) {
        try {
             process.stdout.write(`[LEARN] Performing adaptive learning on ${category} (${symbol})...\r`);
             const data = await fetchBinanceData(symbol, TARGET_INTERVAL, LOOKBACK_PERIOD);

             if (data.length < LEARNING_TRADE_COUNT + LOOKAHEAD_CANDLES) {
                console.log(`[WARN] Not enough data for ${symbol}. Skipping learning cycle.`);
                continue;
             }

             const { newWeights, accuracy } = calculate_and_adjust_weights(data, currentWeightsSnapshot);
             allLearningResults.push({ weights: newWeights, accuracy });
             process.stdout.write(`[LEARN] ${symbol} (${category}) Accuracy: ${accuracy}%.                                     \n`);
        } catch (e) {
             console.error(`[ERROR] Failed learning cycle for ${symbol}: ${e.message}`);
        }
    }
    
    // 2. Average and Update Global Weights and save to Firestore
    let optimizedWeights = currentWeightsSnapshot;
    if (allLearningResults.length > 0) {
        const { averagedWeights, averageAccuracy } = averageWeights(allLearningResults);
        optimizedWeights = averagedWeights;
        HISTORICAL_ACCURACY = averageAccuracy; 
        CURRENT_WEIGHTS = optimizedWeights; // Update the in-memory state

        // --- PERSISTENCE STEP ---
        await saveWeights(optimizedWeights, HISTORICAL_ACCURACY);
        
        console.log(`\n[LEARNING] Weights Tuned across ${allLearningResults.length} custom market caps. Avg Accuracy: ${HISTORICAL_ACCURACY}%`);
        console.log(`[WEIGHTS] (Learned: 85 Points) OBV: ${optimizedWeights.OBV}, STOCH: ${optimizedWeights.STOCH}, OI: ${optimizedWeights.OI_PROXY}, MACD: ${optimizedWeights.MACD}`);
    } else {
        console.log(`\n[LEARNING] Not enough data to perform multi-coin adaptive learning. Using previous persistent weights.`);
    }


    // 3. Start the Main Scan Loop (applies optimizedWeights to all 300 symbols)
    let completedScans = 0;
    for (const symbol of symbolsToScan) {
        process.stdout.write(`Scanning ${symbol} (${++completedScans}/${symbolsToScan.length})...\r`); 
        
        try {
            const data = await fetchBinanceData(symbol, TARGET_INTERVAL, LOOKBACK_PERIOD);

            if (data.length < LOOKBACK_PERIOD - 1) { continue; }
            
            const orderBook = await fetchOrderBookData(symbol);
            const obiPct = calculate_depth_weighted_imbalance(orderBook);

            const lastIndex = data.length - 2; 
            const current = data[lastIndex];
            const previous = data[lastIndex - 1]; 

            const obv_values = calculate_obv(data);
            const { macd_hist } = calculate_macd(data);
            const stoch_k = calculate_stochastic(data)[lastIndex];
            const volume_pressure = calculate_volume_pressure(current);
            const macd_hist_val = macd_hist[lastIndex];
            const atr_values = calculate_atr(data, 14);
            const current_atr = atr_values[lastIndex];

            const obv_window = obv_values.slice(lastIndex - 20, lastIndex);
            const initial_obv = obv_window[0];
            const final_obv = obv_window[obv_window.length - 1];
            const obv_pct_change = ((final_obv - initial_obv) / Math.abs(initial_obv || 1e-6)) * 100;

            const recent_price_change = ((current.close - previous.close) / previous.close) * 100;
            
            const prediction = generatePrediction(obv_pct_change, stoch_k, macd_hist_val, volume_pressure, obiPct, optimizedWeights);
            
            const lastCandleBody = Math.abs(current.close - current.open);
            const recentVolatilityRatio = current_atr > 1e-6 ? lastCandleBody / current_atr : 0; 
            
            if (prediction.confidence >= 50 && recentVolatilityRatio > 0.5) {
                results.push({
                    symbol,
                    score: prediction.score,
                    confidence: prediction.confidence,
                    prediction: prediction.prediction,
                    recentChange: recent_price_change.toFixed(2), 
                    atr: current_atr.toFixed(4),
                    obiPct: obiPct.toFixed(1)
                });
            }

        } catch (e) {
             // Skip
        }
    }
    
    process.stdout.write("                                                                                                      \r"); 
    console.log(`[COMPLETE] Scan finished. ${results.length} coins passed the intelligence, confidence, and volatility filters.`);

    // 4. Rank and Send Report
    if (results.length > 0 || HISTORICAL_ACCURACY !== '0.0') {
        const telegramMessage = formatTelegramReport(results, HISTORICAL_ACCURACY, optimizedWeights);
        sendTelegramMessage(telegramMessage);
    } else {
        console.log("No coins met the minimum confidence and volatility criteria for reporting.");
    }
    
    console.log(`[NEXT] Ready for next trigger via /scan endpoint.`);
    console.log(`=============================================================`);
}

function formatTelegramReport(results, historicalAccuracy, learnedWeights) {
    const sorted = results.sort((a, b) => b.score - a.score);
    const topBullish = sorted.filter(r => r.score > 0).slice(0, 5);
    const topBearish = sorted.filter(r => r.score < 0).sort((a, b) => a.score - b.score).slice(0, 5);

    let message = `*Superior Intelligence 1h Scan Report (ADAPTIVE + DWOBI)*\n`;
    message += `_Time: ${new Date().toLocaleTimeString()} UTC_\n`;
    message += `_Learned Accuracy: ${historicalAccuracy}% (Avg. across 5 market caps)_\n`;
    message += `_Active Weights (Total 100):_\n`;
    message += `_  *Learned:* OBV ${learnedWeights.OBV} | STOCH ${learnedWeights.STOCH} | OI ${learnedWeights.OI_PROXY} | MACD ${learnedWeights.MACD}_\n`;
    message += `_  *Static:* DWOBI ${OBI_WEIGHT} (Depth-Weighted Order Book Pressure)_\n\n`;
    
    message += `*🟢 TOP 5 POTENTIAL GAINERS (LONG)*\n`;
    if (topBullish.length === 0) {
        message += `_No strong bullish candidates found (Volatile & Confident)_\n`;
    } else {
        topBullish.forEach((r, index) => {
            message += `${index + 1}. *${r.symbol}* | Conf: ${r.confidence}% | DWOBI: ${r.obiPct}% \n`;
        });
    }

    message += `\n`;

    message += `*🔴 TOP 5 POTENTIAL LOSERS (SHORT)*\n`;
    if (topBearish.length === 0) {
        message += `_No strong bearish candidates found (Volatile & Confident)_\n`;
    } else {
        topBearish.forEach((r, index) => {
            message += `${index + 1}. *${r.symbol}* | Conf: ${r.confidence}% | DWOBI: ${r.obiPct}% \n`;
        });
    }

    message += `\n_Model adapts weights based on recent performance. DWOBI provides real-time confirmation._`;
    return message;
}


// =====================================================================
//                          --- EXPRESS SERVER SETUP ---
// =====================================================================

// Middleware to parse JSON bodies (not strictly needed here, but good practice)
app.use(express.json()); 

// Root endpoint just to keep the service alive
app.get('/', (req, res) => {
    res.status(200).send(`Adaptive Crypto Scanner is running. Hit /scan to trigger the job.`);
});

// The endpoint that will be hit by the external Cron Job (UptimeRobot)
app.get('/scan', async (req, res) => {
    // Prevent multiple concurrent scans if possible, but for a cron job, a simple check suffices
    if (!db) {
        res.status(503).send("Database not initialized. Cannot run scan.");
        return;
    }
    
    // Run the main logic
    try {
        await scanAndReport();
        res.status(200).send("Scan complete. Report sent to Telegram.");
    } catch (error) {
        console.error("Critical error during scan:", error);
        res.status(500).send(`Scan failed: ${error.message}`);
    }
});


// Start Initialization and Server
(async () => {
    const isDbReady = await initializeFirebase();
    if (isDbReady) {
        await loadWeights(); // Load persistent weights before starting the server
    }

    // Start listening on the designated port
    app.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
        console.log("Waiting for external trigger on /scan endpoint...");
    });
})();
