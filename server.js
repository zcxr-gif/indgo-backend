// server.js (Fully Updated)
// - Robust Google Sheets function with dynamic column mapping.
// - Advanced PIREP system with a staff review workflow.
// - Automatic rank promotions upon PIREP approval.
// - New endpoints for pilots and staff to manage PIREPs.
// - Cascade delete functionality for users and their associated data.

// 1. IMPORT DEPENDENCIES
const cors = require('cors');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const multerS3 = require('multer-s3');
const { google } = require('googleapis');
require('dotenv').config();

// 2. INITIALIZE EXPRESS APP & AWS S3 CLIENT
const app = express();
const PORT = process.env.PORT || 5000;

// Configure the AWS S3 client
const s3Client = new S3Client({
    region: process.env.AWS_REGION, // e.g., 'us-east-2'
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

// 3. MIDDLEWARE

// Whitelist your specific frontend URL (adjust if needed)
const corsOptions = {
    origin: 'https://indgo-va.netlify.app',
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());

// Multer configuration for AWS S3 uploads
const upload = multer({
    storage: multerS3({
        s3: s3Client,
        bucket: process.env.AWS_S3_BUCKET_NAME,
        contentType: multerS3.AUTO_CONTENT_TYPE,
        metadata: function (req, file, cb) {
            cb(null, { fieldName: file.fieldname });
        },
        key: function (req, file, cb) {
            let folder = 'misc/';
            if (file.fieldname === 'profilePicture') {
                folder = 'profiles/';
            } else if (file.fieldname === 'eventImage' || file.fieldname === 'highlightImage') {
                folder = 'community/';
            }
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const fileName = file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname);
            cb(null, folder + fileName);
        }
    })
});

// 4. CONNECT TO MONGODB DATABASE
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB connected successfully.'))
    .catch(err => console.error('MongoDB connection error:', err));

// 5. DEFINE SCHEMAS AND MODELS

// --- User Schema ---

const pilotRanks = [
    'Cadet', 'Second Officer', 'First Officer', 
    'Senior First Officer', 'Captain', 'Senior Captain'
];

const UserSchema = new mongoose.Schema({
    name: { type: String, default: 'New Staff Member' },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true },
    role: {
        type: String,
        enum: [
            'staff', 'pilot', 'admin',
            'Chief Executive Officer (CEO)', 'Chief Operating Officer (COO)', 'PIREP Manager (PM)',
            'Pilot Relations & Recruitment Manager (PR)', 'Technology & Design Manager (TDM)',
            'Head of Training (COT)', 'Chief Marketing Officer (CMO)', 'Route Manager (RM)',
            'Events Manager (EM)', 'Flight Instructor (FI)'
        ],
        default: 'pilot'
    },
    callsign: { type: String, default: null, sparse: true, trim: true, uppercase: true },
    rank: {
        type: String,
        enum: pilotRanks,
        default: 'Cadet'
    },
    flightHours: { type: Number, default: 0 },
    bio: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    discord: { type: String, default: '' },
    ifc: { type: String, default: '' },
    youtube: { type: String, default: '' },
    preferredContact: {
        type: String,
        enum: ['none', 'discord', 'ifc', 'youtube'],
        default: 'none'
    },
    createdAt: { type: Date, default: Date.now }
});

UserSchema.index({ callsign: 1 }, { unique: true, sparse: true });
const User = mongoose.model('User', UserSchema);

// --- Admin Log Schema ---
const AdminLogSchema = new mongoose.Schema({
    adminUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true, enum: ['ROLE_UPDATE', 'USER_DELETE'] },
    targetUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    details: { type: String, required: true },
    timestamp: { type: Date, default: Date.now }
});
const AdminLog = mongoose.model('AdminLog', AdminLogSchema);

// --- Event Schema ---
const EventSchema = new mongoose.Schema({
    title: { type: String, required: true },
    date: { type: Date, required: true },
    description: { type: String, required: true },
    imageUrl: { type: String },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
});
const Event = mongoose.model('Event', EventSchema);

// --- Highlight Schema ---
const HighlightSchema = new mongoose.Schema({
    title: { type: String, required: true },
    winnerName: { type: String, required: true },
    description: { type: String },
    imageUrl: { type: String, required: true },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
});
const Highlight = mongoose.model('Highlight', HighlightSchema);

