// server.js (Fully Merged, Updated & Performance Tuned with Leaderboards & Invites)
// - Automated Roster Generation now reads from TWO Google Sheets simultaneously:
//   1. The primary routes sheet (for regular flights).
//   2. The codeshare routes sheet (for partner flights).
// - NO separate import step needed. Roster generation pulls all data in real-time.
// - Strict Flight & Duty Time Limitations (FTPL) engine.
// - ADDED: Staff-controlled switch to disable FTPL for individual users.
// - Location-aware roster availability for pilots.
// - Robust Google Sheets function with dynamic column mapping.
// - Advanced PIREP system with a staff review workflow.
// - Automatic rank promotions upon PIREP approval.
// - Cascade delete functionality for users and their associated data.
// - Personalized roster suggestions based on pilot's last duty/flight location.
// - NEW: Roster multipliers for bonus flight hours on final legs.
// - NEW: Image verification required for all PIREP submissions.
// - NEW: Map feature support via airports data endpoint.
// - NEW: Weekly and Monthly pilot leaderboards for hours and sectors.
// - NEW: Test & Practical based promotion system for specific ranks.
// - NEW: Flight Planning system with FIC/ADC codes and automated PIREP generation.
// - NEW: Invite-based registration system for new pilots.
// - FIXED: Daily flight hour counter now resets intelligently when starting a new duty.
// - ADDED: Endpoint for user profile now includes time remaining on crew rest and notifications.
// - FIXED: Off-roster (non-duty) PIREPs no longer affect FTPL counters.
// - MODIFIED: Roster generation now creates a mix of single-rank and mixed-rank duties.
// - MODIFIED: PIREP filing is now automated via the flight plan completion process.
// - MODIFIED: PIREP approval now allows staff to correct the flight time.
// - NEW: Airport country codes are now automatically resolved and stored in rosters.

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
const Papa = require('papaparse'); // For parsing CSV data from Google Sheets
const axios = require('axios'); // For fetching the sheet
const fs = require('fs').promises; // For reading local JSON files
const crypto = require('crypto'); // For Flight Plan code generation & Invites
require('dotenv').config();

// 2. INITIALIZE EXPRESS APP & AWS S3 CLIENT
const app = express();
const PORT = process.env.PORT || 5000;
let airportsData = {}; // To hold the airport data in memory

// Configure the AWS S3 client
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

// 3. MIDDLEWARE
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
            } else if (['eventImage', 'highlightImage'].includes(file.fieldname)) {
                folder = 'community/';
            } else if (file.fieldname === 'verificationImage') {
                folder = 'pirep-verification/';
            }
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const fileName = `${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`;
            cb(null, `${folder}${fileName}`);
        }
    })
});

// Function to load airport data into memory
const loadAirportsData = async () => {
    try {
        console.log('Loading airport data into memory...');
        const filePath = path.join(__dirname, 'airports.json');
        const data = await fs.readFile(filePath, 'utf8');
        airportsData = JSON.parse(data);
        console.log(`Successfully loaded ${Object.keys(airportsData).length} airports.`);
    } catch (error) {
        console.error('CRITICAL ERROR: Could not load airports.json. Country lookups will not work.', error);
    }
};

// 4. CONNECT TO MONGODB DATABASE
mongoose.connect(process.env.MONGO_URI)
    .then(() => {
        console.log('MongoDB connected successfully.');
        loadAirportsData(); // Load airport data after successful DB connection
    })
    .catch(err => console.error('MongoDB connection error:', err));


// 5. DEFINE SCHEMAS AND MODELS

// --- Constants for FTPL & Ranks ---
const MIN_REST_PERIOD = 8 * 60 * 60 * 1000; // 8 hours in ms
const MAX_DUTY_PERIOD = 14 * 60 * 60 * 1000; // 14 hours in ms
const MAX_DAILY_FLIGHT_HOURS = 10;
const MAX_MONTHLY_FLIGHT_HOURS = 100;

const pilotRanks = [
    'IndGo Cadet', 'Skyline Observer', 'Route Explorer', 'Skyline Officer',
    'Command Captain', 'Elite Captain', 'Blue Eagle', 'Line Instructor',
    'Chief Flight Instructor', 'IndGo SkyMaster', 'Blue Legacy Commander'
];

// NEW: Define ranks that require manual testing and promotion
const testGatedRanks = [
    'Route Explorer',
    'Skyline Officer',
    'Elite Captain',
    'Blue Eagle'
];

const rankThresholds = {
    'IndGo Cadet': 0,
    'Skyline Observer': 50,
    'Route Explorer': 100,
    'Skyline Officer': 180,
    'Command Captain': 300,
    'Elite Captain': 500,
    'Blue Eagle': 750,
    'Line Instructor': 1000,
    'Chief Flight Instructor': 1400,
    'IndGo SkyMaster': 1800,
    'Blue Legacy Commander': 2300
};

const rankPerks = {
    'IndGo Cadet': ['Training routes only (Q400, A320)', 'Discord pilot badge'],
    'Skyline Observer': ['Access to A321/B738 short-haul', 'Eligible for beginner events'],
    'Route Explorer': ['Medium-haul aircraft access (B38M/A330)', 'Written & Practical Test required'],
    'Skyline Officer': ['Long-haul unlocks (B787-8/B77L)', 'Written & Practical Test required'],
    'Command Captain': ['Senior group flight eligibility', 'Command aircraft: B77W, B789'],
    'Elite Captain': ['Ultra Long Haul access (A350)', 'Written & Practical Test required'],
    'Blue Eagle': ['A380/B744 heavy ops access', 'Exclusive Discord lounge', 'Written & Practical Test required'],
    'Line Instructor': ['Can test cadets and mid-rank pilots', 'Route reviewing rights'],
    'Chief Flight Instructor': ['Manage Line Instructors', 'Crew check and instructor oversight'],
    'IndGo SkyMaster': ['Access to staff-level decisions', 'Route planning authority'],
    'Blue Legacy Commander': ['Lifetime elite badge', 'Council-level privileges', 'Ultimate recognition']
};


// --- Rank helpers ---
const rankIndex = (r) => {
    const i = pilotRanks.indexOf(String(r || '').trim());
    return i >= 0 ? i : -1;
};
const canFlyLeg = (userRank, legRank) => {
    const ui = rankIndex(userRank);
    const li = rankIndex(legRank);
    return ui >= 0 && li >= 0 && li <= ui;
};
const getLegRequiredRank = (leg) => {
    if (leg?.rankUnlock && pilotRanks.includes(leg.rankUnlock)) return leg.rankUnlock;
    return deduceRankFromAircraft(leg?.aircraft);
};


// --- User Schema (Enhanced for Test-Based Promotions) ---
const UserSchema = new mongoose.Schema({
    name: { type: String, default: 'New Staff Member' },
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String, required: true },
    role: {
        type: String,
        enum: [
            'staff', 'pilot', 'admin', 'Chief Executive Officer (CEO)', 'Chief Operating Officer (COO)',
            'PIREP Manager (PM)', 'Pilot Relations & Recruitment Manager (PR)', 'Technology & Design Manager (TDM)',
            'Head of Training (COT)', 'Chief Marketing Officer (CMO)', 'Route Manager (RM)',
            'Events Manager (EM)', 'Flight Instructor (FI)'
        ],
        default: 'pilot'
    },
    callsign: { type: String, default: null, sparse: true, trim: true, uppercase: true },
    rank: { type: String, enum: pilotRanks, default: 'IndGo Cadet' },
    flightHours: { type: Number, default: 0 },
    bio: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    discord: { type: String, default: '' },
    ifc: { type: String, default: '' },
    youtube: { type: String, default: '' },
    preferredContact: { type: String, enum: ['none', 'discord', 'ifc', 'youtube'], default: 'none' },
    createdAt: { type: Date, default: Date.now },
    // FTPL Fields
    dutyStatus: { type: String, enum: ['ON_REST', 'ON_DUTY'], default: 'ON_REST' },
    currentRoster: { type: mongoose.Schema.Types.ObjectId, ref: 'Roster', default: null },
    lastDutyStart: { type: Date, default: null },
    lastDutyOff: { type: Date, default: null },
    dailyFlightHours: { type: Number, default: 0 },
    monthlyFlightHours: { type: Number, default: 0 }, // For FTPL (rolling 30 days)
    lastHourReset: { type: Date, default: Date.now },
    isFtplExempt: { type: Boolean, default: false }, // NEW: Staff-controlled switch to bypass FTPL
    lastKnownAirport: { type: String, uppercase: true, trim: true, default: 'VIDP' },
    lastDutyAirport: { type: String, uppercase: true, trim: true, default: null },
    // Leaderboard Fields
    weeklyFlightHours: { type: Number, default: 0 },
    leaderboardMonthlyFlightHours: { type: Number, default: 0 }, // By calendar month
    weeklySectors: { type: Number, default: 0 },
    monthlySectors: { type: Number, default: 0 },
    lastWeeklyReset: { type: Date, default: Date.now },
    lastMonthlyReset: { type: Date, default: Date.now },
    // NEW FIELDS FOR MANUAL PROMOTION
    promotionStatus: {
        type: String,
        enum: ['ACTIVE', 'PENDING_TEST'],
        default: 'ACTIVE'
    },
    // NEW: Link to active flight plan
    currentFlightPlan: { type: mongoose.Schema.Types.ObjectId, ref: 'FlightPlan', default: null },
    notifications: [{
        message: { type: String, required: true },
        read: { type: Boolean, default: false },
        createdAt: { type: Date, default: Date.now }
    }],
    default: []
}, { toJSON: { virtuals: true }, toObject: { virtuals: true } });
UserSchema.index({ callsign: 1 }, { unique: true, sparse: true });

