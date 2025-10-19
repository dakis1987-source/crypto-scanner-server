// --- CommonJS Require Statements ---
const express = require('express');

// 1. Import Firebase Admin SDK modules
// The Admin SDK provides secure, privileged access for backend services.
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// --- Server Setup ---
const app = express();
const PORT = process.env.PORT || 3000;

// IMPORTANT: We now use the Service Account Key for server-side security.
const GCLOUD_SERVICE_ACCOUNT_KEY = process.env.GCLOUD_SERVICE_ACCOUNT_KEY; 
// The old FIREBASE_CONFIG is no longer needed but kept as an example of bad practice.
// const FIREBASE_CONFIG = process.env.FIREBASE_CONFIG; 

// Middleware to parse JSON bodies
app.use(express.json());

// --- Firebase Initialization (Admin SDK) ---

let db;

try {
    if (!GCLOUD_SERVICE_ACCOUNT_KEY) {
        // We throw an error if the key is missing to ensure secure setup
        throw new Error("GCLOUD_SERVICE_ACCOUNT_KEY environment variable is missing. Cannot initialize Admin SDK.");
    }
    
    // Parse the service account key JSON string
    const serviceAccount = JSON.parse(GCLOUD_SERVICE_ACCOUNT_KEY);
    
    // Initialize Admin SDK with the service account credentials
    initializeApp({
        credential: cert(serviceAccount)
    });
    
    // Get the Firestore instance (Admin SDK version)
    db = getFirestore();
    console.log('[DB] Firebase Admin SDK initialized successfully. (Secure Mode)');

} catch (error) {
    console.error('FATAL: Firebase Admin SDK initialization failed. Persistence will fail.', error.message);
    db = null; // Ensure db is null if initialization failed.
}


// --- Routes ---

// Default route for health check
app.get('/', (req, res) => {
    res.status(200).send('Crypto Scanner Server is running.');
});

// Example route to trigger the scanning/bot logic 
app.post('/scan', async (req, res) => {
    console.log('External trigger received on /scan endpoint. Initiating scan...');
    
    if (!db) {
        return res.status(500).json({ 
            error: "Database not available. Check Admin SDK initialization logs.", 
            details: "The service account key might be missing or invalid." 
        });
    }

    try {
        // === START OF YOUR SCANNING LOGIC ===
        console.log('Attempting secure read from Firestore...');

        // Admin SDK uses different collection/doc methods than the client SDK.
        // Admin SDK equivalent of: const docRef = doc(db, "settings", "global");
        const docRef = db.collection("settings").doc("global");
        
        // Admin SDK equivalent of: const docSnap = await getDoc(docRef);
        const docSnap = await docRef.get();
        
        if (docSnap.exists) {
            console.log("✅ Global settings read successfully:", docSnap.data());
            // Here you would continue with your scanning logic
            // Example: runScanner(docSnap.data());
        } else {
            console.log("⚠️ No global settings document found at 'settings/global'.");
        }
        
        // Example Telegram Notification (Requires TELEGRAM_BOT_TOKEN and logic)
        // const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN; 
        // if (telegramBotToken) { await sendTelegramNotification("Scan complete!"); }

        res.json({ 
            message: 'Scan triggered and database access successful (Placeholder).', 
            status: 'Ready for scanning logic.' 
        });

    } catch (dbError) {
        // This block will now only catch critical API/network errors, not permission denied.
        console.error('Firestore Operation Failed (Admin SDK Error):', dbError.message);
        res.status(500).json({ 
            error: "Server-side Firestore operation failed.", 
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

// Add error handling for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Application specific logging, throwing an error, or other logic here
});
