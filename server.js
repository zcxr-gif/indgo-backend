// server.js
// A lightweight backend for Community Aircraft Contributions only.

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multerS3 = require('multer-s3');
require('dotenv').config();

// 1. INITIALIZE APP
const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Allow all origins (or configure specific domains if needed)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 2. CONNECT TO MONGODB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// 3. DEFINE DATABASE SCHEMA
const CommunityAircraftSchema = new mongoose.Schema({
    contributorName: { type: String, required: true }, // "User who gave it"
    aircraftType: { type: String, required: true },    // e.g. "Boeing 737"
    liveryName: { type: String, required: true },      // e.g. "IndGo Blue"
    tailNumber: { type: String, required: true },      // e.g. "VT-XYZ"
    imageUrl: { type: String, required: true },        // AWS S3 URL
    uploadedAt: { type: Date, default: Date.now }
});

const CommunityAircraft = mongoose.model('CommunityAircraft', CommunityAircraftSchema);

// 4. CONFIGURE AWS S3 (For Image Storage)
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

// Configure Multer to upload directly to S3
const upload = multer({
    storage: multerS3({
        s3: s3Client,
        bucket: process.env.AWS_S3_BUCKET_NAME,
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: function (req, file, cb) {
            // Create a clean filename: "tailnumber-timestamp.ext"
            const cleanTail = req.body.tailNumber ? req.body.tailNumber.replace(/[^a-zA-Z0-9]/g, '') : 'unknown';
            const uniqueSuffix = Date.now();
            const fileName = `community-aircraft/${cleanTail}-${uniqueSuffix}${path.extname(file.originalname)}`;
            cb(null, fileName);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 } // Limit file size to 5MB
});

// Helper to delete image from S3 when an entry is deleted
const deleteS3Object = async (imageUrl) => {
    if (!imageUrl) return;
    try {
        const url = new URL(imageUrl);
        const key = url.pathname.substring(1); // Remove leading '/'
        const command = new DeleteObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET_NAME,
            Key: key,
        });
        await s3Client.send(command);
        console.log(`Deleted S3 Object: ${key}`);
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

// POST: Upload a new aircraft (Image + Data)
app.post('/api/aircraft', upload.single('image'), async (req, res) => {
    try {
        // Validate request
        if (!req.file) {
            return res.status(400).json({ message: 'Image file is required.' });
        }
        
        const { contributorName, aircraftType, liveryName, tailNumber } = req.body;
        
        if (!contributorName || !aircraftType || !liveryName || !tailNumber) {
            return res.status(400).json({ message: 'All fields are required.' });
        }

        // Create Database Entry
        const newEntry = new CommunityAircraft({
            contributorName,
            aircraftType,
            liveryName,
            tailNumber: tailNumber.toUpperCase(),
            imageUrl: req.file.location // The URL returned by S3
        });

        await newEntry.save();

        res.status(201).json({ 
            message: 'Aircraft uploaded successfully!', 
            data: newEntry 
        });

    } catch (error) {
        console.error('Upload Error:', error);
        res.status(500).json({ message: 'Server error during upload.' });
    }
});

// DELETE: Remove an aircraft
app.delete('/api/aircraft/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const entry = await CommunityAircraft.findById(id);

        if (!entry) {
            return res.status(404).json({ message: 'Aircraft not found.' });
        }

        // 1. Delete image from AWS
        await deleteS3Object(entry.imageUrl);

        // 2. Delete record from MongoDB
        await CommunityAircraft.findByIdAndDelete(id);

        res.json({ message: 'Aircraft deleted successfully.' });

    } catch (error) {
        console.error('Delete Error:', error);
        res.status(500).json({ message: 'Server error during deletion.' });
    }
});

// 6. START SERVER
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});