// server.js (Fixed & Extended)
// - callsign default changed to null (unique + sparse)
// - added Pirep model
// - admin create user accepts callsign and updates Google Sheets
// - admin endpoint to assign/update callsign
// - better duplicate-key error handling & validation
// - safer admin self-delete check

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
mongoose.connect(process.env.MONGO_URI) // <-- FIX: Removed deprecated options
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
    callsign: { type: String, default: null, sparse: true, trim: true, uppercase: true }, // <-- FIX: Removed unique: true
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


// Ensure indexes are created (mongoose will create them on connect)
UserSchema.index({ callsign: 1 }, { unique: true, sparse: true }); // <-- This is the correct way to define the index

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
    imageUrl: { type: String }, // Optional image
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
});
const Event = mongoose.model('Event', EventSchema);

// --- Highlight Schema ---
const HighlightSchema = new mongoose.Schema({
    title: { type: String, required: true },
    winnerName: { type: String, required: true },
    description: { type: String },
    imageUrl: { type: String, required: true }, // Required image
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
});
const Highlight = mongoose.model('Highlight', HighlightSchema);

// --- PIREP Schema (added because PIREP is used in routes) ---
const PirepSchema = new mongoose.Schema({
    pilot: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    flightNumber: { type: String, required: true },
    departure: { type: String, required: true },
    arrival: { type: String, required: true },
    aircraft: { type: String, required: true },
    flightTime: { type: Number, required: true },
    remarks: { type: String },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    createdAt: { type: Date, default: Date.now }
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

// Helper function to update Google Sheets
const updateGoogleSheet = async (pilotData) => {
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: 'https://www.googleapis.com/auth/spreadsheets',
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = process.env.GOOGLE_SHEET_ID;
        const sheetName = 'Pilots'; // Assumes the tab in your sheet is named "Pilots"

        // 1. Get all callsigns to find the pilot's row
        const getRows = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!A:A`,
        });

        const rows = getRows.data.values || [];
        const pilotRowIndex = rows.findIndex(row => row[0] === pilotData.callsign);
        const pilotRow = pilotRowIndex + 1; // Sheets are 1-indexed

        // 2. Prepare the data to be written (order must match your sheet columns)
        // Assumed Column Order: Callsign, Name, Rank, Flight Hours, Last Updated
        const rowData = [
            pilotData.callsign,
            pilotData.name,
            pilotData.rank,
            pilotData.flightHours,
            new Date().toISOString()
        ];

        const resource = { values: [rowData] };

        if (pilotRow > 0) {
            // Pilot exists, update their row
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${sheetName}!A${pilotRow}`,
                valueInputOption: 'USER_ENTERED',
                resource,
            });
        } else {
            // Pilot not found, append a new row
            await sheets.spreadsheets.values.append({
                spreadsheetId,
                range: `${sheetName}!A1`,
                valueInputOption: 'USER_ENTERED',
                resource,
            });
        }
        console.log(`Successfully updated sheet for callsign ${pilotData.callsign}`);
    } catch (error) {
        console.error('Error updating Google Sheet:', error);
    }
};

// Simple callsign validator (tweak regex to your rules)
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
        'admin',
        'Chief Executive Officer (CEO)',
        'Chief Operating Officer (COO)',
        'Head of Training (COT)'
    ];
    if (req.user && authorizedRoles.includes(req.user.role)) {
        next();
    } else {
        res.status(403).json({ message: 'Access denied. You do not have permission to manage pilots.' });
    }
};

// 7. API ROUTES (ENDPOINTS)

// --- Community Content Routes ---

