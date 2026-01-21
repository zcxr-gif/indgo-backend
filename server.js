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

// IMPORT THE BOT
const { startDiscordBot } = require('./bot');

// 1. INITIALIZE APP
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Allow all origins
// Increase limit for JSON body (trails can be large)
app.use(express.json({ limit: '10mb' })); 
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
    imageUrl: { type: String, required: false, default: null }, // Now optional
    uploadedAt: { type: Date, default: Date.now }
});

const CommunityAircraft = mongoose.model('CommunityAircraft', CommunityAircraftSchema);

/* =========================
 * NEW: LEADERBOARD SCHEMA
 * ========================= */
const DailyPilotStatsSchema = new mongoose.Schema({
    date: { type: String, required: true }, // Format: YYYY-MM-DD
    pilotUserId: { type: String, required: true },
    pilotName: { type: String, required: true },
    viewCount: { type: Number, default: 0 },
    // We store hashed IPs to ensure unique views per day
    uniqueViewers: { type: [String], default: [] } 
});

// Create a compound index for fast lookups
DailyPilotStatsSchema.index({ date: 1, pilotUserId: 1 }, { unique: true });

const DailyPilotStats = mongoose.model('DailyPilotStats', DailyPilotStatsSchema);

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
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// --- START THE BOT ---
// We pass the Model AND the S3 Client/Config to the bot
startDiscordBot(
    CommunityAircraft, 
    s3Client, 
    process.env.AWS_S3_BUCKET_NAME, 
    process.env.AWS_REGION
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
 * NEW: LEADERBOARD API
 * ========================= */

// POST: Track a view (Counts unique viewers per day)
app.post('/api/leaderboard/track', async (req, res) => {
    try {
        const { pilotUserId, pilotName } = req.body;
        if (!pilotUserId || !pilotName) {
            return res.status(400).json({ message: 'Missing pilot info' });
        }

        const date = getTodayString();
        const viewerIp = req.ip || req.connection.remoteAddress;
        const viewerHash = hashIp(viewerIp);

        // Find the record for this pilot today
        const stats = await DailyPilotStats.findOne({ date, pilotUserId });

        if (stats) {
            // Check if this viewer has already viewed this pilot today
            if (stats.uniqueViewers.includes(viewerHash)) {
                // Already viewed, do not increment
                return res.json({ success: true, counted: false });
            }

            // New unique viewer: Add hash and increment count
            stats.uniqueViewers.push(viewerHash);
            stats.viewCount += 1;
            // Update name just in case they changed it mid-flight
            stats.pilotName = pilotName; 
            await stats.save();
        } else {
            // Create new record for today
            await DailyPilotStats.create({
                date,
                pilotUserId,
                pilotName,
                viewCount: 1,
                uniqueViewers: [viewerHash]
            });
        }

        res.json({ success: true, counted: true });
    } catch (error) {
        console.error('Track View Error:', error);
        res.status(500).json({ message: 'Error tracking view' });
    }
});

// GET: Top 3 Most Tracked Pilots Today
app.get('/api/leaderboard/top', async (req, res) => {
    try {
        const date = getTodayString();

        const topPilots = await DailyPilotStats
            .find({ date })
            .sort({ viewCount: -1 }) // Highest views first
            .limit(3) // Top 3
            .select('pilotName viewCount -_id'); // Return clean data

        res.json(topPilots);
    } catch (error) {
        console.error('Leaderboard Fetch Error:', error);
        res.status(500).json({ message: 'Error fetching leaderboard' });
    }
});


/* =========================
 * NEW: IMAGE PROXY FOR SCREENSHOTS
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
 * NEW: FLIGHT TRAILS STORAGE
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

// POST: Upload a new aircraft
app.post('/api/aircraft', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'Image file is required.' });
        
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
            // Clean up temp file if validation fails
            if (req.file) fs.unlink(req.file.path, () => {});
            return res.status(400).json({ message: 'All fields (Type/Model, Livery, Tail/Registration) are required.' });
        }

        // 1. Process from DISK (req.file.path) instead of BUFFER
        const optimizedBuffer = await sharp(req.file.path)
            .resize({ width: 1920, withoutEnlargement: true }) 
            .webp({ quality: 80 }) 
            .toBuffer();

        const cleanTailName = finalTail.replace(/[^a-zA-Z0-9]/g, '');
        const fileName = `community-aircraft/${cleanTailName}-${Date.now()}.webp`;

        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: fileName,
            Body: optimizedBuffer,
            ContentType: 'image/webp',
        }));

        // 2. IMPORTANT: Delete the local temp file to free up disk space
        fs.unlink(req.file.path, (err) => {
            if (err) console.error("Failed to clean up temp file:", err);
        });

        const fileUrl = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;

        const newEntry = new CommunityAircraft({
            contributorName,
            aircraftType: finalType,
            liveryName: finalLivery,
            tailNumber: finalTail,
            imageUrl: fileUrl 
        });

        await newEntry.save();

        await sendDiscordWebhook(newEntry);

        res.status(201).json({ message: 'Aircraft uploaded successfully!', data: newEntry });

    } catch (error) {
        // Ensure cleanup happens even on error
        if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
        
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

// PUT: Update an existing aircraft
app.put('/api/aircraft/:id', upload.single('image'), async (req, res) => {
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
            // Clean up if file uploaded but record not found
            if (req.file) fs.unlink(req.file.path, () => {});
            return res.status(404).json({ message: 'Aircraft not found.' });
        }

        let updatedImageUrl = existingEntry.imageUrl;

        if (req.file) {
            console.log(`Processing new image for update: ${id}`);
            
            const optimizedBuffer = await sharp(req.file.path)
                .resize({ width: 1920, withoutEnlargement: true }) 
                .webp({ quality: 80 }) 
                .toBuffer();

            // Safe use of tail number for clean filename
            const cleanTailRef = (finalTail || existingEntry.tailNumber).replace(/[^a-zA-Z0-9]/g, '');
            const fileName = `community-aircraft/${cleanTailRef}-${Date.now()}.webp`;

            await s3Client.send(new PutObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET_NAME,
                Key: fileName,
                Body: optimizedBuffer,
                ContentType: 'image/webp',
            }));

            updatedImageUrl = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;

            if (existingEntry.imageUrl) {
                await deleteS3Object(existingEntry.imageUrl);
            }

            // FIX: Clean up local temp file
            fs.unlink(req.file.path, (err) => {
                if (err) console.error("Failed to clean up temp file:", err);
            });
        }

        if (contributorName) existingEntry.contributorName = contributorName;
        if (finalType) existingEntry.aircraftType = finalType;
        if (finalLivery) existingEntry.liveryName = finalLivery;
        if (finalTail) existingEntry.tailNumber = finalTail.toUpperCase();
        existingEntry.imageUrl = updatedImageUrl;

        await existingEntry.save();

        res.json({ message: 'Aircraft updated successfully!', data: existingEntry });

    } catch (error) {
        // FIX: Ensure cleanup on error
        if (req.file && req.file.path) fs.unlink(req.file.path, () => {});

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

        await deleteS3Object(entry.imageUrl);
        await CommunityAircraft.findByIdAndDelete(id);

        res.json({ message: 'Aircraft deleted successfully.' });
    } catch (error) {
        console.error('Delete Error:', error);
        res.status(500).json({ message: 'Server error during deletion.' });
    }
});

/* =========================
 * NEW: AIRPORT IMAGES API
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

app.use(express.static(__dirname)); 

// 2. Specific route for the Airport Manager
app.get('/airports', (req, res) => {
    res.sendFile(path.join(__dirname, 'airports.html'));
});

// 3. The Root Route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 4. Catch-all for React Router (Modern Syntax)
// Using '(.*)' as a string prevents the "Missing parameter name" error
app.get('(.*)', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 5. START SERVER
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});