// --- PIREP Schema (Enhanced for Review Workflow) ---
const PirepSchema = new mongoose.Schema({
    pilot: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    flightNumber: { type: String, required: true },
    departure: { type: String, required: true, uppercase: true, trim: true },
    arrival: { type: String, required: true, uppercase: true, trim: true },
    aircraft: { type: String, required: true },
    flightTime: { type: Number, required: true, min: 0.1 }, // In hours
    remarks: { type: String, trim: true },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date, default: null }
});
const Pirep = mongoose.model('Pirep', PirepSchema);

// 6. HELPER FUNCTION & AUTH MIDDLEWARE

// Helper function to delete an object from S3
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
        console.log(`Successfully deleted ${key} from S3.`);
    } catch (error) {
        console.error(`Failed to delete object from S3: ${imageUrl}`, error);
    }
};

// HELPER: Improved Google Sheets update function
const updateGoogleSheet = async (pilotData) => {
    // Ensure we have a callsign to work with, otherwise we can't update the sheet.
    if (!pilotData || !pilotData.callsign) {
        console.warn('updateGoogleSheet called without pilot data or callsign. Aborting sheet update.');
        return;
    }

    try {
        // 1. Authenticate with Google Sheets API
        const auth = new google.auth.GoogleAuth({
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: 'https://www.googleapis.com/auth/spreadsheets',
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = process.env.GOOGLE_SHEET_ID;
        const sheetName = 'Pilots'; // The name of the tab in your spreadsheet

        // 2. Get the header row to dynamically find column indexes
        const headerResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!1:1`, // Get the first row
        });

        const headers = headerResponse.data.values ? headerResponse.data.values[0] : [];
        
        // Map headers to their column index. This makes the code flexible.
        const columnMap = {};
        headers.forEach((header, index) => {
            columnMap[header] = index;
        });

        // Check if essential columns exist in the sheet
        const requiredColumns = ['Callsign', 'Name', 'Rank', 'Flight Hours'];
        for (const col of requiredColumns) {
            if (columnMap[col] === undefined) {
                throw new Error(`Missing required column in Google Sheet: "${col}"`);
            }
        }
        
        // 3. Find the pilot's row by searching the "Callsign" column
        const callsignColumnIndex = columnMap['Callsign'];
        const callsignColumnLetter = String.fromCharCode(65 + callsignColumnIndex); // A, B, C...

        const allCallsignsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!${callsignColumnLetter}2:${callsignColumnLetter}`, // Start from row 2
        });

        const allCallsigns = allCallsignsResponse.data.values ? allCallsignsResponse.data.values.flat() : [];
        const pilotRowIndex = allCallsigns.findIndex(cs => cs === pilotData.callsign);
        
        // 4. Prepare the data row in the correct order based on headers
        const fullRowData = new Array(headers.length).fill(null);
        fullRowData[columnMap['Callsign']] = pilotData.callsign;
        fullRowData[columnMap['Name']] = pilotData.name;
        fullRowData[columnMap['Rank']] = pilotData.rank;
        fullRowData[columnMap['Flight Hours']] = pilotData.flightHours;
        
        if (columnMap['Last Updated'] !== undefined) {
            fullRowData[columnMap['Last Updated']] = new Date().toISOString();
        }

        const resource = { values: [fullRowData] };

        // 5. Update the row if the pilot was found, or append a new row if not
        if (pilotRowIndex !== -1) {
            const targetRow = pilotRowIndex + 2;
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${sheetName}!A${targetRow}`,
                valueInputOption: 'USER_ENTERED',
                resource,
            });
            console.log(`Successfully updated sheet for callsign ${pilotData.callsign} on row ${targetRow}.`);
        } else {
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetName}!A1`,
                valueInputOption: 'USER_ENTERED',
                resource,
            });
            console.log(`Successfully appended new pilot with callsign ${pilotData.callsign} to sheet.`);
        }
    } catch (error) {
        console.error('Error updating Google Sheet:', error.message);
    }
};

