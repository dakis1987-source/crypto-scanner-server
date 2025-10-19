// --- CommonJS Require Statements ---
// We must use 'require' instead of 'import' because this file is named .cjs 
// and "type": "module" is NOT set in package.json.

// 1. Import core packages (using 'require' for express)
const express = require('express');

// 2. Import Firebase packages (using the server-side 'firebase-admin' is highly recommended for security, 
// but sticking to your current 'firebase/app' and 'firebase/firestore' for now.)
// NOTE: For server-side Node.js, you should ideally use 'firebase-admin' 
// for secure, unauthenticated access to the database.
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc } = require('firebase/firestore');

// --- Server Setup ---
const app = express();
// PORT is read from the Render environment variable
const PORT = process.env.PORT || 3000;
// Note: We will fix the security issue with this key next.
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
    // IMPORTANT: Check if the error is just due to empty config or a parsing failure
    if (FIREBASE_CONFIG === undefined) {
        console.error('FATAL: FIREBASE_CONFIG environment variable is missing.');
    }
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
            details: "Please ensure the FIREBASE_CONFIG environment variable is set and valid." 
        });
    }

    // === PLACE YOUR CRYPTO SCANNING LOGIC HERE ===
    try {
        console.log('Attempting to read settings from Firestore...');
        
        // Example: Reading a document (This is now possible thanks to the added 'doc' and 'getDoc' imports)
        // IMPORTANT: This assumes you have 'settings' collection and 'global' document.
        // This read will likely fail due to security rules if not using 'firebase-admin' or server keys.
        const docRef = doc(db, "settings", "global");
        const docSnap = await getDoc(docRef);
        
        if (docSnap.exists()) {
            console.log("Global settings found:", docSnap.data());
        } else {
            console.log("No global settings document found.");
        }

        // For now, just a placeholder response
        res.json({ 
            message: 'Scan triggered successfully (Placeholder).', 
            status: 'Database read attempted.' 
        });

    } catch (dbError) {
        // This catch block will trigger when the Firebase security rules block the operation.
        console.error('Firestore Operation Failed (Likely Security Issue):', dbError.message);
        res.status(500).json({ 
            error: "Firestore operation failed (Security/Permission error).", 
            details: dbError.message 
        });
    }
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