// POST a new event
app.post('/api/events', authMiddleware, isCommunityManager, upload.single('eventImage'), async (req, res) => {
    try {
        const { title, date, description } = req.body;
        const newEvent = new Event({
            title,
            date,
            description,
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
            title,
            winnerName,
            description,
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
        if (!event) {
            return res.status(404).json({ message: 'Event not found.' });
        }
        if (event.imageUrl) {
            await deleteS3Object(event.imageUrl);
        }
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
        if (!highlight) {
            return res.status(404).json({ message: 'Highlight not found.' });
        }
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
        const staffMembers = await User.find({
                role: {
                    $in: [
                        'staff', 'admin', 'Chief Executive Officer (CEO)', 'Chief Operating Officer (COO)',
                        'PIREP Manager (PM)', 'Pilot Relations & Recruitment Manager (PR)',
                        'Technology & Design Manager (TDM)', 'Head of Training (COT)',
                        'Chief Marketing Officer (CMO)', 'Route Manager (RM)',
                        'Events Manager (EM)', 'Flight Instructor (FI)'
                    ]
                }
            })
            .select('-password')
            .sort({ createdAt: -1 });
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

// PROTECTED ROUTE: Update current user's profile (admins only can set callsign via admin endpoint)
app.put('/api/me', authMiddleware, upload.single('profilePicture'), async (req, res) => {
    const { name, bio, discord, ifc, youtube, preferredContact } = req.body;
    const updatedData = {
        name,
        bio,
        discord,
        ifc,
        youtube,
        preferredContact
    };

    if (req.file) {
        // If a new picture was uploaded, delete the old one from S3 first
        try {
            const oldUser = await User.findById(req.user._id);
            if (oldUser && oldUser.imageUrl) {
                await deleteS3Object(oldUser.imageUrl);
            }
        } catch (e) {
            console.error('Error deleting old profile image:', e);
        }
        updatedData.imageUrl = req.file.location;
    }

    try {
        const user = await User.findByIdAndUpdate(req.user._id, updatedData, { new: true }).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found.' });

        const token = jwt.sign({ _id: user._id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '3h' });
        res.json({ message: 'Profile updated successfully!', user, token });
    } catch (error) {
        // Handle duplicate key errors
        if (error && error.code === 11000) {
            const dupKey = Object.keys(error.keyValue || {})[0];
            return res.status(400).json({ message: `Duplicate value for field: ${dupKey}.` });
        }
        console.error('Error updating profile:', error);
        res.status(500).json({ message: 'Server error while updating profile.' });
    }
});

// --- NEW: Pilot Routes ---

app.post('/api/pireps', authMiddleware, async (req, res) => {
    try {
        const pilotId = req.user._id;
        const { flightNumber, departure, arrival, aircraft, flightTime, remarks } = req.body;

        // 1. Save the PIREP to MongoDB
        const newPirep = new Pirep({
            pilot: pilotId,
            flightNumber,
            departure,
            arrival,
            aircraft,
            flightTime: parseFloat(flightTime),
            remarks,
            status: 'APPROVED' // Or 'PENDING' if you want staff to review it
        });
        await newPirep.save();

        // 2. Update the pilot's total flight hours
        const pilot = await User.findById(pilotId);
        if (!pilot) {
            return res.status(404).json({ message: 'Pilot profile not found.' });
        }
        pilot.flightHours += parseFloat(flightTime);
        await pilot.save();

        // 3. Update the Google Sheet with the new totals (only if callsign exists)
        if (!pilot.callsign) {
            // Decide: either allow filing without callsign but don't update sheet,
            // or reject filing. We'll just return success but warn.
            console.warn(`Pilot ${pilot._id} filed a PIREP without a callsign; sheet not updated.`);
        } else {
            await updateGoogleSheet({
                callsign: pilot.callsign,
                name: pilot.name,
                rank: pilot.rank,
                flightHours: pilot.flightHours,
            });
        }

        res.status(201).json({ message: 'Flight report filed successfully!', pirep: newPirep });

    } catch (error) {
        console.error('Error filing PIREP:', error);
        res.status(500).json({ message: 'Server error while filing flight report.' });
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
        if (!isMatch) {
            return res.status(400).json({ message: 'Incorrect current password.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);
        user.password = hashedPassword;
        await user.save();
        
        res.json({ message: 'Password updated successfully!' });
    } catch (err) {
        console.error('Error updating password:', err);
        res.status(500).json({ message: 'Server error while updating password.' });
    }
});

app.put('/api/users/:userId/rank', authMiddleware, isPilotManager, async (req, res) => {
    const { userId } = req.params;
    const { newRank } = req.body;

    const allowedRanks = User.schema.path('rank').enumValues;
    if (!newRank || !allowedRanks.includes(newRank)) {
        return res.status(400).json({ message: 'Invalid rank specified.' });
    }

    try {
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        user.rank = newRank;
        await user.save();
        
        if (user.callsign) {
             await updateGoogleSheet({
                callsign: user.callsign,
                name: user.name,
                rank: user.rank,
                flightHours: user.flightHours
            });
        }
        
        res.json({ message: `Successfully updated ${user.name}'s rank to ${newRank}.` });
    } catch (error) {
        console.error('Error updating pilot rank:', error);
        res.status(500).json({ message: 'Server error while updating rank.' });
    }
});

// --- Admin-Only Routes ---

// ADMIN-ONLY ROUTE: Create a new user (admin may provide callsign)
app.post('/api/users', authMiddleware, isAdmin, express.json(), async (req, res) => {
    const { email, password, role, callsign, name } = req.body;

    try {
        // Basic validations
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required.' });
        }

        const normalizedEmail = String(email).toLowerCase().trim();
        let existing = await User.findOne({ email: normalizedEmail });
        if (existing) return res.status(400).json({ message: 'User with this email already exists.' });

        // if callsign provided, normalize and validate
        const normalizedCallsign = callsign ? String(callsign).trim().toUpperCase() : null;
        if (normalizedCallsign && !isValidCallsign(normalizedCallsign)) {
            return res.status(400).json({ message: 'Invalid callsign format.' });
        }

        // Check callsign uniqueness if provided
        if (normalizedCallsign) {
            const csConflict = await User.findOne({ callsign: normalizedCallsign });
            if (csConflict) return res.status(400).json({ message: 'This callsign is already taken.' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const user = new User({
            email: normalizedEmail,
            password: hashedPassword,
            role,
            name: name || 'New Staff Member',
            callsign: normalizedCallsign
        });

        await user.save();

        // If callsign exists, also update Google Sheet
        if (normalizedCallsign) {
            await updateGoogleSheet({
                callsign: normalizedCallsign,
                name: user.name,
                rank: user.rank,
                flightHours: user.flightHours || 0
            });
        }

        return res.status(201).json({ message: 'User created successfully.', userId: user._id });
    } catch (error) {
        // Handle duplicate key (callsign or email) gracefully
        if (error && error.code === 11000) {
            const dupKey = Object.keys(error.keyValue || {})[0];
            return res.status(400).json({ message: `Duplicate value for field: ${dupKey}. Please choose another ${dupKey}.` });
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
    const allowedRoles = User.schema.path('role').enumValues;
    if (!allowedRoles.includes(newRole)) {
        return res.status(400).json({ message: 'Invalid role specified.' });
    }
    try {
        const targetUser = await User.findById(userId);
        if (!targetUser) return res.status(404).json({ message: 'User not found.' });
        const oldRole = targetUser.role;
        targetUser.role = newRole;
        await targetUser.save();
        const log = new AdminLog({
            adminUser: req.user._id,
            action: 'ROLE_UPDATE',
            targetUser: userId,
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
            return res.status(400).json({ message: 'A callsign (non-empty) must be provided.' });
        }
        callsign = String(callsign).trim().toUpperCase();

        if (!isValidCallsign(callsign)) {
            return res.status(400).json({ message: 'Invalid callsign format.' });
        }

        // Ensure callsign doesn't belong to someone else
        const conflict = await User.findOne({ callsign, _id: { $ne: userId } });
        if (conflict) return res.status(400).json({ message: 'This callsign is already taken by another user.' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found.' });

        user.callsign = callsign;
        await user.save();

        // Update spreadsheet as well
        await updateGoogleSheet({
            callsign,
            name: user.name,
            rank: user.rank,
            flightHours: user.flightHours || 0
        });

        res.json({ message: `Callsign ${callsign} assigned to ${user.email}` });
    } catch (error) {
        if (error && error.code === 11000) {
            return res.status(400).json({ message: 'Callsign already exists. Choose a different one.' });
        }
        console.error('Error assigning callsign:', error);
        res.status(500).json({ message: 'Server error while assigning callsign.' });
    }
});

// ADMIN-ONLY ROUTE: Delete a user
app.delete('/api/users/:userId', authMiddleware, isAdmin, async (req, res) => {
    const { userId } = req.params;
    try {
        // Prevent admin deleting their own account (compare as strings)
        if (String(req.user._id) === String(userId)) {
            return res.status(400).json({ message: 'You cannot delete your own admin account.' });
        }

        const userToDelete = await User.findById(userId);
        if (!userToDelete) return res.status(404).json({ message: 'User not found.' });

        // IMPORTANT: Also delete the user's profile picture from S3
        if (userToDelete.imageUrl) {
            await deleteS3Object(userToDelete.imageUrl);
        }

        const deletedUserEmail = userToDelete.email;
        await User.findByIdAndDelete(userId);
        const log = new AdminLog({
            adminUser: req.user._id,
            action: 'USER_DELETE',
            details: `Deleted user with email ${deletedUserEmail}.`
        });
        await log.save();
        res.json({ message: 'User deleted successfully.' });
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