UserSchema.pre('findOneAndDelete', { document: true, query: true }, async function (next) {
    try {
        const user = await this.model.findOne(this.getFilter());
        if (!user) return next();

        console.log(`Performing cascade delete for user: ${user.email}`);
        if (user.imageUrl) { deleteS3Object(user.imageUrl); }
        await mongoose.model('Pirep').deleteMany({ pilot: user._id });
        await mongoose.model('FlightPlan').deleteMany({ pilot: user._id }); // Cascade delete flight plans
        const events = await mongoose.model('Event').find({ author: user._id }).lean();
        for (const event of events) {
            if (event.imageUrl) deleteS3Object(event.imageUrl);
        }
        await mongoose.model('Event').deleteMany({ author: user._id });
        const highlights = await mongoose.model('Highlight').find({ author: user._id }).lean();
        for (const highlight of highlights) {
            if (highlight.imageUrl) deleteS3Object(highlight.imageUrl);
        }
        await mongoose.model('Highlight').deleteMany({ author: user._id });
        next();
    } catch (error) {
        console.error("Error in user cascade delete middleware:", error);
        next(error);
    }
});

const User = mongoose.model('User', UserSchema);

UserSchema.index({ role: 1 });
UserSchema.index({ lastKnownAirport: 1, lastDutyAirport: 1 });
UserSchema.index({ weeklyFlightHours: -1 });
UserSchema.index({ weeklySectors: -1 });
UserSchema.index({ leaderboardMonthlyFlightHours: -1 });
UserSchema.index({ monthlySectors: -1 });

// --- Invite Schema (NEW) ---
const InviteSchema = new mongoose.Schema({
    code: {
        type: String,
        required: true,
        unique: true,
    },
    expiresAt: {
        type: Date,
        required: true,
    },
    status: {
        type: String,
        enum: ['PENDING', 'ACCEPTED', 'EXPIRED'],
        default: 'PENDING',
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    usedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
}, { timestamps: true });
const Invite = mongoose.model('Invite', InviteSchema);


// --- Admin Log Schema ---
const AdminLogSchema = new mongoose.Schema({
    adminUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true, enum: ['ROLE_UPDATE', 'USER_DELETE', 'ROSTER_CREATE', 'ROSTER_DELETE', 'PROMOTION_TEST_REQUIRED', 'FTPL_STATUS_UPDATE'] }, // ADDED NEW ACTION
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

// --- NEW: Flight Plan Schema ---
const FlightPlanSchema = new mongoose.Schema({
    pilot: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    flightNumber: { type: String, required: true, trim: true },
    departure: { type: String, required: true, uppercase: true, trim: true },
    arrival: { type: String, required: true, uppercase: true, trim: true },
    aircraft: { type: String, required: true },
    etd: { type: Date, required: true }, // Estimated Time of Departure
    eet: { type: Number, required: true }, // Estimated Elapsed Time in hours
    eta: { type: Date, required: true }, // Estimated Time of Arrival
    alternate: { type: String, required: true, uppercase: true, trim: true },
    pob: { type: Number, required: true }, // Persons on Board
    route: { type: String, required: true },
    ficNumber: { type: String, required: true, unique: true }, // Flight Information Code
    adcNumber: { type: String, required: true, unique: true }, // Air Defence Clearance
    status: {
        type: String,
        enum: ['PLANNED', 'FLYING', 'COMPLETED', 'CANCELLED'],
        default: 'PLANNED'
    },
    // For roster flights
    rosterLeg: {
        rosterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Roster' },
        flightNumber: { type: String }
    },
    // Actual times
    actualDepartureTime: { type: Date },
    actualArrivalTime: { type: Date },

    dispatchData: { type: mongoose.Schema.Types.Mixed, default: null }

}, { timestamps: true });


// --- PIREP Schema ---
const PirepSchema = new mongoose.Schema({
    pilot: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    flightNumber: { type: String, required: true },
    departure: { type: String, required: true, uppercase: true, trim: true },
    arrival: { type: String, required: true, uppercase: true, trim: true },
    aircraft: { type: String, required: true },
    flightTime: { type: Number, required: true, min: 0.1 },
    rankUnlock: { type: String, trim: true },
    operator: { type: String, trim: true },
    remarks: { type: String, trim: true },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date, default: null },
    verificationImageUrl: { type: String, default: null },
    isMultiplierEligible: { type: Boolean, default: false },
    rosterLeg: {
        rosterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Roster' },
        flightNumber: { type: String }
    }
});
const Pirep = mongoose.model('Pirep', PirepSchema);
PirepSchema.index({ pilot: 1 });
PirepSchema.index({ status: 1 });
PirepSchema.index({ 'rosterLeg.rosterId': 1, 'rosterLeg.flightNumber': 1 });

// --- Roster Schema (UPDATED) ---
const RosterSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    hub: { type: String, required: true, uppercase: true, trim: true },
    legs: [{
        flightNumber: { type: String, required: true, trim: true },
        departure: { type: String, required: true, uppercase: true, trim: true },
        arrival: { type: String, required: true, uppercase: true, trim: true },
        departureCountry: { type: String }, // NEW
        arrivalCountry: { type: String },   // NEW
        aircraft: { type: String, required: true, trim: true },
        flightTime: { type: Number, required: true, min: 0.1 },
        rankUnlock: { type: String },
        operator: { type: String }
    }],
    totalFlightTime: { type: Number, required: true, min: 0 },
    multiplier: { type: Number, default: 1, min: 1, max: 2 },
    isAvailable: { type: Boolean, default: true },
    isGenerated: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
});
const Roster = mongoose.model('Roster', RosterSchema);
RosterSchema.index({ isAvailable: 1, 'legs.0.departure': 1 });


// 6. HELPER FUNCTIONS & MIDDLEWARE

const getCountryCode = (icao) => airportsData[icao]?.country || null;

