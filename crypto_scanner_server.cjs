// --- ESM Import Statements ---
// We must use 'import' instead of 'require' because 'type: module' is set in package.json

// 1. Import core packages
import express from 'express';
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

// --- Server Setup ---
const app = express();
// PORT is read from the Render environment variable
const PORT = process.env.PORT || 3000;
const FIREBASE_CONFIG = process.env.FIREBASE_CONFIG; 

// Middleware to parse JSON bodies
app.use(express.json());

// --- Firebase Initialization ---

let db;
let firebaseApp;

try {
    // Parse the config JSON stored in the environment variable
    const parsedConfig = JSON.parse(FIREBASE_CONFIG);
    
    // Initialize Firebase
    firebaseApp = initializeApp(parsedConfig);
    db = getFirestore(firebaseApp);
    console.log('[DB] Firebase initialized successfully.');

} catch (error) {
    console.error('FATAL: Firebase config is missing or invalid. Persistence will fail.', error.message);
    // If initialization fails, db remains undefined, and later functions should check for it.
}


// --- Routes ---

// Default route for health check
app.get('/', (req, res) => {
    res.status(200).send('Crypto Scanner Server is running.');
});

// Example route to trigger the scanning/bot logic (you might call this from a webhook or cron job)
app.post('/scan', async (req, res) => {
    console.log('Waiting for external trigger on /scan endpoint...');
    
    // Basic check to see if database connection is available
    if (!db) {
        return res.status(500).json({ 
            error: "Database initialization failed. Cannot perform scan.", 
            details: "Please check FIREBASE_CONFIG environment variable." 
        });
    }

    // === PLACE YOUR CRYPTO SCANNING LOGIC HERE ===
    // This is where you would put the code to:
    // 1. Read settings/data from Firestore (using 'db')
    // 2. Run your scanning logic
    // 3. Send notifications via Telegram (using TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)
    // 4. Update status in Firestore

    // Example: Reading a document (You'll need to define your collection/document structure)
    // const docRef = doc(db, "settings", "global");
    // const docSnap = await getDoc(docRef);
    
    // For now, just a placeholder response
    res.json({ message: 'Scan triggered successfully (Placeholder).', status: 'Running...' });
});


// --- Start Server ---
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log('Waiting for external trigger on /scan endpoint...');
    console.log('==> Your service is live 🚀');
    console.log('==============================================');
    console.log(`Available at your primary URL https://crypto-scanner-server.onrender.com`);
    console.log('==============================================');
});

// Add error handling for unhandled promise rejections (important for background tasks)
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Application specific logging, throwing an error, or other logic here
});