// HELPER: Deletes a row from the Google Sheet based on a callsign
const deleteRowFromGoogleSheet = async (callsign) => {
    if (!callsign) {
        console.warn('deleteRowFromGoogleSheet called without a callsign. Aborting.');
        return;
    }

    try {
        // 1. Authenticate (same as your update function)
        const auth = new google.auth.GoogleAuth({
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: 'https://www.googleapis.com/auth/spreadsheets',
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = process.env.GOOGLE_SHEET_ID;
        const sheetName = 'Pilots';

        // 2. Get the sheet's metadata to find the sheetId (required for deletion)
        const spreadsheetMeta = await sheets.spreadsheets.get({ spreadsheetId });
        const sheet = spreadsheetMeta.data.sheets.find(s => s.properties.title === sheetName);
        if (!sheet) {
            throw new Error(`Sheet with name "${sheetName}" not found.`);
        }
        const sheetId = sheet.properties.sheetId;

        // 3. Find the pilot's row index (similar to your update function)
        const headerResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!1:1`,
        });
        const headers = headerResponse.data.values ? headerResponse.data.values[0] : [];
        const callsignColumnIndex = headers.findIndex(h => h === 'Callsign');
        if (callsignColumnIndex === -1) {
            throw new Error('Could not find "Callsign" column in the sheet.');
        }

        const callsignColumnLetter = String.fromCharCode(65 + callsignColumnIndex);
        const allCallsignsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!${callsignColumnLetter}2:${callsignColumnLetter}`,
        });

        const allCallsigns = allCallsignsResponse.data.values ? allCallsignsResponse.data.values.flat() : [];
        const pilotRowIndex = allCallsigns.findIndex(cs => cs === callsign); // 0-based index

        // 4. If the pilot is found, execute the deletion request
        if (pilotRowIndex !== -1) {
            const targetRow = pilotRowIndex + 1; // The API needs the row index within the data, starting from 0 for row 2
            
            const request = {
                spreadsheetId,
                resource: {
                    requests: [{
                        deleteDimension: {
                            range: {
                                sheetId: sheetId,
                                dimension: 'ROWS',
                                startIndex: targetRow, // 0-based index of the row to delete
                                endIndex: targetRow + 1
                            }
                        }
                    }]
                }
            };
            
            await sheets.spreadsheets.batchUpdate(request);
            console.log(`Successfully deleted row for callsign ${callsign} from Google Sheet.`);
        } else {
            console.log(`Callsign ${callsign} not found in Google Sheet. No row deleted.`);
        }
    } catch (error) {
        console.error(`Error deleting row from Google Sheet for callsign ${callsign}:`, error.message);
    }
};

// --- Rank Promotion Helper ---
const rankThresholds = {
    'Cadet': 0, 'Second Officer': 10, 'First Officer': 50,
    'Senior First Officer': 150, 'Captain': 400, 'Senior Captain': 1000
};

const checkAndApplyRankUpdate = (pilot) => {
    const currentHours = pilot.flightHours;
    const currentRank = pilot.rank;
    let newRank = currentRank;
    // Iterate from highest rank to lowest to find the best fit
    for (let i = pilotRanks.length - 1; i >= 0; i--) {
        const rankName = pilotRanks[i];
        if (currentHours >= rankThresholds[rankName]) {
            newRank = rankName;
            break;
        }
    }
    if (newRank !== currentRank) {
        pilot.rank = newRank;
        return { promoted: true, rank: newRank };
    }
    return { promoted: false };
};

// Simple callsign validator
const isValidCallsign = cs => /^[A-Z0-9-]{2,15}$/.test(cs);

// Auth middleware
const authMiddleware = (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
        return res.status(401).json({ message: 'Access denied. No token provided.' });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (ex) {
        res.status(400).json({ message: 'Invalid token.' });
    }
};

// Role-based middlewares
const isAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ message: 'Access denied. Administrator privileges required.' });
    }
};

const isCommunityManager = (req, res, next) => {
    const authorizedRoles = [
        'Chief Executive Officer (CEO)', 'Chief Operating Officer (COO)', 'admin',
        'Chief Marketing Officer (CMO)', 'Events Manager (EM)'
    ];
    if (req.user && authorizedRoles.includes(req.user.role)) {
        next();
    } else {
        res.status(403).json({ message: 'Access denied. You do not have permission to manage community content.' });
    }
};

const isPilotManager = (req, res, next) => {
    const authorizedRoles = [
        'admin', 'Chief Executive Officer (CEO)',
        'Chief Operating Officer (COO)', 'Head of Training (COT)'
    ];
    if (req.user && authorizedRoles.includes(req.user.role)) {
        next();
    } else {
        res.status(403).json({ message: 'Access denied. You do not have permission to manage pilots.' });
    }
};