const generateFicNumber = () => `FIC/${new Date().getFullYear()}/${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const generateAdcNumber = () => `ADC/${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

const deleteS3Object = async (imageUrl) => {
    if (!imageUrl) return;
    try {
        const url = new URL(imageUrl);
        const key = url.pathname.substring(1);
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

const updateGoogleSheet = async (pilotData) => {
    if (!pilotData || !pilotData.callsign) {
        console.warn('updateGoogleSheet called without pilot data or callsign. Aborting sheet update.');
        return;
    }
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: 'https://www.googleapis.com/auth/spreadsheets',
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = process.env.GOOGLE_SHEET_ID;
        const sheetName = 'Pilots';

        const headerResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!1:1`,
        });
        const headers = headerResponse.data.values ? headerResponse.data.values[0] : [];
        const columnMap = {};
        headers.forEach((header, index) => { columnMap[header] = index; });

        const requiredColumns = ['Callsign', 'Name', 'Rank', 'Flight Hours'];
        for (const col of requiredColumns) {
            if (columnMap[col] === undefined) throw new Error(`Missing required column in Google Sheet: "${col}"`);
        }

        const callsignColumnIndex = columnMap['Callsign'];
        const callsignColumnLetter = String.fromCharCode(65 + callsignColumnIndex);
        const allCallsignsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!${callsignColumnLetter}2:${callsignColumnLetter}`,
        });
        const allCallsigns = allCallsignsResponse.data.values ? allCallsignsResponse.data.values.flat() : [];
        const pilotRowIndex = allCallsigns.findIndex(cs => cs === pilotData.callsign);

        const fullRowData = new Array(headers.length).fill(null);
        fullRowData[columnMap['Callsign']] = pilotData.callsign;
        fullRowData[columnMap['Name']] = pilotData.name;
        fullRowData[columnMap['Rank']] = pilotData.rank;
        fullRowData[columnMap['Flight Hours']] = pilotData.flightHours;
        if (columnMap['Last Updated'] !== undefined) {
            fullRowData[columnMap['Last Updated']] = new Date().toISOString();
        }
        const resource = { values: [fullRowData] };

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

const deleteRowFromGoogleSheet = async (callsign) => {
    if (!callsign) {
        console.warn('deleteRowFromGoogleSheet called without a callsign. Aborting.');
        return;
    }
    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: 'https://www.googleapis.com/auth/spreadsheets',
        });
        const sheets = google.sheets({ version: 'v4', auth });
        const spreadsheetId = process.env.GOOGLE_SHEET_ID;
        const sheetName = 'Pilots';

        const spreadsheetMeta = await sheets.spreadsheets.get({ spreadsheetId });
        const sheet = spreadsheetMeta.data.sheets.find(s => s.properties.title === sheetName);
        if (!sheet) throw new Error(`Sheet with name "${sheetName}" not found.`);
        const sheetId = sheet.properties.sheetId;

        const headerResponse = await sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!1:1` });
        const headers = headerResponse.data.values ? headerResponse.data.values[0] : [];
        const callsignColumnIndex = headers.findIndex(h => h === 'Callsign');
        if (callsignColumnIndex === -1) throw new Error('Could not find "Callsign" column in the sheet.');

        const callsignColumnLetter = String.fromCharCode(65 + callsignColumnIndex);
        const allCallsignsResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${sheetName}!${callsignColumnLetter}2:${callsignColumnLetter}`,
        });
        const allCallsigns = allCallsignsResponse.data.values ? allCallsignsResponse.data.values.flat() : [];
        const pilotRowIndex = allCallsigns.findIndex(cs => cs === callsign);

        if (pilotRowIndex !== -1) {
            const targetRow = pilotRowIndex + 1;
            const request = {
                spreadsheetId,
                resource: {
                    requests: [{
                        deleteDimension: {
                            range: { sheetId, dimension: 'ROWS', startIndex: targetRow, endIndex: targetRow + 1 }
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

const deduceRankFromAircraft = (acStr) => {
    const s = String(acStr || '').toUpperCase();
    if (!s) return 'Unknown';
    const has = (pat) => new RegExp(pat, 'i').test(s);
    if (has('(Q400|A320|B738)')) return 'IndGo Cadet';
    if (has('(A321|B737)')) return 'Skyline Observer';
    if (has('(A330|B38M)')) return 'Route Explorer';
    if (has('(787-8|777-200LR)')) return 'Skyline Officer';
    if (has('(787-9|777-300ER)')) return 'Command Captain';
    if (has('A350')) return 'Elite Captain';
    if (has('(A380|747|744)')) return 'Blue Eagle';
    if (has('INSTRUCTOR')) return 'Line Instructor';
    if (has('CHIEF')) return 'Chief Flight Instructor';
    if (has('SKYMASTER')) return 'IndGo SkyMaster';
    if (has('COMMANDER')) return 'Blue Legacy Commander';
    return 'Unknown';
};

const generateRostersFromGoogleSheet = async () => {
    console.log('Starting automated roster generation from all sources...');

    const convertTimeToDecimal = (timeStr) => {
        if (!timeStr || typeof timeStr !== 'string') return NaN;
        const trimmedStr = timeStr.trim();
        if (trimmedStr.includes(':')) {
            const parts = trimmedStr.split(':');
            if (parts.length === 2 || parts.length === 3) {
                const hours = parseInt(parts[0], 10);
                const minutes = parseInt(parts[1], 10);
                if (!isNaN(hours) && !isNaN(minutes)) {
                    return hours + (minutes / 60);
                }
            }
        }
        const hourMatch = trimmedStr.match(/(\d+)\s*h/);
        const minMatch = trimmedStr.match(/(\d+)\s*m/);
        if (hourMatch || minMatch) {
            let totalHours = 0;
            if (hourMatch) totalHours += parseInt(hourMatch[1], 10);
            if (minMatch) totalHours += parseInt(minMatch[1], 10) / 60;
            return totalHours;
        }
        return NaN;
    };

    const extractIcao = (text) => {
        if (!text) return null;
        const match = text.match(/^\s*([A-Z]{4})/);
        return match ? match[1] : null;
    };

    const headerAliasesBase = {
        flightNumber: ['Flight No.', 'Flight Number', 'Callsign'],
        departure: ['Departure ICAO', 'Departure', 'Origin', 'From'],
        arrival: ['Arrival ICAO', 'Arrival', 'Destination', 'To'],
        aircraft: ['Aircraft(s)', 'Aircraft', 'Plane'],
        flightTime: ['Avg. Flight Time', 'Flight Time', 'Duration']
    };
    const headerAliasesCodeshare = {
        ...headerAliasesBase,
        rankUnlock: ['Rank Unlock', 'Rank', 'Rank Required', 'Unlock Rank'],
        operator:   ['Operator', 'Airline', 'Carrier', 'Virtual Airline']
    };

    
    let allLegs = [];
    
    const primaryUrls = process.env.ROUTES_SHEET_URL ? process.env.ROUTES_SHEET_URL.split(',') : [];
    const codeshareUrls = process.env.CODESHARE_SHEET_URLS ? process.env.CODESHARE_SHEET_URLS.split(',') : [];
    const allUrls = [...primaryUrls, ...codeshareUrls].filter(Boolean);

    if (allUrls.length === 0) {
        console.warn('No ROUTES_SHEET_URL or CODESHARE_SHEET_URLS defined. Aborting roster generation.');
        return { created: 0, legsFound: 0 };
    }

    for (const url of allUrls) {
        const isCodeshare = (process.env.CODESHARE_SHEET_URLS ? process.env.CODESHARE_SHEET_URLS.split(',').map(s=>s.trim()) : []).includes(url.trim());
        const headerAliases = isCodeshare ? headerAliasesCodeshare : headerAliasesBase;
        const canonicalKeys = Object.keys(headerAliases);
        try {
            console.log(`Fetching routes from: ${url.substring(0, 80)}...`);
            const response = await axios.get(url.trim());
            const parsed = Papa.parse(response.data, { header: false, skipEmptyLines: true });
            const allRows = parsed.data;

            if (!allRows || allRows.length === 0) {
                console.log('- Sheet is empty or could not be parsed.');
                continue;
            }

            let headerRowIndex = -1;
            let columnMap = {};

            for (let i = 0; i < allRows.length; i++) {
                const row = allRows[i];
                const tempMap = {};
                
                row.forEach((headerCell, index) => {
                    const trimmedHeader = headerCell.trim().toLowerCase();
                    if (!trimmedHeader) return;
                    
                    for (const key of canonicalKeys) {
                        if (headerAliases[key].some(alias => alias.toLowerCase() === trimmedHeader)) {
                            tempMap[key] = index;
                            break;
                        }
                    }
                });

                if (Object.keys(tempMap).length === canonicalKeys.length) {
                    columnMap = tempMap;
                    headerRowIndex = i;
                    console.log(`- Found valid header row at index ${i}.`);
                    break;
                }
            }

            if (headerRowIndex === -1) {
                console.warn(`- Could not find a valid header row in sheet: ${url}`);
                continue;
            }

            const dataRows = allRows.slice(headerRowIndex + 1);

            
            const legsFromSheet = dataRows
                .map(row => {
                    const departureIcao = extractIcao(row[columnMap.departure]);
                    const arrivalIcao   = extractIcao(row[columnMap.arrival]);
                    const flightTime    = convertTimeToDecimal(row[columnMap.flightTime]);
                    const flightNumber  = row[columnMap.flightNumber]?.trim();
                    const aircraft      = row[columnMap.aircraft]?.trim();

                    // Determine operator/rank per sheet type
                    let rankUnlock = null;
                    let operator = null;

                    if (isCodeshare) {
                        rankUnlock = row[columnMap.rankUnlock]?.trim();
                        operator   = row[columnMap.operator]?.trim();
                        if (!rankUnlock || !operator) return null; // enforce for codeshare
                    } else {
                        // Primary: compute defaults if not explicitly present
                        rankUnlock = (columnMap.rankUnlock !== undefined) ? String(row[columnMap.rankUnlock] || '').trim() : deduceRankFromAircraft(aircraft);
                        operator   = (columnMap.operator !== undefined) ? String(row[columnMap.operator] || '').trim() : 'IndGo Air Virtual';
                    }

                    if (departureIcao && arrivalIcao && flightNumber && aircraft && !isNaN(flightTime) && flightTime > 0 && rankUnlock && operator) {
                        return { 
                            flightNumber, 
                            departure: departureIcao, 
                            arrival: arrivalIcao, 
                            departureCountry: getCountryCode(departureIcao),
                            arrivalCountry: getCountryCode(arrivalIcao),
                            aircraft, 
                            flightTime, 
                            rankUnlock, 
                            operator 
                        };
                    }
                    return null;
                })
                .filter(leg => leg !== null);

            
            allLegs.push(...legsFromSheet);
            console.log(`- Found ${legsFromSheet.length} valid legs from this sheet.`);

        } catch (error) {
            console.error(`Failed to process URL ${url}:`, error.message);
        }
    }

    console.log(`Total available legs for roster generation from all sources: ${allLegs.length}`);

    if (allLegs.length === 0) {
        console.warn('No valid legs found from any source. No rosters will be generated.');
        return { created: 0, legsFound: allLegs.length };
    }
    
    const generatedRosters = [];
    const rosterCountPerType = 2; // Generate up to 2 of each type per location to control volume

    // --- NEW: Step 1 - Generate SINGLE-RANK Rosters ---
    console.log('--- Generating Single-Rank Rosters ---');
    const legsByRank = allLegs.reduce((acc, leg) => {
        const rank = leg.rankUnlock; 
        if (!acc[rank]) acc[rank] = [];
        acc[rank].push(leg);
        return acc;
    }, {});

    for (const rank in legsByRank) {
        if (!pilotRanks.includes(rank)) continue; // Skip unknown or invalid ranks

        const legsForThisRank = legsByRank[rank];
        const legsByDepartureForRank = legsForThisRank.reduce((acc, leg) => {
            if (!acc[leg.departure]) acc[leg.departure] = [];
            acc[leg.departure].push(leg);
            return acc;
        }, {});

        const departureAirportsForRank = Object.keys(legsByDepartureForRank);
        console.log(`Found ${departureAirportsForRank.length} departure airports for rank: ${rank}`);

        for (const departureAirport of departureAirportsForRank) {
            for (let i = 0; i < rosterCountPerType; i++) {
                const rosterLegs = [];
                let currentAirport = departureAirport;
                let totalTime = 0;
                const usedFlightNumbers = new Set();
                const legCount = Math.floor(Math.random() * 3) + 2; // 2 to 4 legs

                for (let j = 0; j < legCount; j++) {
                    const possibleNextLegs = (legsByDepartureForRank[currentAirport] || []).filter(
                        l => !usedFlightNumbers.has(l.flightNumber)
                    );
                    if (possibleNextLegs.length === 0) break;

                    const nextLeg = possibleNextLegs[Math.floor(Math.random() * possibleNextLegs.length)];
                    if ((totalTime + nextLeg.flightTime) > MAX_DAILY_FLIGHT_HOURS) break;

                    rosterLegs.push(nextLeg);
                    totalTime += nextLeg.flightTime;
                    currentAirport = nextLeg.arrival;
                    usedFlightNumbers.add(nextLeg.flightNumber);
                }

                if (rosterLegs.length >= 2) {
                    const randomMultiplier = parseFloat((1.1 + Math.random() * 0.4).toFixed(2));
                    generatedRosters.push({
                        name: `${departureAirport} ${rank} Duty #${i + 1}`, // Descriptive name
                        hub: departureAirport,
                        legs: rosterLegs,
                        totalFlightTime: totalTime,
                        multiplier: randomMultiplier,
                        isGenerated: true,
                        isAvailable: true,
                    });
                }
            }
        }
    }
    
    // --- NEW: Step 2 - Generate MIXED-RANK Rosters ---
    console.log('--- Generating Mixed-Rank Rosters ---');
    const legsByDeparture = allLegs.reduce((acc, leg) => {
        if (!acc[leg.departure]) acc[leg.departure] = [];
        acc[leg.departure].push(leg);
        return acc;
    }, {});

    const allDepartureAirports = Object.keys(legsByDeparture);
    console.log(`Found ${allDepartureAirports.length} unique departure airports for mixed roster generation.`);

    for (const departureAirport of allDepartureAirports) {
        if (!legsByDeparture[departureAirport]) continue;

        for (let i = 0; i < rosterCountPerType; i++) { 
            const rosterLegs = [];
            let currentAirport = departureAirport;
            let totalTime = 0;
            const usedFlightNumbers = new Set();
            const legCount = Math.floor(Math.random() * 3) + 2; // 2 to 4 legs

            for (let j = 0; j < legCount; j++) {
                const possibleNextLegs = (legsByDeparture[currentAirport] || []).filter(
                    l => !usedFlightNumbers.has(l.flightNumber)
                );
                if (possibleNextLegs.length === 0) break;

                const nextLeg = possibleNextLegs[Math.floor(Math.random() * possibleNextLegs.length)];
                if ((totalTime + nextLeg.flightTime) > MAX_DAILY_FLIGHT_HOURS) break;

                rosterLegs.push(nextLeg);
                totalTime += nextLeg.flightTime;
                currentAirport = nextLeg.arrival;
                usedFlightNumbers.add(nextLeg.flightNumber);
            }

            if (rosterLegs.length >= 2) {
                const randomMultiplier = parseFloat((1.1 + Math.random() * 0.4).toFixed(2));
                generatedRosters.push({
                    name: `${departureAirport} Sector Duty #${i + 1}`, // Original naming
                    hub: departureAirport,
                    legs: rosterLegs,
                    totalFlightTime: totalTime,
                    multiplier: randomMultiplier,
                    isGenerated: true,
                    isAvailable: true,
                });
            }
        }
    }

    if (generatedRosters.length > 0) {
        await Roster.deleteMany({ isGenerated: true });
        // Shuffle the combined list of rosters for better presentation
        generatedRosters.sort(() => Math.random() - 0.5); 
        await Roster.insertMany(generatedRosters);
        console.log(`Successfully generated and saved ${generatedRosters.length} new mixed and single-rank rosters.`);
    }
    return { created: generatedRosters.length, legsFound: allLegs.length };
};


// Rank Promotion Helper (OVERHAULED for Manual Promotion)
const checkAndApplyRankUpdate = (pilot) => {
    const currentHours = pilot.flightHours;
    const currentRank = pilot.rank;
    let prospectiveRank = currentRank;

    // Find the highest rank the pilot qualifies for based on hours
    for (let i = pilotRanks.length - 1; i >= 0; i--) {
        const rankName = pilotRanks[i];
        if (currentHours >= rankThresholds[rankName]) {
            prospectiveRank = rankName;
            break;
        }
    }

    // If the prospective rank is the same as the current one, do nothing.
    if (prospectiveRank === currentRank) {
        return { promoted: false, pendingTest: false };
    }

    // --- NEW LOGIC ---
    // Check if the prospective rank is a "test-gated" rank
    if (testGatedRanks.includes(prospectiveRank)) {
        // If the pilot is currently ACTIVE and qualifies for a test, put them in PENDING_TEST state.
        if (pilot.promotionStatus === 'ACTIVE') {
            pilot.promotionStatus = 'PENDING_TEST';
            // Return a special status to signal that staff needs to be notified.
            return { promoted: false, pendingTest: true, prospectiveRank: prospectiveRank };
        }
        // If they are already pending a test, do nothing further automatically.
        return { promoted: false, pendingTest: false };

    } else {
        // This is an automatic promotion for a non-test-gated rank.
        pilot.rank = prospectiveRank;
        return { promoted: true, rank: prospectiveRank };
    }
};

const checkAndResetLeaderboardStats = (pilot) => {
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    if (pilot.lastWeeklyReset < oneWeekAgo) {
        pilot.weeklyFlightHours = 0;
        pilot.weeklySectors = 0;
        pilot.lastWeeklyReset = now;
        console.log(`Weekly leaderboard stats reset for pilot ${pilot.email}`);
    }

    if (pilot.lastMonthlyReset.getUTCMonth() !== now.getUTCMonth() || pilot.lastMonthlyReset.getUTCFullYear() !== now.getUTCFullYear()) {
        pilot.leaderboardMonthlyFlightHours = 0;
        pilot.monthlySectors = 0;
        pilot.lastMonthlyReset = now;
        console.log(`Monthly leaderboard stats reset for pilot ${pilot.email}`);
    }
};

const isValidCallsign = cs => /^[A-Z0-9-]{2,15}$/.test(cs);

const authMiddleware = (req, res, next) => {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ message: 'Access denied. No token provided.' });
    try {
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch (ex) {
        res.status(400).json({ message: 'Invalid token.' });
    }
};

const hasRole = (allowedRoles) => (req, res, next) => {
    if (req.user && allowedRoles.includes(req.user.role)) {
        next();
    } else {
        res.status(403).json({ message: 'Access denied. You do not have the required permissions.' });
    }
};

const isAdmin = hasRole(['admin']);
const isCommunityManager = hasRole(['admin', 'Chief Executive Officer (CEO)', 'Chief Operating Officer (COO)', 'Chief Marketing Officer (CMO)', 'Events Manager (EM)']);
const isPilotManager = hasRole(['admin', 'Chief Executive Officer (CEO)', 'Chief Operating Officer (COO)', 'Head of Training (COT)']);
const isPirepManager = hasRole(['admin', 'Chief Executive Officer (CEO)', 'Chief Operating Officer (COO)', 'PIREP Manager (PM)']);
const isRouteManager = hasRole(['admin', 'Chief Executive Officer (CEO)', 'Chief Operating Officer (COO)', 'Route Manager (RM)']);


// 7. API ROUTES (ENDPOINTS)

app.get('/api/airports', async (req, res) => {
    try {
        // Now serves the data from memory instead of reading the file each time
        if (Object.keys(airportsData).length === 0) {
            return res.status(503).json({ message: 'Airport data is not available at the moment. Please try again later.' });
        }
        res.json(airportsData);
    } catch (error) {
        console.error('Error in /api/airports endpoint:', error);
        res.status(500).json({ message: 'Could not load airport data.' });
    }
});

app.get('/api/leaderboard/weekly', async (req, res) => {
    try {
        const topByHours = await User.find({ role: 'pilot', weeklyFlightHours: { $gt: 0 } })
            .sort({ weeklyFlightHours: -1 })
            .limit(10)
            .select('name callsign weeklyFlightHours');
            
        const topBySectors = await User.find({ role: 'pilot', weeklySectors: { $gt: 0 } })
            .sort({ weeklySectors: -1 })
            .limit(10)
            .select('name callsign weeklySectors');

        res.json({ topByHours, topBySectors });
    } catch (error) {
        console.error('Error fetching weekly leaderboard:', error);
        res.status(500).json({ message: 'Server error while fetching weekly leaderboard.' });
    }
});

app.get('/api/leaderboard/monthly', async (req, res) => {
    try {
        const topByHours = await User.find({ role: 'pilot', leaderboardMonthlyFlightHours: { $gt: 0 } })
            .sort({ leaderboardMonthlyFlightHours: -1 })
            .limit(10)
            .select('name callsign leaderboardMonthlyFlightHours');

        const topBySectors = await User.find({ role: 'pilot', monthlySectors: { $gt: 0 } })
            .sort({ monthlySectors: -1 })
            .limit(10)
            .select('name callsign monthlySectors');
            
        res.json({ topByHours, topBySectors });
    } catch (error) {
        console.error('Error fetching monthly leaderboard:', error);
        res.status(500).json({ message: 'Server error while fetching monthly leaderboard.' });
    }
});

app.post('/api/events', authMiddleware, isCommunityManager, upload.single('eventImage'), async (req, res) => {
    try {
        const { title, date, description } = req.body;
        const newEvent = new Event({
            title, date, description, author: req.user._id,
            imageUrl: req.file ? req.file.location : undefined
        });
        await newEvent.save();
        res.status(201).json({ message: 'Event created successfully!', event: newEvent });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while creating event.' });
    }
});

app.get('/api/events', async (req, res) => {
    try {
        const events = await Event.find().sort({ date: -1 }).lean();
        res.json(events);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while fetching events.' });
    }
});

app.post('/api/highlights', authMiddleware, isCommunityManager, upload.single('highlightImage'), async (req, res) => {
    try {
        const { title, winnerName, description } = req.body;
        if (!req.file) return res.status(400).json({ message: 'An image is required for a highlight.' });
        const newHighlight = new Highlight({
            title, winnerName, description, author: req.user._id, imageUrl: req.file.location
        });
        await newHighlight.save();
        res.status(201).json({ message: 'Highlight created successfully!', highlight: newHighlight });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while creating highlight.' });
    }
});

app.get('/api/highlights', async (req, res) => {
    try {
        const highlights = await Highlight.find().sort({ createdAt: -1 }).lean();
        res.json(highlights);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while fetching highlights.' });
    }
});

app.delete('/api/events/:id', authMiddleware, isCommunityManager, async (req, res) => {
    try {
        const event = await Event.findById(req.params.id);
        if (!event) return res.status(404).json({ message: 'Event not found.' });
        if (event.imageUrl) await deleteS3Object(event.imageUrl);
        await Event.findByIdAndDelete(req.params.id);
        res.json({ message: 'Event deleted successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while deleting event.' });
    }
});

app.delete('/api/highlights/:id', authMiddleware, isCommunityManager, async (req, res) => {
    try {
        const highlight = await Highlight.findById(req.params.id);
        if (!highlight) return res.status(404).json({ message: 'Highlight not found.' });
        await deleteS3Object(highlight.imageUrl);
        await Highlight.findByIdAndDelete(req.params.id);
        res.json({ message: 'Highlight deleted successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while deleting highlight.' });
    }
});

app.get('/api/staff', async (req, res) => {
    try {
        const staffRoles = User.schema.path('role').enumValues.filter(r => r !== 'pilot');
        const staffMembers = await User.find({ role: { $in: staffRoles } }).select('-password').sort({ createdAt: -1 }).lean();
        res.json(staffMembers);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while fetching staff members.' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email: email?.toLowerCase().trim() });
        if (!user) return res.status(400).json({ message: 'Invalid email or password.' });
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ message: 'Invalid email or password.' });
        const token = jwt.sign({ _id: user._id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '3h' });
        res.json({ token });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error during login.' });
    }
});

// --- NEW: USER REGISTRATION & INVITE SYSTEM ROUTES ---

// Public-facing registration route
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password, callsign, inviteCode } = req.body;

        // 1. Validate input
        if (!name || !email || !password || !callsign || !inviteCode) {
            return res.status(400).json({ message: 'All fields, including an invite code, are required.' });
        }
        if (password.length < 6) {
            return res.status(400).json({ message: 'Password must be at least 6 characters long.' });
        }
        const normalizedCallsign = String(callsign).trim().toUpperCase();
        if (!isValidCallsign(normalizedCallsign)) {
            return res.status(400).json({ message: 'Invalid callsign format. Use letters, numbers, and hyphens (2-15 chars).' });
        }

        // 2. Validate invite code
        const invite = await Invite.findOne({ code: inviteCode, status: 'PENDING' });
        if (!invite) {
            return res.status(400).json({ message: 'This invite code is invalid or has already been used.' });
        }
        if (invite.expiresAt < new Date()) {
            invite.status = 'EXPIRED';
            await invite.save();
            return res.status(400).json({ message: 'This invite code has expired.' });
        }

        // 3. Create the new user
        const salt = await bcrypt.genSalt(10);
        const newUser = new User({
            name,
            email: String(email).toLowerCase().trim(),
            password: await bcrypt.hash(password, salt),
            callsign: normalizedCallsign,
            role: 'pilot' // All registrations via this route are pilots
        });
        await newUser.save();

        // 4. Invalidate the invite code
        invite.status = 'ACCEPTED';
        invite.usedBy = newUser._id;
        await invite.save();

        // 5. Update Google Sheet
        updateGoogleSheet({
            callsign: newUser.callsign,
            name: newUser.name,
            rank: newUser.rank,
            flightHours: newUser.flightHours
        });

        // 6. Log the user in by sending a token
        const token = jwt.sign({ _id: newUser._id, role: newUser.role, name: newUser.name }, process.env.JWT_SECRET, { expiresIn: '3h' });
        res.status(201).json({ token });

    } catch (error) {
        console.error(error);
        if (error?.code === 11000) {
            return res.status(400).json({ message: `A user with that ${Object.keys(error.keyValue)[0]} already exists.` });
        }
        res.status(500).json({ message: 'Server error during registration.' });
    }
});

