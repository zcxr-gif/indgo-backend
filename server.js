// server.js
// A lightweight backend for Community Aircraft Contributions only.

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { CloudWatchClient, GetMetricStatisticsCommand } = require('@aws-sdk/client-cloudwatch');
const sharp = require('sharp'); // Image processing library
require('dotenv').config();

// 1. INITIALIZE APP
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Allow all origins
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 2. CONNECT TO MONGODB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// 3. DEFINE DATABASE SCHEMA
const CommunityAircraftSchema = new mongoose.Schema({
    contributorName: { type: String, required: true }, 
    aircraftType: { type: String, required: true },    
    liveryName: { type: String, required: true },      
    tailNumber: { type: String, required: true },      
    imageUrl: { type: String, required: true },        
    uploadedAt: { type: Date, default: Date.now }
});

const CommunityAircraft = mongoose.model('CommunityAircraft', CommunityAircraftSchema);

// 4. CONFIGURE AWS CLIENTS

// S3 Client (Storage)
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
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // Allow up to 10MB input
});

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

// 5. API ROUTES

// Health Check
app.get('/', (req, res) => {
    res.send('Community Aircraft Backend is Running.');
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
            // We ask for the "BucketSizeBytes" metric for the last 2 days
            const command = new GetMetricStatisticsCommand({
                Namespace: 'AWS/S3',
                MetricName: 'BucketSizeBytes',
                Dimensions: [
                    { Name: 'BucketName', Value: process.env.AWS_S3_BUCKET_NAME },
                    { Name: 'StorageType', Value: 'StandardStorage' }
                ],
                StartTime: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
                EndTime: new Date(),
                Period: 86400, // 1 day intervals
                Statistics: ['Maximum'] // Get the max size recorded
            });
            
            const data = await cloudWatchClient.send(command);
            
            // If data exists, grab the latest datapoint
            if (data.Datapoints && data.Datapoints.length > 0) {
                // Sort by timestamp to get the most recent reading
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
        
        const { contributorName, aircraftType, liveryName, tailNumber } = req.body;
        if (!contributorName || !aircraftType || !liveryName || !tailNumber) {
            return res.status(400).json({ message: 'All fields are required.' });
        }

        // Image Processing
        const optimizedBuffer = await sharp(req.file.buffer)
            .resize({ width: 1920, withoutEnlargement: true }) 
            .webp({ quality: 80 }) 
            .toBuffer();

        const cleanTail = tailNumber.replace(/[^a-zA-Z0-9]/g, '');
        const fileName = `community-aircraft/${cleanTail}-${Date.now()}.webp`;

        await s3Client.send(new PutObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: fileName,
            Body: optimizedBuffer,
            ContentType: 'image/webp',
        }));

        const fileUrl = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;

        const newEntry = new CommunityAircraft({
            contributorName,
            aircraftType,
            liveryName,
            tailNumber: tailNumber.toUpperCase(),
            imageUrl: fileUrl 
        });

        await newEntry.save();
        res.status(201).json({ message: 'Aircraft uploaded successfully!', data: newEntry });

    } catch (error) {
        console.error('Upload Error:', error);
        res.status(500).json({ message: 'Server error during upload.' });
    }
});

// PUT: Update an existing aircraft
app.put('/api/aircraft/:id', upload.single('image'), async (req, res) => {
    try {
        const { id } = req.params;
        const { contributorName, aircraftType, liveryName, tailNumber } = req.body;

        // 1. Find existing entry
        const existingEntry = await CommunityAircraft.findById(id);
        if (!existingEntry) return res.status(404).json({ message: 'Aircraft not found.' });

        let updatedImageUrl = existingEntry.imageUrl;

        // 2. Check if a NEW image was uploaded
        if (req.file) {
            console.log(`Processing new image for update: ${id}`);
            
            // Optimization
            const optimizedBuffer = await sharp(req.file.buffer)
                .resize({ width: 1920, withoutEnlargement: true }) 
                .webp({ quality: 80 }) 
                .toBuffer();

            const cleanTail = tailNumber.replace(/[^a-zA-Z0-9]/g, '');
            const fileName = `community-aircraft/${cleanTail}-${Date.now()}.webp`;

            // Upload new image
            await s3Client.send(new PutObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET_NAME,
                Key: fileName,
                Body: optimizedBuffer,
                ContentType: 'image/webp',
            }));

            updatedImageUrl = `https://${process.env.AWS_S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;

            // DELETE OLD IMAGE to save space
            if (existingEntry.imageUrl) {
                await deleteS3Object(existingEntry.imageUrl);
            }
        }

        // 3. Update Database
        existingEntry.contributorName = contributorName;
        existingEntry.aircraftType = aircraftType;
        existingEntry.liveryName = liveryName;
        existingEntry.tailNumber = tailNumber.toUpperCase();
        existingEntry.imageUrl = updatedImageUrl;

        await existingEntry.save();

        res.json({ message: 'Aircraft updated successfully!', data: existingEntry });

    } catch (error) {
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

app.get(/(.*)/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 6. START SERVER
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});