const isPirepManager = (req, res, next) => {
    const authorizedRoles = [
        'admin', 'Chief Executive Officer (CEO)',
        'Chief Operating Officer (COO)', 'PIREP Manager (PM)'
    ];
    if (req.user && authorizedRoles.includes(req.user.role)) {
        next();
    } else {
        res.status(403).json({ message: 'Access denied. You do not have permission to manage PIREPs.' });
    }
};


// 7. API ROUTES (ENDPOINTS)

// --- Community Content Routes ---

// POST a new event
app.post('/api/events', authMiddleware, isCommunityManager, upload.single('eventImage'), async (req, res) => {
    try {
        const { title, date, description } = req.body;
        const newEvent = new Event({
            title, date, description,
            author: req.user._id,
            imageUrl: req.file ? req.file.location : undefined
        });
        await newEvent.save();
        res.status(201).json({ message: 'Event created successfully!', event: newEvent });
    } catch (error) {
        console.error("Error creating event:", error);
        res.status(500).json({ message: 'Server error while creating event.' });
    }
});

// GET all events (public)
app.get('/api/events', async (req, res) => {
    try {
        const events = await Event.find().sort({ date: -1 });
        res.json(events);
    } catch (error) {
        res.status(500).json({ message: 'Server error while fetching events.' });
    }
});

// POST a new highlight
app.post('/api/highlights', authMiddleware, isCommunityManager, upload.single('highlightImage'), async (req, res) => {
    try {
        const { title, winnerName, description } = req.body;
        if (!req.file) {
            return res.status(400).json({ message: 'An image is required for a highlight.' });
        }
        const newHighlight = new Highlight({
            title, winnerName, description,
            author: req.user._id,
            imageUrl: req.file.location
        });
        await newHighlight.save();
        res.status(201).json({ message: 'Highlight created successfully!', highlight: newHighlight });
    } catch (error) {
        console.error("Error creating highlight:", error);
        res.status(500).json({ message: 'Server error while creating highlight.' });
    }
});

// GET all highlights (public)
app.get('/api/highlights', async (req, res) => {
    try {
        const highlights = await Highlight.find().sort({ createdAt: -1 });
        res.json(highlights);
    } catch (error) {
        res.status(500).json({ message: 'Server error while fetching highlights.' });
    }
});

// DELETE an event
app.delete('/api/events/:id', authMiddleware, isCommunityManager, async (req, res) => {
    try {
        const event = await Event.findById(req.params.id);
        if (!event) return res.status(404).json({ message: 'Event not found.' });
        if (event.imageUrl) await deleteS3Object(event.imageUrl);
        await Event.findByIdAndDelete(req.params.id);
        res.json({ message: 'Event deleted successfully.' });
    } catch (error) {
        console.error('Error deleting event:', error);
        res.status(500).json({ message: 'Server error while deleting event.' });
    }
});

// DELETE a highlight
app.delete('/api/highlights/:id', authMiddleware, isCommunityManager, async (req, res) => {
    try {
        const highlight = await Highlight.findById(req.params.id);
        if (!highlight) return res.status(404).json({ message: 'Highlight not found.' });
        await deleteS3Object(highlight.imageUrl);
        await Highlight.findByIdAndDelete(req.params.id);
        res.json({ message: 'Highlight deleted successfully.' });
    } catch (error) {
        console.error('Error deleting highlight:', error);
        res.status(500).json({ message: 'Server error while deleting highlight.' });
    }
});

// --- User and Staff Routes ---

// PUBLIC ROUTE: Get all staff members
app.get('/api/staff', async (req, res) => {
    try {
        const staffRoles = User.schema.path('role').enumValues.filter(r => r !== 'pilot');
        const staffMembers = await User.find({ role: { $in: staffRoles } })
            .select('-password').sort({ createdAt: -1 });
        res.json(staffMembers);
    } catch (error) {
        console.error('Error fetching staff:', error);
        res.status(500).json({ message: 'Server error while fetching staff members.' });
    }
});

// PUBLIC ROUTE: Login a user
app.post('/api/login', express.json(), async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email: email?.toLowerCase().trim() });
        if (!user) return res.status(400).json({ message: 'Invalid email or password.' });
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ message: 'Invalid email or password.' });
        const token = jwt.sign({ _id: user._id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '3h' });
        res.json({ token });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ message: 'Server error during login.' });
    }
});