// Admin-only: Create a new invite code
app.post('/api/invites', authMiddleware, isAdmin, async (req, res) => {
    try {
        const sevenDaysFromNow = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const newInvite = new Invite({
            code: crypto.randomBytes(16).toString('hex'),
            expiresAt: sevenDaysFromNow,
            createdBy: req.user._id,
        });
        await newInvite.save();
        res.status(201).json({ message: 'Invite code created successfully.', invite: newInvite });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error creating invite code.' });
    }
});

// Admin-only: Get all invite codes
app.get('/api/invites', authMiddleware, isAdmin, async (req, res) => {
    try {
        const invites = await Invite.find()
            .populate('createdBy', 'name email')
            .populate('usedBy', 'name email')
            .sort({ createdAt: -1 });
        res.json(invites);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error fetching invites.' });
    }
});

// Admin-only: Delete an invite code
app.delete('/api/invites/:inviteId', authMiddleware, isAdmin, async (req, res) => {
    try {
        const invite = await Invite.findByIdAndDelete(req.params.inviteId);
        if (!invite) {
            return res.status(404).json({ message: 'Invite not found.' });
        }
        res.json({ message: 'Invite code deleted successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error deleting invite.' });
    }
});


// --- MODIFIED /api/me to deliver notifications ---
app.get('/api/me', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('-password').populate('currentFlightPlan').lean();
        if (!user) return res.status(404).json({ message: 'User not found.' });

        user.timeUntilNextDutyMs = 0;
        if (user.dutyStatus === 'ON_REST' && user.lastDutyOff) {
            const restEndsAt = user.lastDutyOff.getTime() + MIN_REST_PERIOD;
            const now = Date.now();
            if (restEndsAt > now) {
                user.timeUntilNextDutyMs = restEndsAt - now;
            }
        }

        // Add unread notifications to the response
        user.unreadNotifications = (user.notifications || []).filter(n => !n.read);

        res.json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error.' });
    }
});


