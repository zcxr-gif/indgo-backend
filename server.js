// server.js
// A lightweight backend for Community Aircraft Contributions and Flight Trail Storage.

const { 
    uploadAirportImage, 
    getAirportInfo, 
    deleteAirportImages, 
    updateAirportMetadata 
} = require('./airports');

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const axios = require('axios'); // Added for Webhook
const crypto = require('crypto'); // <--- ADDED for IP Hashing
const { 
    S3Client, 
    PutObjectCommand, 
    DeleteObjectCommand, 
    ListObjectsV2Command,
    GetObjectCommand
} = require('@aws-sdk/client-s3');
const { CloudWatchClient, GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');
const sharp = require('sharp'); // Image processing library
require('dotenv').config();
const fs = require('fs');
const os = require('os');

// MEMORY FIX: Disable Sharp's internal cache to prevent RAM balloons
sharp.cache(false);
sharp.concurrency(1);

// STABILITY: Keep the backend alive when the bot (or anything else) misbehaves.
// Without these, a single rejected promise inside discord.js takes down the API.
process.on('unhandledRejection', (reason) => {
    console.error('⚠️  Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
    console.error('⚠️  Uncaught Exception:', err && err.stack ? err.stack : err);
});

// IMPORT THE BOT
const { startDiscordBot } = require('./bot');

// 1. INITIALIZE APP
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Allow all origins
// Increase limit for JSON body (trails can be large)
app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Trust Proxy (Required if behind Nginx/Heroku/Cloudflare to get real IPs)
app.set('trust proxy', 1);

// 2. CONNECT TO MONGODB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

const CommunityAircraftSchema = new mongoose.Schema({
    contributorName: { type: String, default: "System" }, // Default to system for pre-filled
    contributorId: { type: String, required: false },
    aircraftType: { type: String, required: true },
    liveryName: { type: String, required: true },
    tailNumber: { type: String, required: true, unique: true }, // Ensure no duplicates
    imageUrl: { type: String, required: false, default: null }, // Primary image (kept for backward compatibility)
    imageUrls: { type: [String], default: [] }, // NEW: Up to 3 images per aircraft (imageUrl mirrors imageUrls[0])
    needsUpdate: { type: Boolean, default: false }, // NEW: Flag for image updates
    uploadedAt: { type: Date, default: Date.now }
});

// Indexes: every hot query path now hits an index instead of scanning.
CommunityAircraftSchema.index({ contributorId: 1 });
CommunityAircraftSchema.index({ contributorName: 1 });
CommunityAircraftSchema.index({ aircraftType: 1, liveryName: 1 });
CommunityAircraftSchema.index({ needsUpdate: 1 });
CommunityAircraftSchema.index({ uploadedAt: -1 });

const CommunityAircraft = mongoose.model('CommunityAircraft', CommunityAircraftSchema);

/* =========================
 * NEW: GATES SCHEMA
 * ========================= */
const AirportGateSchema = new mongoose.Schema({
    airportCode: { type: String, required: true, unique: true, index: true }, // e.g., "KJFK"
    gates: { type: mongoose.Schema.Types.Mixed, required: true }, // Flexible to hold the specific gate array structure
    updatedAt: { type: Date, default: Date.now }
});

const AirportGate = mongoose.model('AirportGate', AirportGateSchema);

/* =========================
 * LEADERBOARD SCHEMAS
 *
 * Old design (replaced): single doc per pilot/day with a `uniqueViewers` array
 * of hashed IPs. Every track call did `array.includes()` then rewrote the whole
 * doc. Doc size + CPU grew linearly with traffic for popular pilots.
 *
 * Newer design: tally per (date, pilot, viewer). Worked, but a single pilot
 * can be flying multiple concurrent flights and we couldn't decompose the
 * count to know *which* flight was being watched.
 *
 * Current design: tally per (date, pilot, flight, viewer). `flightId`
 * carries the live-tracker's per-flight identifier, so the leaderboard can
 * surface the exact flight that's drawing eyes. Pre-flightId clients (no
 * `flightId` in the body) bucket into a sentinel value so their views still
 * count, just lumped together per pilot.
 *
 *  - DailyPilotView    : one tiny doc per (date, pilot, flight, viewer).
 *                        Compound unique index makes "has this viewer seen
 *                        this flight today?" an O(1) insert that either
 *                        succeeds or duplicate-keys. TTL auto-deletes after 24h.
 *  - DailyPilotStats   : one tiny doc per (date, pilot, flight) holding the
 *                        counter. `$inc` is atomic — no full-doc rewrites.
 *                        TTL keeps history for 7 days.
 * ========================= */
const VIEW_TTL_SECONDS = 60 * 60 * 24;            // 24h for individual view records
const STATS_TTL_SECONDS = 60 * 60 * 24 * 7;       // 7d of daily aggregates
const NO_FLIGHT = '__none__';                     // sentinel for pre-flightId clients

const DailyPilotViewSchema = new mongoose.Schema({
    date: { type: String, required: true },        // YYYY-MM-DD
    pilotUserId: { type: String, required: true },
    flightId: { type: String, required: true, default: NO_FLIGHT },
    viewerHash: { type: String, required: true },
    createdAt: { type: Date, default: Date.now }
});
DailyPilotViewSchema.index(
    { date: 1, pilotUserId: 1, flightId: 1, viewerHash: 1 },
    { unique: true }
);
DailyPilotViewSchema.index({ createdAt: 1 }, { expireAfterSeconds: VIEW_TTL_SECONDS });

const DailyPilotView = mongoose.model('DailyPilotView', DailyPilotViewSchema);

const DailyPilotStatsSchema = new mongoose.Schema({
    date: { type: String, required: true },
    pilotUserId: { type: String, required: true },
    pilotName: { type: String, required: true },
    flightId: { type: String, required: true, default: NO_FLIGHT },
    viewCount: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});
DailyPilotStatsSchema.index(
    { date: 1, pilotUserId: 1, flightId: 1 },
    { unique: true }
);
DailyPilotStatsSchema.index({ date: 1, viewCount: -1 });
DailyPilotStatsSchema.index({ createdAt: 1 }, { expireAfterSeconds: STATS_TTL_SECONDS });

const DailyPilotStats = mongoose.model('DailyPilotStats', DailyPilotStatsSchema);

// One-time cleanup on process start. Two jobs:
//   1. Drop any legacy stats docs left over from the uniqueViewers-array era.
//   2. Drop the previous (date, pilot, viewer) and (date, pilot) unique
//      indexes — they conflict with the new flightId-aware ones. Mongoose
//      will (re)create the correct indexes when the models load.
mongoose.connection.once('open', async () => {
    try {
        const result = await DailyPilotStats.collection.deleteMany({
            $or: [{ uniqueViewers: { $exists: true } }, { createdAt: { $exists: false } }]
        });
        if (result.deletedCount > 0) {
            console.log(`🧹 Cleared ${result.deletedCount} legacy DailyPilotStats docs.`);
        }
    } catch (e) {
        console.error('Legacy stats cleanup failed (non-fatal):', e.message);
    }

    const dropLegacyIndex = async (model, indexName) => {
        try {
            await model.collection.dropIndex(indexName);
            console.log(`🧹 Dropped legacy index ${model.modelName}.${indexName}.`);
        } catch (e) {
            // 27 = IndexNotFound — expected on fresh deploys / re-runs.
            if (e && e.code !== 27 && !/index not found/i.test(e.message)) {
                console.error(`Index drop (${model.modelName}.${indexName}) failed:`, e.message);
            }
        }
    };
    await dropLegacyIndex(DailyPilotView,  'date_1_pilotUserId_1_viewerHash_1');
    await dropLegacyIndex(DailyPilotStats, 'date_1_pilotUserId_1');
});

// 4. CONFIGURE AWS CLIENTS
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

// CloudWatch Client (Monitoring/Stats)
const cloudWatchClient = new CloudWatchClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

// Configure Multer to store file in MEMORY temporarily
const upload = multer({
    dest: os.tmpdir(), 
    limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// --- START THE BOT ---
// We pass the Model AND the S3 Client/Config to the bot
startDiscordBot(
    CommunityAircraft,
    s3Client,
    process.env.AWS_S3_BUCKET_NAME,
    process.env.AWS_REGION,
    { DailyPilotStats, DailyPilotView }
);
// ---------------------

// Helper to delete image from S3
const deleteS3Object = async (imageUrl) => {
    if (!imageUrl) return;
    try {
        // Extract Key from URL
        const urlObj = new URL(imageUrl);
        const key = urlObj.pathname.substring(1); // Remove leading '/'

        const command = new DeleteObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: key,
        });
        await s3Client.send(command);
        console.log(`🗑️ Deleted old S3 Object: ${key}`);
    } catch (error) {
        console.error(`Error deleting S3 Object: ${imageUrl}`, error);
    }
};

// Maximum number of images allowed per aircraft
const MAX_AIRCRAFT_IMAGES = 3;

// Helper: Gather uploaded image files from a multipart request.
// Accepts both the new 'images' field (multiple) and the legacy 'image' field (single),
// then caps the total at MAX_AIRCRAFT_IMAGES.
const collectUploadedImages = (req) => {
    const files = [];
    if (req.files) {
        if (Array.isArray(req.files.images)) files.push(...req.files.images);
        if (Array.isArray(req.files.image)) files.push(...req.files.image);
    }
    // Fallback for upload.single() style requests
    if (req.file) files.push(req.file);
    return files.slice(0, MAX_AIRCRAFT_IMAGES);
};

// Helper: Optimize a single image file and upload it to S3, returning the public URL.
const processAndUploadAircraftImage = async (file, tailRef) => {
    const optimizedBuffer = await sharp(file.path)
        .resize({ width: 1920, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();

    const cleanTailName = (tailRef || 'aircraft').replace(/[^a-zA-Z0-9]/g, '');
    // Random suffix avoids collisions when several images are uploaded in the same millisecond
    const fileName = `community-aircraft/${cleanTailName}-${Date.now()}-${Math.round(Math.random() * 1e6)}.webp`;

    await s3Client.send(new PutObjectCommand({
        Bucket: process.env.AWS_S3_BUCKET_NAME,
        Key: fileName,
        Body: optimizedBuffer,
        ContentType: 'image/webp',
    }));

    return `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
};

// Helper: Delete every image associated with an aircraft entry (primary + gallery).
const deleteAircraftImages = async (entry) => {
    if (!entry) return;
    const urls = new Set();
    if (entry.imageUrl) urls.add(entry.imageUrl);
    if (Array.isArray(entry.imageUrls)) entry.imageUrls.forEach(u => u && urls.add(u));
    await Promise.all([...urls].map(deleteS3Object));
};

// Helper: Remove temp files left on disk by multer after processing.
const cleanupTempFiles = (files) => {
    (files || []).forEach(f => {
        if (f && f.path) fs.unlink(f.path, () => {});
    });
};

// Multer config for the aircraft endpoints: accept up to MAX_AIRCRAFT_IMAGES under
// the new 'images' field plus one legacy 'image' field.
const uploadAircraftImages = upload.fields([
    { name: 'images', maxCount: MAX_AIRCRAFT_IMAGES },
    { name: 'image', maxCount: 1 }
]);

// Helper: Convert S3 Stream to String
const streamToString = (stream) =>
    new Promise((resolve, reject) => {
        const chunks = [];
        stream.on("data", (chunk) => chunks.push(chunk));
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });

// Helper: Send Discord Webhook Notification
const sendDiscordWebhook = async (entry) => {
    if (!process.env.DISCORD_WEBHOOK_URL) return;

    try {
        const payload = {
            embeds: [{
                title: "✈️ New Aircraft Contribution!",
                color: 5763719, // Greenish color
                fields: [
                    { name: "Aircraft Type", value: entry.aircraftType, inline: true },
                    { name: "Livery", value: entry.liveryName, inline: true },
                    { name: "Tail Number", value: entry.tailNumber, inline: true },
                    { name: "Contributor", value: entry.contributorName, inline: false }
                ],
                image: { url: entry.imageUrl },
                timestamp: new Date().toISOString(),
                footer: { text: "Community Tracker Bot" }
            }]
        };

        await axios.post(process.env.DISCORD_WEBHOOK_URL, payload);
        console.log(`🔔 Notification sent to Discord for ${entry.tailNumber}`);
    } catch (error) {
        console.error("❌ Failed to send Discord Webhook:", error.message);
    }
};

/* =========================
 * HELPER: DATE UTILS
 * ========================= */
const getTodayString = () => {
    return new Date().toISOString().split('T')[0]; // Returns "YYYY-MM-DD"
};

const hashIp = (ip) => {
    return crypto.createHash('sha256').update(ip || 'unknown').digest('hex');
};

// 5. API ROUTES

// Health Check
app.get('/', (req, res) => {
    res.send('Community Aircraft Backend is Running.');
});


/* =========================
 * GATES API (MONGODB INTEGRATION)
 * ========================= */

// POST: Import gates.json into MongoDB using fast Bulk Upsert
app.post('/api/gates/import', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'JSON file is required.' });
        }

        const rawData = fs.readFileSync(req.file.path, 'utf8');
        const gatesData = JSON.parse(rawData);

        // Clean up the temp file from disk immediately to save space
        fs.unlink(req.file.path, () => {});

        const bulkOps = [];

        // Logic to dynamically handle different standard JSON map formats
        if (Array.isArray(gatesData)) {
            // If the JSON is an array of objects: [ { icao: "KJFK", gates: [...] } ]
            for (const item of gatesData) {
                const code = item.icao || item.airport || item.airportCode || item.id;
                if (code) {
                    bulkOps.push({
                        updateOne: {
                            filter: { airportCode: code.toUpperCase() },
                            update: { $set: { gates: item.gates || item, updatedAt: new Date() } },
                            upsert: true
                        }
                    });
                }
            }
        } else {
            // If the JSON is an object with airport codes as keys: { "KJFK": [...], "EGLL": [...] }
            for (const [code, gates] of Object.entries(gatesData)) {
                bulkOps.push({
                    updateOne: {
                        filter: { airportCode: code.toUpperCase() },
                        update: { $set: { gates: gates, updatedAt: new Date() } },
                        upsert: true
                    }
                });
            }
        }

        if (bulkOps.length > 0) {
            await AirportGate.bulkWrite(bulkOps);
            res.json({ message: `✅ Successfully imported gates for ${bulkOps.length} airports into MongoDB.` });
        } else {
            res.status(400).json({ message: 'Could not parse airport codes from the provided JSON structure.' });
        }

    } catch (error) {
        if (req.file) fs.unlink(req.file.path, () => {});
        console.error('Gates Import Error:', error);
        res.status(500).json({ message: 'Failed to import gates data to MongoDB.' });
    }
});

// GET: Fetch gates for a specific airport (Optimized for constant calling)
app.get('/api/gates/:icao', async (req, res) => {
    try {
        const airportCode = req.params.icao.toUpperCase();
        const airportData = await AirportGate.findOne({ airportCode }).lean(); // .lean() makes query faster

        if (!airportData) {
            return res.status(404).json({ message: `No gates found for airport ${airportCode}` });
        }

        res.json(airportData.gates);
    } catch (error) {
        console.error('Gates Fetch Error:', error);
        res.status(500).json({ message: 'Failed to fetch gates.' });
    }
});

// GET: Fetch all gates (Use with caution if dataset is massive)
app.get('/api/gates', async (req, res) => {
    try {
        const allGates = await AirportGate.find({}).lean();
        res.json(allGates);
    } catch (error) {
        console.error('Global Gates Fetch Error:', error);
        res.status(500).json({ message: 'Failed to fetch global gates dataset.' });
    }
});


/* =========================
 * LEADERBOARD API
 * ========================= */

// POST: Track a view (Counts unique viewers per flight per day)
// Strategy: try to claim a (date, pilot, flight, viewer) slot via insert. If
// the unique index rejects with E11000, this viewer already counted this
// flight today and we short-circuit. Otherwise atomically `$inc` the stats
// counter — no growing arrays, no full-doc rewrites, safe under concurrency.
//
// `flightId` is optional for backwards compatibility with older clients; when
// absent we bucket into NO_FLIGHT so the view still counts somewhere.
app.post('/api/leaderboard/track', async (req, res) => {
    try {
        const { pilotUserId, pilotName, flightId } = req.body;
        if (!pilotUserId || !pilotName) {
            return res.status(400).json({ message: 'Missing pilot info' });
        }

        const date = getTodayString();
        const viewerIp = req.ip || req.connection.remoteAddress;
        const viewerHash = hashIp(viewerIp);
        const fid = (typeof flightId === 'string' && flightId.length) ? flightId : NO_FLIGHT;

        try {
            await DailyPilotView.create({ date, pilotUserId, flightId: fid, viewerHash });
        } catch (err) {
            if (err && err.code === 11000) {
                return res.json({ success: true, counted: false });
            }
            throw err;
        }

        await DailyPilotStats.updateOne(
            { date, pilotUserId, flightId: fid },
            {
                $inc: { viewCount: 1 },
                $set: { pilotName },
                $setOnInsert: { createdAt: new Date() }
            },
            { upsert: true }
        );

        res.json({ success: true, counted: true });
    } catch (error) {
        console.error('Track View Error:', error);
        res.status(500).json({ message: 'Error tracking view' });
    }
});

// GET: Top Most Tracked flights today.
//
//   ?limit=N          Cap how many rows to return (default 3, max 50).
//   ?groupBy=pilot    Aggregate per pilot instead of per flight (legacy
//                     shape). Useful for callers that don't care which
//                     specific flight is being tracked.
//
// Per-flight rows include `pilotUserId` and `flightId` so the caller can
// pinpoint exactly which live flight to focus on. NO_FLIGHT buckets are
// filtered out of per-flight responses (they represent pre-flightId
// clients with no flight to point at) but still feed the pilot rollup.
app.get('/api/leaderboard/top', async (req, res) => {
    try {
        const date = getTodayString();
        const rawLimit = parseInt(req.query.limit, 10);
        const limit = Math.max(1, Math.min(isNaN(rawLimit) ? 3 : rawLimit, 50));
        const groupBy = (req.query.groupBy || '').toLowerCase();

        if (groupBy === 'pilot') {
            const rows = await DailyPilotStats.aggregate([
                { $match: { date } },
                { $group: {
                    _id: '$pilotUserId',
                    pilotName: { $last: '$pilotName' },
                    viewCount: { $sum: '$viewCount' }
                } },
                { $sort: { viewCount: -1 } },
                { $limit: limit },
                { $project: {
                    _id: 0,
                    pilotUserId: '$_id',
                    pilotName: 1,
                    viewCount: 1
                } }
            ]);
            return res.json(rows);
        }

        const rows = await DailyPilotStats
            .find({ date, flightId: { $ne: NO_FLIGHT } })
            .sort({ viewCount: -1 })
            .limit(limit)
            .select('pilotName pilotUserId flightId viewCount -_id')
            .lean();

        res.json(rows);
    } catch (error) {
        console.error('Leaderboard Fetch Error:', error);
        res.status(500).json({ message: 'Error fetching leaderboard' });
    }
});


/* =========================
 * IMAGE PROXY FOR SCREENSHOTS
 * ========================= */
app.get('/api/image-proxy', async (req, res) => {
    const imageUrl = req.query.url;
    if (!imageUrl) {
        return res.status(400).send('No URL provided');
    }

    try {
        // Fetch the external image as a stream
        const response = await axios({
            method: 'get',
            url: imageUrl,
            responseType: 'stream'
        });

        // 1. Force Allow Origin * (The magic permission slip)
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
        res.header("Access-Control-Allow-Headers", "Content-Type");

        // 2. Forward the content type (png, jpg, webp, etc.)
        if (response.headers['content-type']) {
            res.header("Content-Type", response.headers['content-type']);
        }

        // 3. Pipe the image data straight to the frontend
        response.data.pipe(res);

    } catch (error) {
        console.error("Image Proxy Error:", error.message);
        res.status(500).send('Failed to fetch image');
    }
});

/* =========================
 * FLIGHT TRAILS STORAGE
 * ========================= */

// GET: Fetch a user's trails
app.get('/api/trails/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const prefix = `trails/${userId}/`;
        const cmd = new ListObjectsV2Command({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Prefix: prefix
        });
        const data = await s3Client.send(cmd);
        
        if (!data.Contents || data.Contents.length === 0) {
            return res.json([]);
        }

        // Return list of trails with public URLs
        const trails = data.Contents.map(f => ({
            flightId: f.Key.split('/').pop().replace('.json', ''),
            date: f.LastModified,
            size: f.Size,
            url: `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${f.Key}`
        }));

        // Sort Newest First
        trails.sort((a, b) => b.date - a.date);

        res.json(trails);
    } catch (e) {
        console.error("Trail Fetch Error:", e);
        res.status(500).json({ message: "Failed to fetch trails" });
    }
});

// POST: Save or Append to a completed flight trail
app.post('/api/trails', async (req, res) => {
    try {
        const { userId, flightId, trail } = req.body;
        
        if (!userId || !flightId || !trail || !Array.isArray(trail)) {
            return res.status(400).json({ message: 'Missing data or invalid trail format' });
        }

        const folderPrefix = `trails/${userId}/`;
        const newFileKey = `${folderPrefix}${flightId}.json`;
        
        let finalTrail = trail;
        let isUpdate = false;

        // 1. CHECK & MERGE: Look for existing trail in S3
        try {
            console.log(`🔍 Checking for existing trail: ${newFileKey}`);
            const getCmd = new GetObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET_NAME,
                Key: newFileKey
            });
            
            const { Body } = await s3Client.send(getCmd);
            const existingData = await streamToString(Body);
            const existingJson = JSON.parse(existingData);

            if (Array.isArray(existingJson)) {
                console.log(`🧩 Found existing trail (${existingJson.length} points). Merging...`);
                
                // Combine old + new
                finalTrail = existingJson.concat(trail);

                // OPTIONAL: Sort by timestamp to ensure correct order
                finalTrail.sort((a, b) => a.t - b.t);

                // OPTIONAL: Deduplicate (remove points with identical timestamps)
                finalTrail = finalTrail.filter((item, index, self) => 
                    index === 0 || item.t !== self[index - 1].t
                );
                
                isUpdate = true;
            }
        } catch (err) {
            // NoSuchKey means file doesn't exist yet, which is fine. We just create it.
            if (err.name !== 'NoSuchKey') {
                console.error("⚠️ Error checking S3 for existing trail:", err.message);
            }
        }

        // 2. PRUNE: Remove files older than 48 hours (Only runs if this is a NEW file)
        // We skip this heavy listing operation on mere updates to save performance
        if (!isUpdate) {
            const listCmd = new ListObjectsV2Command({
                Bucket: process.env.AWS_S3_BUCKET_NAME,
                Prefix: folderPrefix
            });
            
            const existing = await s3Client.send(listCmd);
            const files = existing.Contents || [];

            const limitTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
            const keepFiles = [];
            const deletePromises = [];

            for (const file of files) {
                if (file.LastModified < limitTime) {
                    console.log(`🗑️ Expiring old trail: ${file.Key}`);
                    deletePromises.push(s3Client.send(new DeleteObjectCommand({
                        Bucket: process.env.AWS_S3_BUCKET_NAME, Key: file.Key
                    })));
                } else {
                    keepFiles.push(file);
                }
            }

            // LIMIT: Max 3 recent flights
            keepFiles.sort((a, b) => a.LastModified - b.LastModified);
            
            // Check if we are accidentally creating a 4th file
            // (Note: We already know this is not an update to an existing file key)
            if (keepFiles.length >= 3) {
                const oldest = keepFiles[0];
                console.log(`🗑️ Max 3 reached. Deleting oldest: ${oldest.Key}`);
                deletePromises.push(s3Client.send(new DeleteObjectCommand({
                    Bucket: process.env.AWS_S3_BUCKET_NAME, Key: oldest.Key
                })));
            }

            if (deletePromises.length > 0) await Promise.all(deletePromises);
        }

        // 3. SAVE FINAL TRAIL (Compressed JSON)
        const bodyBuffer = Buffer.from(JSON.stringify(finalTrail));

        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: newFileKey,
            Body: bodyBuffer,
            ContentType: 'application/json',
            CacheControl: 'no-cache' 
        }));

        console.log(`💾 Saved trail: ${newFileKey} (Total: ${finalTrail.length} points)`);
        res.json({ ok: true, merged: isUpdate });

    } catch (e) {
        console.error("Trail Save Error:", e);
        res.status(500).json({ message: "Failed to save trail" });
    }
});


// GET: Fetch all aircraft contributions
app.get('/api/aircraft', async (req, res) => {
    try {
        const aircraft = await CommunityAircraft.find().sort({ uploadedAt: -1 });
        res.json(aircraft);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error fetching aircraft.' });
    }
});

// GET: Find aircraft by Type AND Livery (or return a placeholder)
app.get('/api/aircraft/lookup', async (req, res) => {
    try {
        // 1. Support both internal names (type/tail) and JSON names (model/registration)
        const { type, model, livery, liveryName, tail, registration } = req.query; 

        // 2. Normalize values: prioritize provided data, then fall back
        const finalType = type || model;
        const finalLivery = liveryName || livery;
        const finalTail = (tail || registration || "").toUpperCase();

        if (!finalType && !finalLivery && !finalTail) {
            return res.status(400).json({ message: 'At least one search parameter is required.' });
        }

        // 3. Build the MongoDB Query
        let query = {};
        if (finalType) query.aircraftType = { $regex: finalType, $options: 'i' };
        if (finalLivery) query.liveryName = { $regex: finalLivery, $options: 'i' };
        if (finalTail) query.tailNumber = finalTail;

        const results = await CommunityAircraft.find(query);

        // 4. FIX: If no results found, return placeholder using the normalized 'finalTail'
        if (results.length === 0) {
            return res.json({
                contributorName: "System",
                aircraftType: finalType || "Unknown",
                liveryName: finalLivery || "Standard",
                tailNumber: finalTail || "N/A", // This will now correctly show "3B-NBP"
                imageUrl: null,
                imageUrls: [],
                isPlaceholder: true,
                uploadedAt: new Date()
            });
        }

        // --- EXISTING INTELLIGENT SORTING LOGIC ---
        if (finalLivery) {
            const searchLower = finalLivery.toLowerCase();
            const exactMatch = results.find(
                item => item.liveryName.toLowerCase() === searchLower
            );
            if (exactMatch) return res.json(exactMatch);
        }

        res.json(results[0]); 

    } catch (error) {
        console.error('Error looking up aircraft:', error);
        res.status(500).json({ message: 'Error performing lookup.' });
    }
});

// GET: Admin System Stats (New - Includes S3 & DB Stats)
app.get('/api/admin/stats', async (req, res) => {
    try {
        // 1. Get MongoDB Stats
        const dbStats = await mongoose.connection.db.stats();
        const docCount = await CommunityAircraft.countDocuments();
        
        // 2. Get Server Memory Usage (RSS = Resident Set Size)
        const memoryUsage = process.memoryUsage();

        // 3. Get S3 Storage Metrics from CloudWatch (Fast & Cheap)
        let s3SizeBytes = 0;

        try {
            const command = new GetMetricStatisticsCommand({
                Namespace: 'AWS/S3',
                MetricName: 'BucketSizeBytes',
                Dimensions: [
                    { Name: 'BucketName', Value: process.env.AWS_S3_BUCKET_NAME },
                    { Name: 'StorageType', Value: 'StandardStorage' }
                ],
                StartTime: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), 
                EndTime: new Date(),
                Period: 86400, 
                Statistics: ['Maximum'] 
            });
            
            const data = await cloudWatchClient.send(command);
            
            if (data.Datapoints && data.Datapoints.length > 0) {
                data.Datapoints.sort((a, b) => b.Timestamp - a.Timestamp);
                s3SizeBytes = data.Datapoints[0].Maximum;
            }
        } catch (s3Error) {
            console.error('S3 Stats Error (Non-fatal):', s3Error);
        }
        
        res.json({
            status: 'online',
            aircraftCount: docCount,
            dbSizeBytes: dbStats.storageSize, 
            dbDataSizeBytes: dbStats.dataSize, 
            serverMemoryBytes: memoryUsage.rss,
            uptimeSeconds: process.uptime(),
            s3SizeBytes: s3SizeBytes
        });
    } catch (error) {
        console.error('Stats Error:', error);
        res.status(500).json({ message: 'Error fetching system stats.' });
    }
});

// POST: Upload a new aircraft (supports up to MAX_AIRCRAFT_IMAGES images)
app.post('/api/aircraft', uploadAircraftImages, async (req, res) => {
    const files = collectUploadedImages(req);
    try {
        if (files.length === 0) return res.status(400).json({ message: 'At least one image file is required.' });

        // Destructure with mapping support for incoming external JSON keys
        const {
            contributorName = "System",
            aircraftType,
            model,
            liveryName,
            livery,
            tailNumber,
            registration
        } = req.body;

        // Resolve which values to use (internal names vs incoming json names)
        const finalType = aircraftType || model;
        const finalLivery = liveryName || livery;
        const finalTail = (tailNumber || registration || "").toUpperCase();

        if (!finalType || !finalLivery || !finalTail) {
            // Clean up temp files if validation fails
            cleanupTempFiles(files);
            return res.status(400).json({ message: 'All fields (Type/Model, Livery, Tail/Registration) are required.' });
        }

        // Process and upload each image to S3 (order preserved)
        const imageUrls = [];
        for (const file of files) {
            imageUrls.push(await processAndUploadAircraftImage(file, finalTail));
        }

        // Clean up local temp files to free up disk space
        cleanupTempFiles(files);

        const newEntry = new CommunityAircraft({
            contributorName,
            aircraftType: finalType,
            liveryName: finalLivery,
            tailNumber: finalTail,
            imageUrls,
            imageUrl: imageUrls[0] // Primary image kept in sync for backward compatibility
        });

        await newEntry.save();

        await sendDiscordWebhook(newEntry);

        res.status(201).json({ message: 'Aircraft uploaded successfully!', data: newEntry });

    } catch (error) {
        // Ensure cleanup happens even on error
        cleanupTempFiles(files);

        console.error('Upload Error:', error);
        res.status(500).json({ message: 'Server error during upload.' });
    }
});

const syncAircraftDatabase = async (jsonList) => {
    for (const ac of jsonList) {
        // Map the JSON keys to your local variables
        const registration = ac.registration ? ac.registration.toUpperCase() : null; 
        const model = ac.model || "Unknown";
        const livery = ac.livery || "Standard";

        if (!registration || registration === "N/A") continue;

        // 1. Check if a valid record already exists for this registration
        const exists = await CommunityAircraft.findOne({ tailNumber: registration });

        if (!exists) {
            // 2. SEARCH FOR "BROKEN" RECORDS: 
            // Look for a record that matches this Type/Livery but has no valid Registration
            const placeholder = await CommunityAircraft.findOne({
                aircraftType: model,
                liveryName: livery,
                $or: [
                    { tailNumber: "N/A" },
                    { tailNumber: "" },
                    { tailNumber: { $exists: false } },
                    { tailNumber: null }
                ]
            });

            if (placeholder) {
                console.log(`🔧 Patching placeholder for ${model} (${livery}) with Registration: ${registration}`);
                placeholder.tailNumber = registration;
                await placeholder.save();
            } else {
                // 3. If no placeholder exists, create a fresh record
                console.log(`🆕 Pre-creating record for: ${registration}`);
                await CommunityAircraft.create({
                    contributorName: "System",
                    aircraftType: model, 
                    liveryName: livery,
                    tailNumber: registration,
                    imageUrl: null 
                });
            }
        }
    }
};

// PATCH: Toggle the "needs update" flag
app.patch('/api/aircraft/:id/flag', async (req, res) => {
    try {
        const { id } = req.params;
        const entry = await CommunityAircraft.findById(id);

        if (!entry) return res.status(404).json({ message: 'Aircraft not found.' });

        // Flip the boolean
        entry.needsUpdate = !entry.needsUpdate;
        await entry.save();

        res.json({ message: 'Update flag toggled successfully.', data: entry });
    } catch (error) {
        console.error('Flag Toggle Error:', error);
        res.status(500).json({ message: 'Server error during flag toggle.' });
    }
});

// PUT: Update an existing aircraft (replaces the full image set when new images are sent)
app.put('/api/aircraft/:id', uploadAircraftImages, async (req, res) => {
    const files = collectUploadedImages(req);
    try {
        const { id } = req.params;

        // Map mapping support for incoming external JSON keys
        const {
            contributorName,
            aircraftType,
            model,
            liveryName,
            livery,
            tailNumber,
            registration
        } = req.body;

        const finalType = aircraftType || model;
        const finalLivery = liveryName || livery;
        const finalTail = tailNumber || registration;

        const existingEntry = await CommunityAircraft.findById(id);
        if (!existingEntry) {
            // Clean up if files uploaded but record not found
            cleanupTempFiles(files);
            return res.status(404).json({ message: 'Aircraft not found.' });
        }

        if (files.length > 0) {
            console.log(`Processing ${files.length} new image(s) for update: ${id}`);

            const tailRef = finalTail || existingEntry.tailNumber;
            const newImageUrls = [];
            for (const file of files) {
                newImageUrls.push(await processAndUploadAircraftImage(file, tailRef));
            }

            // Delete the previous image set now that new ones are in place
            await deleteAircraftImages(existingEntry);

            existingEntry.imageUrls = newImageUrls;
            existingEntry.imageUrl = newImageUrls[0];

            // Clean up local temp files
            cleanupTempFiles(files);

            // CLEAR THE FLAG: New images were uploaded, so it no longer needs an update
            existingEntry.needsUpdate = false;
        }

        if (contributorName) existingEntry.contributorName = contributorName;
        if (finalType) existingEntry.aircraftType = finalType;
        if (finalLivery) existingEntry.liveryName = finalLivery;
        if (finalTail) existingEntry.tailNumber = finalTail.toUpperCase();

        await existingEntry.save();

        res.json({ message: 'Aircraft updated successfully!', data: existingEntry });

    } catch (error) {
        // FIX: Ensure cleanup on error
        cleanupTempFiles(files);

        console.error('Update Error:', error);
        res.status(500).json({ message: 'Server error during update.' });
    }
});

// DELETE: Remove an aircraft
app.delete('/api/aircraft/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const entry = await CommunityAircraft.findById(id);

        if (!entry) return res.status(404).json({ message: 'Aircraft not found.' });

        await deleteAircraftImages(entry);
        await CommunityAircraft.findByIdAndDelete(id);

        res.json({ message: 'Aircraft deleted successfully.' });
    } catch (error) {
        console.error('Delete Error:', error);
        res.status(500).json({ message: 'Server error during deletion.' });
    }
});

/* =========================
 * AIRPORT IMAGES API
 * ========================= */

// POST: Upload Airport Image
app.post('/api/airports', upload.single('image'), async (req, res) => {
    try {
        const { icao, contributorName } = req.body;

        if (!req.file || !icao) {
            if (req.file) fs.unlink(req.file.path, () => {});
            return res.status(400).json({ message: 'ICAO and Image are required.' });
        }

        const imageUrl = await uploadAirportImage(s3Client, req.file, icao, contributorName);
        
        res.status(201).json({ 
            message: 'Airport image uploaded!', 
            url: imageUrl 
        });
    } catch (error) {
        if (req.file) fs.unlink(req.file.path, () => {});
        console.error('Airport Upload Error:', error);
        res.status(500).json({ message: 'Error uploading airport image.' });
    }
});

// GET: Lookup Airport Info
app.get('/api/airports/:icao', async (req, res) => {
    try {
        const info = await getAirportInfo(s3Client, req.params.icao);
        if (!info) {
            return res.status(404).json({ message: 'No image found for this airport.' });
        }
        res.json(info);
    } catch (error) {
        console.error('Airport Lookup Error:', error);
        res.status(500).json({ message: 'Error fetching airport info.' });
    }
});

/**
 * DELETE: Remove all images/data for an airport
 */
app.delete('/api/airports/:icao', async (req, res) => {
    try {
        const success = await deleteAirportImages(s3Client, req.params.icao);
        if (!success) return res.status(404).json({ message: 'No images found for this ICAO.' });
        
        res.json({ message: `All data for ${req.params.icao.toUpperCase()} deleted successfully.` });
    } catch (error) {
        console.error('Airport Delete Error:', error);
        res.status(500).json({ message: 'Error deleting airport data.' });
    }
});

// GET: Fetch all airports that have images
app.get('/api/airports', async (req, res) => {
    try {
        const command = new ListObjectsV2Command({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Prefix: 'airports/', // Look in the airports folder
        });

        const data = await s3Client.send(command);
        
        if (!data.Contents) return res.json([]);

        // Filter for .webp or .png files and extract ICAO from filename
        // Filename format: airports/icao-timestamp.webp
        const airportList = data.Contents
            .filter(item => item.Key.includes('-'))
            .map(item => {
                const filename = item.Key.split('/').pop();
                const icao = filename.split('-')[0].toUpperCase();
                return {
                    icao: icao,
                    imageUrl: `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${item.Key}`,
                    lastUpdated: item.LastModified
                };
            });

        // Remove duplicates (if multiple images exist for one ICAO)
        const uniqueAirports = Array.from(new Map(airportList.map(item => [item.icao, item])).values());

        res.json(uniqueAirports);
    } catch (error) {
        console.error('Error fetching airport list:', error);
        res.status(500).json({ message: 'Error fetching gallery.' });
    }
});

/**
 * PUT: Update airport data or replace image
 */
app.put('/api/airports/:icao', upload.single('image'), async (req, res) => {
    try {
        const { icao } = req.params;
        const { contributorName } = req.body;

        // SCENARIO 1: Replacing the image
        if (req.file) {
            // Delete old images first to keep bucket clean
            await deleteAirportImages(s3Client, icao);
            // Upload new one
            const newUrl = await uploadAirportImage(s3Client, req.file, icao, contributorName);
            return res.json({ message: 'Airport image replaced!', url: newUrl });
        }

        // SCENARIO 2: Updating metadata only (Contributor name)
        if (contributorName) {
            await updateAirportMetadata(s3Client, icao, contributorName);
            return res.json({ message: 'Airport contributor updated!' });
        }

        res.status(400).json({ message: 'Provide a new image or contributor name to update.' });
    } catch (error) {
        if (req.file) fs.unlink(req.file.path, () => {});
        console.error('Airport Update Error:', error);
        res.status(500).json({ message: 'Error updating airport data.' });
    }
});

// server.js

// 1. Serve static files from the root directory
// This allows the browser to find airports.js, images, and CSS
app.use(express.static(__dirname));

// 2. Specific route for the Airport Manager
// Accessible via yoursite.com/airports
app.get('/airports', (req, res) => {
    res.sendFile(path.join(__dirname, 'airports.html'));
});

// 3. Specific route for the Aircraft Database root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


app.get(/(.*)/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 5. START SERVER
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});