// PROTECTED ROUTE: Get current user's data
app.get('/api/me', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found.' });
        res.json(user);
    } catch (err) {
        console.error('Error fetching /me:', err);
        res.status(500).json({ message: 'Server error.' });
    }
});

// PROTECTED ROUTE: Update current user's profile
app.put('/api/me', authMiddleware, upload.single('profilePicture'), async (req, res) => {
    const { name, bio, discord, ifc, youtube, preferredContact } = req.body;
    const updatedData = { name, bio, discord, ifc, youtube, preferredContact };

    if (req.file) {
        const oldUser = await User.findById(req.user._id);
        if (oldUser?.imageUrl) await deleteS3Object(oldUser.imageUrl);
        updatedData.imageUrl = req.file.location;
    }

    try {
        const user = await User.findByIdAndUpdate(req.user._id, updatedData, { new: true }).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found.' });
        const token = jwt.sign({ _id: user._id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '3h' });
        res.json({ message: 'Profile updated successfully!', user, token });
    } catch (error) {
        if (error?.code === 11000) return res.status(400).json({ message: `A user with that ${Object.keys(error.keyValue)[0]} already exists.` });
        console.error('Error updating profile:', error);
        res.status(500).json({ message: 'Server error while updating profile.' });
    }
});

// PROTECTED ROUTE: Change current user's password
app.post('/api/me/password', authMiddleware, express.json(), async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 6) {
        return res.status(400).json({ message: 'Current password is required, and the new password must be at least 6 characters long.' });
    }
    try {
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ message: 'User not found.' });

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Incorrect current password.' });

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();
        res.json({ message: 'Password updated successfully!' });
    } catch (err) {
        console.error('Error updating password:', err);
        res.status(500).json({ message: 'Server error while updating password.' });
    }
});

// --- PIREP Workflow Routes ---

// PILOT ROUTE: Submit a new PIREP for review
app.post('/api/pireps', authMiddleware, async (req, res) => {
    try {
        const { flightNumber, departure, arrival, aircraft, flightTime, remarks } = req.body;
        if (!flightNumber || !departure || !arrival || !aircraft || !flightTime) {
            return res.status(400).json({ message: 'Please fill out all required flight details.' });
        }
        const newPirep = new Pirep({
            pilot: req.user._id, flightNumber, departure, arrival, aircraft, remarks,
            flightTime: parseFloat(flightTime),
            status: 'PENDING'
        });
        await newPirep.save();
        res.status(201).json({ message: 'Flight report submitted successfully and is pending review.', pirep: newPirep });
    } catch (error) {
        console.error('Error filing PIREP:', error);
        res.status(500).json({ message: 'Server error while filing flight report.' });
    }
});

// PILOT ROUTE: Get the current user's PIREP history
app.get('/api/me/pireps', authMiddleware, async (req, res) => {
    try {
        const pireps = await Pirep.find({ pilot: req.user._id }).sort({ createdAt: -1 });
        res.json(pireps);
    } catch (error) {
        console.error("Error fetching user's PIREPs:", error);
        res.status(500).json({ message: 'Server error while fetching your flight reports.' });
    }
});

// STAFF ROUTE: Get all PIREPs that are pending review
app.get('/api/pireps/pending', authMiddleware, isPirepManager, async (req, res) => {
    try {
        const pendingPireps = await Pirep.find({ status: 'PENDING' })
            .populate('pilot', 'name callsign')
            .sort({ createdAt: 'asc' });
        res.json(pendingPireps);
    } catch (error) {
        console.error('Error fetching pending PIREPs:', error);
        res.status(500).json({ message: 'Server error while fetching pending PIREPs.' });
    }
});

// STAFF ROUTE: Approve a PIREP
app.put('/api/pireps/:pirepId/approve', authMiddleware, isPirepManager, async (req, res) => {
    try {
        const pirep = await Pirep.findById(req.params.pirepId);
        if (!pirep) return res.status(404).json({ message: 'PIREP not found.' });
        if (pirep.status !== 'PENDING') return res.status(400).json({ message: `This PIREP has already been ${pirep.status.toLowerCase()}.` });

        const pilot = await User.findById(pirep.pilot);
        if (!pilot) return res.status(404).json({ message: 'Associated pilot profile not found.' });

        pilot.flightHours += pirep.flightTime;
        const promotionResult = checkAndApplyRankUpdate(pilot);
        
        pirep.status = 'APPROVED';
        pirep.reviewedBy = req.user._id;
        pirep.reviewedAt = Date.now();
        
        await pilot.save();
        await pirep.save();

        if (pilot.callsign) {
            await updateGoogleSheet({
                callsign: pilot.callsign, name: pilot.name, rank: pilot.rank, flightHours: pilot.flightHours,
            });
        }
        
        let message = `PIREP approved. ${pilot.name} now has ${pilot.flightHours.toFixed(2)} hours.`;
        if (promotionResult.promoted) {
            message += ` Congratulations on the promotion to ${promotionResult.rank}!`;
        }
        res.json({ message });
    } catch (error) {
        console.error('Error approving PIREP:', error);
        res.status(500).json({ message: 'Server error while approving PIREP.' });
    }
});