app.put('/api/me', authMiddleware, upload.single('profilePicture'), async (req, res) => {
    try {
        const { name, bio, discord, ifc, youtube, preferredContact } = req.body;
        const updatedData = { name, bio, discord, ifc, youtube, preferredContact };

        if (req.file) {
            const oldUser = await User.findById(req.user._id);
            if (oldUser?.imageUrl) await deleteS3Object(oldUser.imageUrl);
            updatedData.imageUrl = req.file.location;
        }

        const user = await User.findByIdAndUpdate(req.user._id, updatedData, { new: true }).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found.' });
        const token = jwt.sign({ _id: user._id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '3h' });
        res.json({ message: 'Profile updated successfully!', user, token });
    } catch (error) {
        console.error(error);
        if (error?.code === 11000) return res.status(400).json({ message: `A user with that ${Object.keys(error.keyValue)[0]} already exists.` });
        res.status(500).json({ message: 'Server error while updating profile.' });
    }
});

app.post('/api/me/password', authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword || newPassword.length < 6) {
            return res.status(400).json({ message: 'Current password is required, and the new password must be at least 6 characters long.' });
        }
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ message: 'User not found.' });

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) return res.status(400).json({ message: 'Incorrect current password.' });

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);
        await user.save();
        res.json({ message: 'Password updated successfully!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error while updating password.' });
    }
});

// --- NEW Route to mark notifications as read ---
app.post('/api/me/notifications/read', authMiddleware, async (req, res) => {
    try {
        const { notificationIds } = req.body; // Expect an array of IDs from the frontend
        if (!Array.isArray(notificationIds)) {
            return res.status(400).json({ message: 'Expected an array of notification IDs.' });
        }

        await User.updateOne(
            { _id: req.user._id },
            { $set: { "notifications.$[elem].read": true } },
            { arrayFilters: [{ "elem._id": { $in: notificationIds } }] }
        );

        res.json({ message: 'Notifications marked as read.' });
    } catch (err) {
        console.error('Error marking notifications as read:', err);
        res.status(500).json({ message: 'Server error.' });
    }
});


// --- NEW: FLIGHT PLANNING & PIREP AUTOMATION ROUTES ---