// STAFF ROUTE: Reject a PIREP
app.put('/api/pireps/:pirepId/reject', authMiddleware, isPirepManager, async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason) return res.status(400).json({ message: 'A reason for rejection is required.' });

        const pirep = await Pirep.findByIdAndUpdate(req.params.pirepId, {
            status: 'REJECTED',
            rejectionReason: reason,
            reviewedBy: req.user._id,
            reviewedAt: Date.now()
        });

        if (!pirep) return res.status(404).json({ message: 'PIREP not found.' });
        if (pirep.status !== 'PENDING') return res.status(400).json({ message: `This PIREP was already ${pirep.status.toLowerCase()}.` });
        
        res.json({ message: 'PIREP has been successfully rejected.' });
    } catch (error) {
        console.error('Error rejecting PIREP:', error);
        res.status(500).json({ message: 'Server error while rejecting PIREP.' });
    }
});

// STAFF ROUTE: Update a pilot's rank
app.put('/api/users/:userId/rank', authMiddleware, isPilotManager, async (req, res) => {
    const { userId } = req.params;
    const { newRank } = req.body;
    if (!newRank || !pilotRanks.includes(newRank)) {
        return res.status(400).json({ message: 'Invalid rank specified.' });
    }
    try {
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found.' });
        user.rank = newRank;
        await user.save();
        if (user.callsign) {
             await updateGoogleSheet({
                callsign: user.callsign, name: user.name, rank: user.rank, flightHours: user.flightHours
            });
        }
        res.json({ message: `Successfully updated ${user.name}'s rank to ${newRank}.` });
    } catch (error) {
        console.error('Error updating pilot rank:', error);
        res.status(500).json({ message: 'Server error while updating rank.' });
    }
});

// --- Admin-Only Routes ---

// ADMIN-ONLY ROUTE: Create a new user
app.post('/api/users', authMiddleware, isAdmin, express.json(), async (req, res) => {
    const { email, password, role, callsign, name } = req.body;
    try {
        if (!email || !password) return res.status(400).json({ message: 'Email and password are required.' });
        const normalizedEmail = String(email).toLowerCase().trim();
        const normalizedCallsign = callsign ? String(callsign).trim().toUpperCase() : null;

        if (normalizedCallsign && !isValidCallsign(normalizedCallsign)) {
            return res.status(400).json({ message: 'Invalid callsign format.' });
        }

        const salt = await bcrypt.genSalt(10);
        const user = new User({
            email: normalizedEmail,
            password: await bcrypt.hash(password, salt),
            role,
            name: name || 'New Staff Member',
            callsign: normalizedCallsign
        });
        await user.save();
        
        if (normalizedCallsign) {
            await updateGoogleSheet({
                callsign: normalizedCallsign, name: user.name, rank: user.rank, flightHours: user.flightHours || 0
            });
        }
        return res.status(201).json({ message: 'User created successfully.', userId: user._id });
    } catch (error) {
        if (error?.code === 11000) {
            const dupKey = Object.keys(error.keyValue)[0];
            return res.status(400).json({ message: `A user with this ${dupKey} already exists.` });
        }
        console.error('Error creating user:', error);
        return res.status(500).json({ message: 'Server error while creating user.' });
    }
});

// ADMIN-ONLY ROUTE: Get all users for management
app.get('/api/users', authMiddleware, isAdmin, async (req, res) => {
    try {
        const users = await User.find().select('-password');
        res.json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ message: 'Server error while fetching users.' });
    }
});

// ADMIN-ONLY ROUTE: Update a user's role
app.put('/api/users/:userId/role', authMiddleware, isAdmin, express.json(), async (req, res) => {
    const { userId } = req.params;
    const { newRole } = req.body;
    if (!User.schema.path('role').enumValues.includes(newRole)) {
        return res.status(400).json({ message: 'Invalid role specified.' });
    }
    try {
        const targetUser = await User.findById(userId);
        if (!targetUser) return res.status(404).json({ message: 'User not found.' });
        const oldRole = targetUser.role;
        targetUser.role = newRole;
        await targetUser.save();
        
        const log = new AdminLog({
            adminUser: req.user._id, action: 'ROLE_UPDATE', targetUser: userId,
            details: `Changed role for ${targetUser.email} from '${oldRole}' to '${newRole}'.`
        });
        await log.save();
        res.json({ message: `User role successfully updated to ${newRole}.` });
    } catch (error) {
        console.error('Error updating user role:', error);
        res.status(500).json({ message: 'Server error while updating user role.' });
    }
});

// ADMIN-ONLY ROUTE: Assign or update a user's callsign
app.put('/api/users/:userId/callsign', authMiddleware, isAdmin, express.json(), async (req, res) => {
    const { userId } = req.params;
    let { callsign } = req.body;
    try {
        if (!callsign || String(callsign).trim() === '') {
            return res.status(400).json({ message: 'A non-empty callsign must be provided.' });
        }
        callsign = String(callsign).trim().toUpperCase();
        if (!isValidCallsign(callsign)) return res.status(400).json({ message: 'Invalid callsign format.' });
        
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found.' });
        
        user.callsign = callsign;
        await user.save();

        await updateGoogleSheet({
            callsign, name: user.name, rank: user.rank, flightHours: user.flightHours || 0
        });
        res.json({ message: `Callsign ${callsign} assigned to ${user.email}` });
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(400).json({ message: 'This callsign is already taken by another user.' });
        }
        console.error('Error assigning callsign:', error);
        res.status(500).json({ message: 'Server error while assigning callsign.' });
    }
});

// ADMIN-ONLY ROUTE: Delete a user (Updated with cascade delete)
app.delete('/api/users/:userId', authMiddleware, isAdmin, async (req, res) => {
    const { userId } = req.params;
    try {
        if (String(req.user._id) === String(userId)) {
            return res.status(400).json({ message: 'You cannot delete your own admin account.' });
        }

        // --- Find the user first, DO NOT delete yet ---
        const userToDelete = await User.findById(userId);
        if (!userToDelete) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // --- Perform all cleanup actions before deleting the user ---

        // Step 1: Delete from Google Sheet if they have a callsign
        if (userToDelete.callsign) {
            await deleteRowFromGoogleSheet(userToDelete.callsign);
        }

        // Step 2: Delete S3 profile picture
        if (userToDelete.imageUrl) {
            await deleteS3Object(userToDelete.imageUrl);
        }

        // Step 3: Delete all PIREPs filed by this user
        await Pirep.deleteMany({ pilot: userId });

        // Step 4 (Optional but recommended): Clean up community content
        // Find all events by the user to delete associated S3 images
        const userEvents = await Event.find({ author: userId });
        for (const event of userEvents) {
            if (event.imageUrl) await deleteS3Object(event.imageUrl);
        }
        await Event.deleteMany({ author: userId });

        // Find all highlights by the user to delete associated S3 images
        const userHighlights = await Highlight.find({ author: userId });
        for (const highlight of userHighlights) {
            if (highlight.imageUrl) await deleteS3Object(highlight.imageUrl);
        }
        await Highlight.deleteMany({ author: userId });

        // --- Final Step: Now delete the user from MongoDB ---
        await User.findByIdAndDelete(userId);

        const log = new AdminLog({
            adminUser: req.user._id,
            action: 'USER_DELETE',
            details: `Deleted user with email ${userToDelete.email} and all associated data.`
        });
        await log.save();

        res.json({ message: 'User and all associated data deleted successfully.' });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ message: 'Server error while deleting user.' });
    }
});

// ADMIN-ONLY ROUTE: View activity logs
app.get('/api/logs', authMiddleware, isAdmin, async (req, res) => {
    try {
        const logs = await AdminLog.find()
            .populate('adminUser', 'name email')
            .populate('targetUser', 'name email')
            .sort({ timestamp: -1 });
        res.json(logs);
    } catch (error) {
        console.error('Error fetching logs:', error);
        res.status(500).json({ message: 'Server error while fetching logs.' });
    }
});

// 8. START THE SERVER
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});