app.post('/api/flightplans', authMiddleware, async (req, res) => {
    try {
        const { flightNumber, departure, arrival, aircraft, etd, eet, alternate, pob, route } = req.body;
        if (!flightNumber || !departure || !arrival || !aircraft || !etd || !eet || !alternate || !pob || !route) {
            return res.status(400).json({ message: 'Please provide all required flight plan details.' });
        }

        const pilot = await User.findById(req.user._id);
        if (!pilot) return res.status(404).json({ message: 'Pilot not found.' });

        if (pilot.promotionStatus === 'PENDING_TEST') {
            return res.status(403).json({ message: 'You are awaiting promotion tests and cannot file new flight plans.' });
        }
        if (pilot.currentFlightPlan) {
            return res.status(400).json({ message: 'You already have an active flight plan. Please complete or cancel it first.' });
        }

        const planData = { departure, arrival, aircraft };
        const rosterLegData = {};

        if (pilot.dutyStatus === 'ON_DUTY') {
            if (!pilot.currentRoster) return res.status(400).json({ message: 'You are on duty but have no assigned roster.' });
            await pilot.populate('currentRoster');

            const leg = pilot.currentRoster.legs.find(l => l.flightNumber.toUpperCase() === flightNumber.toUpperCase());
            if (!leg) return res.status(400).json({ message: 'This flight number does not match any leg in your assigned roster.' });

            const existingPlanForLeg = await FlightPlan.findOne({
                pilot: pilot._id,
                'rosterLeg.rosterId': pilot.currentRoster._id,
                'rosterLeg.flightNumber': flightNumber,
                status: { $in: ['PLANNED', 'FLYING', 'COMPLETED'] }
            });
            if (existingPlanForLeg) return res.status(400).json({ message: 'You have already filed a flight plan for this roster leg.' });

            planData.departure = leg.departure;
            planData.arrival = leg.arrival;
            planData.aircraft = leg.aircraft;
            rosterLegData.rosterId = pilot.currentRoster._id;
            rosterLegData.flightNumber = leg.flightNumber;
        }

        const requiredRank = deduceRankFromAircraft(planData.aircraft);
        if (!canFlyLeg(pilot.rank, requiredRank)) {
            return res.status(403).json({ message: `This aircraft/route requires ${requiredRank}, which is above your rank (${pilot.rank}).` });
        }

        const eetHours = parseFloat(eet);
        const etdDate = new Date(etd);
        const etaDate = new Date(etdDate.getTime() + eetHours * 60 * 60 * 1000);

        let dispatchData = null;
        try {
            console.log('Requesting detailed dispatch from Python service...');

            // Prepare the data payload for the Python service
            const dispatchPayload = {
                pilot_id: pilot._id.toString(),
                flight_number: flightNumber,
                aircraft_type: aircraft,
                departure_icao: planData.departure,
                arrival_icao: planData.arrival,
                etd: etdDate.toISOString().substr(11, 5).replace(':', ''), // Format as HHMM
                eta: etaDate.toISOString().substr(11, 5).replace(':', ''), // Format as HHMM
                duration: `${String(Math.floor(eetHours)).padStart(2, '0')}:${String(Math.round((eetHours % 1) * 60)).padStart(2, '0')}` // Format as HH:MM
            };
            
            // Call the Python dispatch service
            const dispatchResponse = await axios.post('http://127.0.0.1:5001/dispatch/create', dispatchPayload);

            if (dispatchResponse.data) {
                console.log('Successfully received dispatch data.');
                dispatchData = dispatchResponse.data; // Store the full response
            }

        } catch (dispatchError) {
            console.error('Error fetching data from Python dispatch service:', dispatchError.response ? dispatchError.response.data : dispatchError.message);
            // Decide if you want to fail the whole process or continue without dispatch data
            // For now, we'll just log it and continue without the detailed data.
        }

        // =================================================================
        // END: NEW CODE FOR DISPATCH INTEGRATION
        // =================================================================

        const newFlightPlan = new FlightPlan({
            pilot: pilot._id,
            flightNumber,
            departure: planData.departure,
            arrival: planData.arrival,
            aircraft: planData.aircraft,
            alternate,
            pob,
            route,
            etd: etdDate,
            eet: eetHours,
            eta: etaDate,
            ficNumber: generateFicNumber(),
            adcNumber: generateAdcNumber(),
            rosterLeg: pilot.dutyStatus === 'ON_DUTY' ? rosterLegData : undefined,
            dispatchData: dispatchData // Add the new data here
        });

        await newFlightPlan.save();
        pilot.currentFlightPlan = newFlightPlan._id;
        await pilot.save();

        res.status(201).json({ message: 'Flight plan filed successfully. You are cleared to depart at your ETD.', flightPlan: newFlightPlan });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while filing flight plan.' });
    }
});

app.get('/api/flightplans/my-active', authMiddleware, async (req, res) => {
    try {
        const pilot = await User.findById(req.user._id).populate('currentFlightPlan');
        if (!pilot) return res.status(404).json({ message: 'Pilot not found.' });
        if (!pilot.currentFlightPlan) return res.json(null); // No active plan is a valid state

        res.json(pilot.currentFlightPlan);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error fetching active flight plan.' });
    }
});

app.post('/api/flightplans/:id/depart', authMiddleware, async (req, res) => {
    try {
        const flightPlan = await FlightPlan.findById(req.params.id);
        if (!flightPlan) return res.status(404).json({ message: 'Flight plan not found.' });
        if (flightPlan.pilot.toString() !== req.user._id) return res.status(403).json({ message: 'This is not your flight plan.' });
        if (flightPlan.status !== 'PLANNED') return res.status(400).json({ message: `Cannot depart. Flight status is already '${flightPlan.status}'.` });

        flightPlan.status = 'FLYING';
        flightPlan.actualDepartureTime = Date.now();
        await flightPlan.save();

        res.json({ message: 'Departure confirmed. Your flight is now active.', flightPlan });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error during departure.' });
    }
});

app.post('/api/flightplans/:id/arrive', authMiddleware, upload.single('verificationImage'), async (req, res) => {
    try {
        const { remarks } = req.body;
        if (!req.file) return res.status(400).json({ message: 'A verification image of the flight is required to generate a PIREP.' });

        const flightPlan = await FlightPlan.findById(req.params.id);
        if (!flightPlan) return res.status(404).json({ message: 'Flight plan not found.' });
        if (flightPlan.pilot.toString() !== req.user._id) return res.status(403).json({ message: 'This is not your flight plan.' });
        if (flightPlan.status !== 'FLYING') return res.status(400).json({ message: `Cannot arrive. Flight status must be 'FLYING'.` });

        flightPlan.status = 'COMPLETED';
        flightPlan.actualArrivalTime = Date.now();
        const flightTimeHours = (flightPlan.actualArrivalTime - flightPlan.actualDepartureTime) / (1000 * 60 * 60);

        const newPirepData = {
            pilot: flightPlan.pilot,
            flightNumber: flightPlan.flightNumber,
            departure: flightPlan.departure,
            arrival: flightPlan.arrival,
            aircraft: flightPlan.aircraft,
            flightTime: parseFloat(flightTimeHours.toFixed(2)),
            remarks,
            verificationImageUrl: req.file.location,
            status: 'PENDING',
            isMultiplierEligible: false,
        };

        if (flightPlan.rosterLeg && flightPlan.rosterLeg.rosterId) {
            const roster = await Roster.findById(flightPlan.rosterLeg.rosterId);
            if (roster) {
                const leg = roster.legs.find(l => l.flightNumber === flightPlan.flightNumber);
                if (leg) {
                    newPirepData.rankUnlock = leg.rankUnlock;
                    newPirepData.operator = leg.operator;
                    newPirepData.rosterLeg = flightPlan.rosterLeg;
                    const lastLegInRoster = roster.legs[roster.legs.length - 1];
                    if (lastLegInRoster.flightNumber.toUpperCase() === flightPlan.flightNumber.toUpperCase()) {
                        newPirepData.isMultiplierEligible = true;
                    }
                }
            }
        } else {
            newPirepData.rankUnlock = deduceRankFromAircraft(flightPlan.aircraft);
            newPirepData.operator = 'IndGo Air Virtual';
        }

        const newPirep = new Pirep(newPirepData);
        await newPirep.save();

        await User.updateOne({ _id: flightPlan.pilot }, { $set: { currentFlightPlan: null } });
        await flightPlan.save();

        res.status(201).json({ message: 'Flight completed successfully! Your PIREP has been automatically generated and is pending review.', pirep: newPirep });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while completing flight.' });
    }
});

app.post('/api/flightplans/:id/cancel', authMiddleware, async (req, res) => {
    try {
        const flightPlan = await FlightPlan.findById(req.params.id);
        if (!flightPlan) return res.status(404).json({ message: 'Flight plan not found.' });
        if (flightPlan.pilot.toString() !== req.user._id) return res.status(403).json({ message: 'This is not your flight plan.' });
        if (flightPlan.status !== 'PLANNED') return res.status(400).json({ message: `Cannot cancel a flight that is already '${flightPlan.status}'.` });

        flightPlan.status = 'CANCELLED';
        await flightPlan.save();
        await User.updateOne({ _id: flightPlan.pilot }, { $set: { currentFlightPlan: null } });

        res.json({ message: 'Flight plan has been successfully cancelled.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while cancelling flight plan.' });
    }
});

app.get('/api/me/pireps', authMiddleware, async (req, res) => {
    try {
        const pireps = await Pirep.find({ pilot: req.user._id }).sort({ createdAt: -1 }).lean();
        res.json(pireps);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while fetching your flight reports.' });
    }
});

app.get('/api/pireps/pending', authMiddleware, isPirepManager, async (req, res) => {
    try {
        const pendingPireps = await Pirep.find({ status: 'PENDING' })
            .populate('pilot', 'name callsign')
            .sort({ createdAt: 'asc' });
        res.json(pendingPireps);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while fetching pending PIREPs.' });
    }
});

// --- ***MODIFIED*** PIREP Approval to allow time correction and handle FTPL exemption ---
app.put('/api/pireps/:pirepId/approve', authMiddleware, isPirepManager, async (req, res) => {
    try {
        const { correctedFlightTime } = req.body; // Staff can optionally send a corrected time

        const pirep = await Pirep.findById(req.params.pirepId);
        if (!pirep) return res.status(404).json({ message: 'PIREP not found.' });
        if (pirep.status !== 'PENDING') return res.status(400).json({ message: `This PIREP has already been ${pirep.status.toLowerCase()}.` });
        if (pirep.verificationImageUrl) { deleteS3Object(pirep.verificationImageUrl); }

        const pilot = await User.findById(pirep.pilot);
        if (!pilot) return res.status(404).json({ message: 'Associated pilot profile not found.' });

        let hoursToAdd = pirep.flightTime; // Default to original time
        let timeWasCorrected = false;

        // If staff sent a valid, positive corrected flight time, use it instead.
        const parsedTime = parseFloat(correctedFlightTime);
        if (parsedTime && !isNaN(parsedTime) && parsedTime > 0) {
            hoursToAdd = parsedTime;
            pirep.flightTime = hoursToAdd; // Update the PIREP record with the corrected time
            timeWasCorrected = true;
        }
        
        let multiplierApplied = 1;
        if (pirep.isMultiplierEligible && pirep.rosterLeg?.rosterId) {
            const roster = await Roster.findById(pirep.rosterLeg.rosterId);
            if (roster && roster.multiplier > 1) {
                hoursToAdd *= roster.multiplier;
                multiplierApplied = roster.multiplier;
            }
        }

        checkAndResetLeaderboardStats(pilot);
        pilot.flightHours += hoursToAdd;
        pilot.weeklyFlightHours += hoursToAdd;
        pilot.leaderboardMonthlyFlightHours += hoursToAdd;
        pilot.weeklySectors += 1;
        pilot.monthlySectors += 1;

        // MODIFIED: Only update FTPL counters for non-exempt pilots on roster flights
        if (pirep.rosterLeg && pirep.rosterLeg.rosterId && !pilot.isFtplExempt) {
            pilot.monthlyFlightHours += hoursToAdd;
            pilot.dailyFlightHours += hoursToAdd;
        }
        pilot.lastKnownAirport = pirep.arrival;
        
        const promotionResult = checkAndApplyRankUpdate(pilot);
        
        pirep.status = 'APPROVED';
        pirep.reviewedBy = req.user._id;
        pirep.reviewedAt = Date.now();
        pirep.verificationImageUrl = null;
        
        await pilot.save();
        await pirep.save();

        if (pilot.callsign) {
            updateGoogleSheet({ callsign: pilot.callsign, name: pilot.name, rank: pilot.rank, flightHours: pilot.flightHours });
        }
        
        let message = `PIREP approved. ${pilot.name} now has ${pilot.flightHours.toFixed(2)} hours.`;
        if (timeWasCorrected) {
             message += ` Flight time was manually corrected to ${pirep.flightTime.toFixed(2)} hours.`;
        }
        if (multiplierApplied > 1) {
             message += ` A ${multiplierApplied}x multiplier was applied!`;
        }

        const responsePayload = { message, promotionDetails: null };

        if (promotionResult.promoted) {
            responsePayload.message += ` Congratulations on the promotion to ${promotionResult.rank}!`;
        }
        
        if (promotionResult.pendingTest) {
            const log = new AdminLog({
                adminUser: req.user._id,
                action: 'PROMOTION_TEST_REQUIRED',
                targetUser: pilot._id,
                details: `${pilot.name} (${pilot.email}) has reached the required hours for ${promotionResult.prospectiveRank} and requires testing.`
            });
            await log.save();
            responsePayload.message += ` You have reached the flight hour requirement for the next rank! Staff has been notified to schedule your practical and written tests. Your account is now in an observation period.`;
        }
        
        res.json(responsePayload);

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while approving PIREP.' });
    }
});


app.put('/api/pireps/:pirepId/reject', authMiddleware, isPirepManager, async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason) return res.status(400).json({ message: 'A reason for rejection is required.' });

        const pirep = await Pirep.findById(req.params.pirepId);
        if (!pirep) return res.status(404).json({ message: 'PIREP not found.' });
        if (pirep.status !== 'PENDING') return res.status(400).json({ message: `This PIREP was already ${pirep.status.toLowerCase()}.` });

        if (pirep.verificationImageUrl) {
            await deleteS3Object(pirep.verificationImageUrl);
        }
        
        pirep.status = 'REJECTED';
        pirep.rejectionReason = reason;
        pirep.reviewedBy = req.user._id;
        pirep.reviewedAt = Date.now();
        pirep.verificationImageUrl = null;
        await pirep.save();
        
        res.json({ message: 'PIREP has been successfully rejected.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while rejecting PIREP.' });
    }
});

// --- MODIFIED Manual Rank Update to handle promotion completion ---
app.put('/api/users/:userId/rank', authMiddleware, isPilotManager, async (req, res) => {
    try {
        const { userId } = req.params;
        const { newRank } = req.body;
        if (!newRank || !pilotRanks.includes(newRank)) return res.status(400).json({ message: 'Invalid rank specified.' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found.' });

        const oldRank = user.rank;
        user.rank = newRank;

        // --- NEW LOGIC ---
        // If the user was pending a test, reset their status and add a notification
        if (user.promotionStatus === 'PENDING_TEST') {
            user.promotionStatus = 'ACTIVE';
            user.notifications.push({
                message: `Congratulations! You have passed your tests and have been promoted from ${oldRank} to ${newRank}. You are now cleared for normal flight operations.`
            });
        }
        // --- END OF NEW LOGIC ---

        await user.save();

        if (user.callsign) {
            updateGoogleSheet({ callsign: user.callsign, name: user.name, rank: user.rank, flightHours: user.flightHours });
        }
        res.json({ message: `Successfully updated ${user.name}'s rank to ${newRank}.` });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while updating rank.' });
    }
});



app.get('/api/rosters', authMiddleware, async (req, res) => {
    try {
        const { all } = req.query;
        const managerRoles = ['admin', 'Chief Executive Officer (CEO)', 'Chief Operating Officer (COO)', 'Route Manager (RM)'];
        const isManager = managerRoles.includes(req.user.role);

        if (all === 'true' && isManager) {
            const allRosters = await Roster.find({}).sort({ hub: 1, name: 1 }).lean();
            return res.json(allRosters);
        }

        const user = await User.findById(req.user._id).lean();
        if (!user) return res.status(404).json({ message: 'User not found.' });
        
        const departureIcao = String(user.lastKnownAirport || 'VIDP').toUpperCase().trim();

        const rosters = await Roster.find({
            isAvailable: true,
            $or: [
            { 'legs.0.departure': departureIcao },
            { hub: departureIcao }
        ] 
        }).sort({ createdAt: -1 }).lean();

        const filtered = rosters.filter(r =>
            Array.isArray(r.legs) && r.legs.length > 0 &&
            r.legs.every(l => canFlyLeg(user.rank, getLegRequiredRank(l)))
        );
        res.json(filtered);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while fetching available rosters.' });
    }
});

app.get('/api/rosters/my-rosters', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).lean();
        if (!user) return res.status(404).json({ message: 'User not found.' });

        const fromDutyLocation = user.lastDutyAirport;
        const fromPirepLocation = user.lastKnownAirport;

        const searchLocations = new Set(
            [fromDutyLocation, fromPirepLocation]
                .filter(Boolean)
                .map(s => String(s).toUpperCase().trim())
        );
        if (searchLocations.size === 0) {
            searchLocations.add('VIDP');
        }

        const availableRosters = await Roster.find({
            isAvailable: true,
            $or: [
                { 'legs.0.departure': { $in: Array.from(searchLocations) } },
                { hub: { $in: Array.from(searchLocations) } }
            ]
        }).sort({ createdAt: -1 }).lean();

        res.json({
            rosters: availableRosters.filter(r =>
                Array.isArray(r.legs) && r.legs.length > 0 &&
                r.legs.every(l => canFlyLeg(user.rank, getLegRequiredRank(l)))
            ),
            searchCriteria: {
                fromLastDuty: fromDutyLocation,
                fromLastPirep: fromPirepLocation,
                searched: Array.from(searchLocations)
            }
        });

    } catch (error) {
        console.error("Error fetching personalized rosters:", error);
        res.status(500).json({ message: 'Server error while fetching your personalized rosters.' });
    }
});

app.post('/api/rosters', authMiddleware, isRouteManager, async (req, res) => {
    try {
        
        const { name, hub, legs, totalFlightTime } = req.body;
        if (!name || !hub || !Array.isArray(legs) || legs.length === 0) {
            return res.status(400).json({ message: 'Name, hub and at least one leg are required.' });
        }
        const normalizeICAO = s => String(s || '').toUpperCase().trim();

        const finishedLegs = legs.map(l => {
            const aircraft = l.aircraft || '';
            const operator = (l.operator && String(l.operator).trim()) || 'IndGo Air Virtual';
            const rankUnlock = (l.rankUnlock && String(l.rankUnlock).trim()) || deduceRankFromAircraft(aircraft);
            const departureIcao = normalizeICAO(l.departure);
            const arrivalIcao = normalizeICAO(l.arrival);

            return { 
                ...l, 
                operator, 
                rankUnlock,
                departure: departureIcao,
                arrival: arrivalIcao,
                departureCountry: getCountryCode(departureIcao),
                arrivalCountry: getCountryCode(arrivalIcao)
            };
        });
        const computedTFT = typeof totalFlightTime === 'number' && totalFlightTime > 0
            ? totalFlightTime
            : finishedLegs.reduce((s, L) => s + (Number(L.flightTime) || 0), 0);

        const randomMultiplier = parseFloat((1.1 + Math.random() * 0.4).toFixed(2));
        const newRoster = new Roster({ 
            name, 
            hub: normalizeICAO(hub || finishedLegs[0]?.departure), 
            legs: finishedLegs, 
            totalFlightTime: computedTFT, 
            multiplier: randomMultiplier,
            createdBy: req.user._id 
        });
        await newRoster.save();

        const log = new AdminLog({ adminUser: req.user._id, action: 'ROSTER_CREATE', details: `Created new roster: "${name}"` });
        await log.save();
        
        res.status(201).json(newRoster);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while creating roster.' });
    }
});

app.post('/api/rosters/generate', authMiddleware, isRouteManager, async (req, res) => {
    try {
        const result = await generateRostersFromGoogleSheet();
        res.status(201).json({
            message: `Roster generation complete. Found a total of ${result.legsFound} legs and created ${result.created} new rosters.`
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: error.message });
    }
});

app.delete('/api/rosters/:rosterId', authMiddleware, isRouteManager, async (req, res) => {
    try {
        const roster = await Roster.findByIdAndDelete(req.params.rosterId);
        if (!roster) return res.status(404).json({ message: 'Roster not found.' });

        const log = new AdminLog({ adminUser: req.user._id, action: 'ROSTER_DELETE', details: `Deleted roster: "${roster.name}" (ID: ${roster._id})` });
        await log.save();

        res.json({ message: 'Roster deleted successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while deleting roster.' });
    }
});

// --- MODIFIED Duty Start to handle FTPL exemption ---
app.post('/api/duty/start', authMiddleware, async (req, res) => {
    const { rosterId } = req.body;
    try {
        const user = await User.findById(req.user._id);
        const roster = await Roster.findById(rosterId);

        if (!roster) return res.status(404).json({ message: 'Selected roster not found.' });
        if (user.dutyStatus === 'ON_DUTY') return res.status(400).json({ message: 'You are already on duty.' });

        if (user.promotionStatus === 'PENDING_TEST') {
            return res.status(403).json({
                message: 'You are currently in an observation period awaiting promotion tests. You cannot start a new duty until your tests are complete and you have been promoted by a staff member.'
            });
        }

        // This intelligent reset should happen for all users when starting a new duty after rest.
        if (user.lastDutyOff && (Date.now() - user.lastDutyOff.getTime()) >= MIN_REST_PERIOD) {
            user.dailyFlightHours = 0;
            console.log(`Daily flight hours for ${user.email} reset due to starting a new duty period.`);
        }

        // --- FTPL Checks ---
        // These checks are bypassed if the user is exempt.
        if (!user.isFtplExempt) {
            if (user.lastDutyOff && (Date.now() - user.lastDutyOff) < MIN_REST_PERIOD) {
                const timeToRest = Math.ceil((MIN_REST_PERIOD - (Date.now() - user.lastDutyOff)) / (60 * 1000));
                return res.status(403).json({ message: `Crew rest required. You can go on duty in ${timeToRest} minutes.` });
            }
            
            const oneMonthAgo = new Date();
            oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
            if (user.lastHourReset < oneMonthAgo) {
                user.monthlyFlightHours = 0;
                user.lastHourReset = Date.now();
            }
            if ((user.monthlyFlightHours + roster.totalFlightTime) > MAX_MONTHLY_FLIGHT_HOURS) {
                return res.status(403).json({ message: `This duty would exceed your ${MAX_MONTHLY_FLIGHT_HOURS}-hour monthly limit.` });
            }
            if ((user.dailyFlightHours + roster.totalFlightTime) > MAX_DAILY_FLIGHT_HOURS) {
                return res.status(403).json({ message: `This duty would exceed your ${MAX_DAILY_FLIGHT_HOURS}-hour daily flight limit.` });
            }
        }
        
        const overRankLeg = roster.legs.find(l => !canFlyLeg(user.rank, getLegRequiredRank(l)));
        if (overRankLeg) {
            return res.status(403).json({
                message: `This roster includes leg ${overRankLeg.flightNumber} (${overRankLeg.aircraft}) requiring ${getLegRequiredRank(overRankLeg)}, which is above your rank (${user.rank}).`
            });
        }
        user.dutyStatus = 'ON_DUTY';
        user.currentRoster = roster._id;
        user.lastDutyStart = Date.now();
        await user.save();
        
        res.json({ message: `You are now on duty for roster "${roster.name}".`, roster });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while starting duty.' });
    }
});


app.post('/api/duty/end', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).populate('currentRoster');
        if (user.dutyStatus !== 'ON_DUTY') return res.status(400).json({ message: 'You are not currently on duty.' });
        if (!user.currentRoster) return res.status(400).json({ message: 'No roster assigned to end duty.' });

        const roster = user.currentRoster;
        const filedPireps = await Pirep.countDocuments({
            pilot: user._id,
            'rosterLeg.rosterId': roster._id,
            status: { $in: ['APPROVED', 'PENDING'] }
        });

        if (filedPireps < roster.legs.length) {
            return res.status(400).json({ message: `You must file PIREPs for all roster legs. ${filedPireps}/${roster.legs.length} complete.` });
        }
        
        const finalLeg = roster.legs[roster.legs.length - 1];
        if (finalLeg) {
            user.lastDutyAirport = finalLeg.arrival;
        }

        user.dutyStatus = 'ON_REST';
        user.currentRoster = null;
        user.lastDutyOff = Date.now();
        user.lastDutyStart = null;
        await user.save();
        
        res.json({ message: 'Duty day completed successfully! You are now on crew rest.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while ending duty.' });
    }
});

// This route is now intended for creating STAFF/ADMIN accounts manually.
// Pilots should register using the public /api/register route with an invite code.
app.post('/api/users', authMiddleware, isAdmin, async (req, res) => {
    try {
        const { email, password, role, callsign, name } = req.body;
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
        
        if (normalizedCallsign && user.role === 'pilot') {
            updateGoogleSheet({ callsign: normalizedCallsign, name: user.name, rank: user.rank, flightHours: user.flightHours || 0 });
        }
        
        const userResponse = user.toObject();
        delete userResponse.password;
        return res.status(201).json(userResponse);

    } catch (error) {
        console.error(error);
        if (error?.code === 11000) {
            return res.status(400).json({ message: `A user with this ${Object.keys(error.keyValue)[0]} already exists.` });
        }
        return res.status(500).json({ message: 'Server error while creating user.' });
    }
});

app.get('/api/users', authMiddleware, isAdmin, async (req, res) => {
    try {
        const users = await User.find()
            .select('name email callsign rank flightHours role createdAt')
            .lean();
        res.json(users);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while fetching users.' });
    }
});

app.put('/api/users/:userId/role', authMiddleware, isAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        const { newRole } = req.body;
        if (!User.schema.path('role').enumValues.includes(newRole)) {
            return res.status(400).json({ message: 'Invalid role specified.' });
        }
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
        console.error(error);
        res.status(500).json({ message: 'Server error while updating user role.' });
    }
});

app.put('/api/users/:userId/callsign', authMiddleware, isAdmin, async (req, res) => {
    try {
        const { userId } = req.params;
        let { callsign } = req.body;
        if (!callsign || String(callsign).trim() === '') {
            return res.status(400).json({ message: 'A non-empty callsign must be provided.' });
        }
        callsign = String(callsign).trim().toUpperCase();
        if (!isValidCallsign(callsign)) return res.status(400).json({ message: 'Invalid callsign format.' });
        
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found.' });
        
        user.callsign = callsign;
        await user.save();

        updateGoogleSheet({ callsign, name: user.name, rank: user.rank, flightHours: user.flightHours || 0 });
        res.json({ message: `Callsign ${callsign} assigned to ${user.email}` });
    } catch (error) {
        console.error(error);
        if (error?.code === 11000) {
            return res.status(400).json({ message: 'This callsign is already taken by another user.' });
        }
        res.status(500).json({ message: 'Server error while assigning callsign.' });
    }
});

// --- NEW ENDPOINT to toggle FTPL status for a user ---
app.put('/api/users/:userId/toggle-ftpl', authMiddleware, isPilotManager, async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found.' });

        // Toggle the boolean field
        user.isFtplExempt = !user.isFtplExempt;
        await user.save();

        const status = user.isFtplExempt ? 'DISABLED' : 'ENABLED';
        
        // Log the action
        const log = new AdminLog({
            adminUser: req.user._id,
            action: 'FTPL_STATUS_UPDATE',
            targetUser: userId,
            details: `Set FTPL status to ${status} for user ${user.email}.`
        });
        await log.save();

        res.json({ message: `Successfully set FTPL engine status to ${status} for ${user.name}.`, isFtplExempt: user.isFtplExempt });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while toggling FTPL status.' });
    }
});

app.delete('/api/users/:userId', authMiddleware, isAdmin, async (req, res) => {
    const { userId } = req.params;
    try {
        if (String(req.user._id) === String(userId)) {
            return res.status(400).json({ message: 'You cannot delete your own admin account.' });
        }

        const userToDelete = await User.findById(userId);
        if (!userToDelete) return res.status(404).json({ message: 'User not found.' });

        if (userToDelete.callsign) {
            deleteRowFromGoogleSheet(userToDelete.callsign);
        }

        await User.findByIdAndDelete(userId);

        const log = new AdminLog({
            adminUser: req.user._id,
            action: 'USER_DELETE',
            details: `Deleted user with email ${userToDelete.email} and all associated data.`
        });
        await log.save();

        res.json({ message: 'User and all associated data deleted successfully.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while deleting user.' });
    }
});

app.get('/api/logs', authMiddleware, isAdmin, async (req, res) => {
    try {
        const logs = await AdminLog.find()
            .populate('adminUser', 'name email')
            .populate('targetUser', 'name email')
            .sort({ timestamp: -1 })
            .lean();
        res.json(logs);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while fetching logs.' });
    }
});

// 8. START THE SERVER
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});