// server.js (Fully Merged, Updated & Performance Tuned)
// - Automated Roster Generation now reads from TWO Google Sheets simultaneously:
//   1. The primary routes sheet (for regular flights).
//   2. The codeshare routes sheet (for partner flights).
// - NO separate import step needed. Roster generation pulls all data in real-time.
// - Strict Flight & Duty Time Limitations (FTPL) engine.
// - Location-aware roster availability for pilots.
// - Robust Google Sheets function with dynamic column mapping.
// - Advanced PIREP system with a staff review workflow.
// - Automatic rank promotions upon PIREP approval.
// - Cascade delete functionality for users and their associated data.
// - Personalized roster suggestions based on pilot's last duty/flight location.
// - NEW: Roster multipliers for bonus flight hours on final legs.
// - NEW: Image verification required for all PIREP submissions.
// - NEW: Map feature support via airports data endpoint.

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
require('dotenv').config();

// 2. INITIALIZE EXPRESS APP & AWS S3 CLIENT
const app = express();
const PORT = process.env.PORT || 5000;

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

// 4. CONNECT TO MONGODB DATABASE
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB connected successfully.'))
    .catch(err => console.error('MongoDB connection error:', err));

// 5. DEFINE SCHEMAS AND MODELS

// --- Constants for FTPL ---
const MIN_REST_PERIOD = 8 * 60 * 60 * 1000; // 8 hours in ms
const MAX_DUTY_PERIOD = 14 * 60 * 60 * 1000; // 14 hours in ms
const MAX_DAILY_FLIGHT_HOURS = 10;
const MAX_MONTHLY_FLIGHT_HOURS = 100;

// --- MODIFIED: NEW RANK STRUCTURE ---
const pilotRanks = [
    'IndGo Cadet', 'Skyline Observer', 'Route Explorer', 'Skyline Officer',
    'Command Captain', 'Elite Captain', 'Blue Eagle', 'Line Instructor',
    'Chief Flight Instructor', 'IndGo SkyMaster', 'Blue Legacy Commander'
];

// --- Rank helpers (allow flights at or below the pilot's rank) ---
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

// --- User Schema (Enhanced for FTPL) ---
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
    dutyStatus: { type: String, enum: ['ON_REST', 'ON_DUTY'], default: 'ON_REST' },
    currentRoster: { type: mongoose.Schema.Types.ObjectId, ref: 'Roster', default: null },
    lastDutyStart: { type: Date, default: null }, 
    lastDutyOff: { type: Date, default: null },   
    dailyFlightHours: { type: Number, default: 0 }, 
    monthlyFlightHours: { type: Number, default: 0 },
    lastHourReset: { type: Date, default: Date.now }, 
    lastKnownAirport: { type: String, uppercase: true, trim: true, default: 'VIDP' }, 
    lastDutyAirport: { type: String, uppercase: true, trim: true, default: null } 
}, { toJSON: { virtuals: true }, toObject: { virtuals: true } }); 
UserSchema.index({ callsign: 1 }, { unique: true, sparse: true });

// --- PERFORMANCE UPDATE: ADDED MIDDLEWARE FOR EFFICIENT CASCADE DELETES ---
UserSchema.pre('findOneAndDelete', { document: true, query: true }, async function(next) {
    try {
        const user = await this.model.findOne(this.getFilter());
        if (!user) return next();

        console.log(`Performing cascade delete for user: ${user.email}`);

        // 1. Delete user's S3 profile picture (no need to await)
        if (user.imageUrl) {
            deleteS3Object(user.imageUrl);
        }

        // 2. Delete all PIREPs filed by the user
        await mongoose.model('Pirep').deleteMany({ pilot: user._id });

        // 3. Find and delete user-created events and their S3 images
        const events = await mongoose.model('Event').find({ author: user._id }).lean();
        for (const event of events) {
            if (event.imageUrl) deleteS3Object(event.imageUrl);
        }
        await mongoose.model('Event').deleteMany({ author: user._id });
        
        // 4. Do the same for highlights
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

// --- PERFORMANCE UPDATE: ADDED INDEXES FOR FASTER QUERIES ---
UserSchema.index({ role: 1 }); // For fetching staff members quickly
UserSchema.index({ lastKnownAirport: 1, lastDutyAirport: 1 }); // Speeds up personalized roster lookups


// --- Admin Log Schema ---
const AdminLogSchema = new mongoose.Schema({
    adminUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true, enum: ['ROLE_UPDATE', 'USER_DELETE', 'ROSTER_CREATE', 'ROSTER_DELETE'] },
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

// --- PIREP Schema ---
const PirepSchema = new mongoose.Schema({
    pilot: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    flightNumber: { type: String, required: true },
    departure: { type: String, required: true, uppercase: true, trim: true },
    arrival: { type: String, required: true, uppercase: true, trim: true },
    aircraft: { type: String, required: true },
    flightTime: { type: Number, required: true, min: 0.1 },
        // Required metadata for routes
        rankUnlock: { type: String, required: true, trim: true },
        operator:   { type: String, required: true, trim: true },
    remarks: { type: String, trim: true },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date, default: null },
    verificationImageUrl: { type: String, default: null }, // Temporary URL for staff review
    isMultiplierEligible: { type: Boolean, default: false }, // True if this is the last leg of a roster
    rosterLeg: {
        rosterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Roster' },
        flightNumber: { type: String }
    }
});
const Pirep = mongoose.model('Pirep', PirepSchema);

// --- PERFORMANCE UPDATE: ADDED INDEXES FOR FASTER QUERIES ---
PirepSchema.index({ pilot: 1 }); // Speeds up fetching a user's PIREPs
PirepSchema.index({ status: 1 }); // Speeds up finding 'PENDING' PIREPs
PirepSchema.index({ 'rosterLeg.rosterId': 1, 'rosterLeg.flightNumber': 1 }); // Speeds up checking for duplicate PIREPs on a roster


// --- Roster Schema (Enhanced for Automation) ---
const RosterSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    hub: { type: String, required: true, uppercase: true, trim: true },
    legs: [{
        flightNumber: { type: String, required: true, trim: true },
        departure: { type: String, required: true, uppercase: true, trim: true },
        arrival: { type: String, required: true, uppercase: true, trim: true },
        aircraft: { type: String, required: true, trim: true },
        flightTime: { type: Number, required: true, min: 0.1 }
    }],
    totalFlightTime: { type: Number, required: true, min: 0 },
    multiplier: { type: Number, default: 1, min: 1, max: 2 }, // Random multiplier for the final leg
    isAvailable: { type: Boolean, default: true },
    isGenerated: { type: Boolean, default: false }, 
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
});
const Roster = mongoose.model('Roster', RosterSchema);

// --- PERFORMANCE UPDATE: ADDED INDEXES FOR FASTER QUERIES ---
RosterSchema.index({ isAvailable: 1, 'legs.0.departure': 1 }); // Speeds up finding available rosters by location


// 6. HELPER FUNCTIONS & MIDDLEWARE

// Helper function to delete an object from S3
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

// Improved Google Sheets update function
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

// Deletes a row from the Google Sheet based on a callsign
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

// --- (UPGRADED) AUTOMATED ROSTER GENERATION LOGIC ---

// Deduce a rank from the aircraft string (mirrors the sheet's ARRAYFORMULA mapping)
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
                        return { flightNumber, departure: departureIcao, arrival: arrivalIcao, aircraft, flightTime, rankUnlock, operator };
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

    const legsByDeparture = allLegs.reduce((acc, leg) => {
        if (!acc[leg.departure]) acc[leg.departure] = [];
        acc[leg.departure].push(leg);
        return acc;
    }, {});

    const generatedRosters = [];
    
    // Get a list of all unique departure airports found in the spreadsheets.
    const allDepartureAirports = Object.keys(legsByDeparture);
    console.log(`Found ${allDepartureAirports.length} unique departure airports for roster generation.`);

    // Loop through every airport that has outgoing flights, not just the hubs.
    for (const departureAirport of allDepartureAirports) {
        if (!legsByDeparture[departureAirport]) continue;

        // Generate up to 3 rosters for each location to avoid over-generation.
        const rosterCountPerAirport = 3; 
        for (let i = 0; i < rosterCountPerAirport; i++) {
            const rosterLegs = [];
            let currentAirport = departureAirport;
            let totalTime = 0;
            const usedFlightNumbers = new Set();
            const legCount = Math.floor(Math.random() * 3) + 2; // Create rosters with 2 to 4 legs

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
                // Generates a random multiplier between 1.10 and 1.50
                const randomMultiplier = parseFloat((1.1 + Math.random() * 0.4).toFixed(2));
                
                generatedRosters.push({
                    name: `${departureAirport} Sector Duty #${i + 1}`,
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
        await Roster.insertMany(generatedRosters);
        console.log(`Successfully generated and saved ${generatedRosters.length} new rosters.`);
    }
    return { created: generatedRosters.length, legsFound: allLegs.length };
};

// Rank Promotion Helper
const checkAndApplyRankUpdate = (pilot) => {
    const currentHours = pilot.flightHours;
    const currentRank = pilot.rank;
    let newRank = currentRank;
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

// Auth & Role Middlewares
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

// --- NEW: Airport Data Route for Map Feature ---
app.get('/api/airports', async (req, res) => {
    try {
        const filePath = path.join(__dirname, 'airports.json');
        const data = await fs.readFile(filePath, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        console.error('Error reading airports.json:', error);
        res.status(500).json({ message: 'Could not load airport data.' });
    }
});

// --- Community Content Routes ---
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


// --- User and Staff Routes ---
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

app.get('/api/me', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found.' });
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


// --- PIREP Workflow Routes ---
app.post('/api/pireps', authMiddleware, upload.single('verificationImage'), async (req, res) => {
    try {
        const { flightNumber, departure, arrival, aircraft, flightTime, remarks } = req.body;

        if (!req.file) {
            return res.status(400).json({ message: 'A verification image of the flight is required.' });
        }

        if (!flightNumber || !departure || !arrival || !aircraft || !flightTime) {
            return res.status(400).json({ message: 'Please fill out all required flight details.' });
        }
        
        const pilot = await User.findById(req.user._id);
        if (!pilot) return res.status(404).json({ message: 'Pilot not found.' });

        const newPirepData = {
            pilot: req.user._id, flightNumber, departure, arrival, aircraft, remarks,
            flightTime: parseFloat(flightTime),
            status: 'PENDING',
            verificationImageUrl: req.file.location, // Store the S3 image URL
            isMultiplierEligible: false // Default to false
        };

        if (pilot.dutyStatus === 'ON_DUTY') {
            if (!pilot.currentRoster) return res.status(400).json({ message: 'You are on duty but have no assigned roster. Please contact staff.' });
            
            await pilot.populate('currentRoster');
            const roster = pilot.currentRoster;
            
            const leg = roster.legs.find(l =>
                l.flightNumber.toUpperCase() === flightNumber.toUpperCase() &&
                l.departure.toUpperCase() === departure.toUpperCase() &&
                l.arrival.toUpperCase() === arrival.toUpperCase()
            );

            if (!leg) return res.status(400).json({ message: 'This flight does not match any leg in your assigned roster.' });

            
            // Rank enforcement on roster leg
            const requiredRank = getLegRequiredRank(leg);
            if (!canFlyLeg(pilot.rank, requiredRank)) {
                return res.status(403).json({
                    message: `This roster leg requires ${requiredRank}, which is above your rank (${pilot.rank}).`
                });
            }
const existingPirep = await Pirep.findOne({
                pilot: req.user._id,
                'rosterLeg.rosterId': roster._id,
                'rosterLeg.flightNumber': flightNumber
            });

            if (existingPirep) return res.status(400).json({ message: 'You have already filed a PIREP for this roster leg.' });
            
            newPirepData.rosterLeg = { rosterId: roster._id, flightNumber: flightNumber };
            
            const lastLegInRoster = roster.legs[roster.legs.length - 1];
            if (lastLegInRoster.flightNumber.toUpperCase() === flightNumber.toUpperCase()) {
                newPirepData.isMultiplierEligible = true;
                console.log(`PIREP for ${flightNumber} by ${pilot.email} is eligible for a multiplier.`);
            }
        } else {
            // Ad-hoc (off-roster) PIREP: enforce rank by aircraft
            const neededRank = deduceRankFromAircraft(aircraft);
            if (!canFlyLeg(pilot.rank, neededRank)) {
                return res.status(403).json({
                    message: `This aircraft/route requires ${neededRank}, which is above your rank (${pilot.rank}).`
                });
            }
            // Optionally record inferred rank for staff reference
            newPirepData.rankUnlock = neededRank;
            newPirepData.operator = newPirepData.operator || 'IndGo Air Virtual';
        }

        const newPirep = new Pirep(newPirepData);
        await newPirep.save();
        res.status(201).json({ message: 'Flight report submitted successfully and is pending review.', pirep: newPirep });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while filing flight report.' });
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

app.put('/api/pireps/:pirepId/approve', authMiddleware, isPirepManager, async (req, res) => {
    try {
        const pirep = await Pirep.findById(req.params.pirepId);
        if (!pirep) return res.status(404).json({ message: 'PIREP not found.' });
        if (pirep.status !== 'PENDING') return res.status(400).json({ message: `This PIREP has already been ${pirep.status.toLowerCase()}.` });

        if (pirep.verificationImageUrl) {
            deleteS3Object(pirep.verificationImageUrl);
        }

        const pilot = await User.findById(pirep.pilot);
        if (!pilot) return res.status(404).json({ message: 'Associated pilot profile not found.' });

        let hoursToAdd = pirep.flightTime;
        let multiplierApplied = 1;

        if (pirep.isMultiplierEligible && pirep.rosterLeg && pirep.rosterLeg.rosterId) {
            const roster = await Roster.findById(pirep.rosterLeg.rosterId);
            if (roster && roster.multiplier > 1) {
                hoursToAdd *= roster.multiplier;
                multiplierApplied = roster.multiplier;
                console.log(`Applied ${roster.multiplier}x multiplier to PIREP ${pirep._id}. Original: ${pirep.flightTime}, Awarded: ${hoursToAdd}`);
            }
        }

        pilot.flightHours += hoursToAdd;
        pilot.monthlyFlightHours += hoursToAdd;
        pilot.dailyFlightHours += hoursToAdd;
        pilot.lastKnownAirport = pirep.arrival; 

        const promotionResult = checkAndApplyRankUpdate(pilot);
        
        pirep.status = 'APPROVED';
        pirep.reviewedBy = req.user._id;
        pirep.reviewedAt = Date.now();
        pirep.verificationImageUrl = null; // Clear the URL from the database
        
        await pilot.save();
        await pirep.save();

        if (pilot.callsign) {
            updateGoogleSheet({
                callsign: pilot.callsign, name: pilot.name, rank: pilot.rank, flightHours: pilot.flightHours,
            });
        }
        
        let message = `PIREP approved. ${pilot.name} now has ${pilot.flightHours.toFixed(2)} hours.`;
        if (multiplierApplied > 1) {
            message += ` A ${multiplierApplied}x multiplier was applied!`;
        }

        const responsePayload = {
            message: message,
            promotionDetails: null
        };

        if (promotionResult.promoted) {
            const newRank = promotionResult.rank;
            responsePayload.message += ` Congratulations on the promotion to ${newRank}!`;
            responsePayload.promotionDetails = {
                newRank: newRank,
                flightHoursRequired: rankThresholds[newRank],
                perks: rankPerks[newRank] || []
            };
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
        pirep.verificationImageUrl = null; // Clear the URL
        await pirep.save();
        
        res.json({ message: 'PIREP has been successfully rejected.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while rejecting PIREP.' });
    }
});

app.put('/api/users/:userId/rank', authMiddleware, isPilotManager, async (req, res) => {
    try {
        const { userId } = req.params;
        const { newRank } = req.body;
        if (!newRank || !pilotRanks.includes(newRank)) return res.status(400).json({ message: 'Invalid rank specified.' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found.' });
        user.rank = newRank;
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


// --- NEW/ENHANCED: ROSTER & DUTY MANAGEMENT ROUTES ---

app.get('/api/rosters', authMiddleware, async (req, res) => {
    try {
        const { all } = req.query;
        // Define manager roles that can view all rosters
        const managerRoles = ['admin', 'Chief Executive Officer (CEO)', 'Chief Operating Officer (COO)', 'Route Manager (RM)'];
        const isManager = managerRoles.includes(req.user.role);

        // If a manager requests 'all', return everything
        if (all === 'true' && isManager) {
            const allRosters = await Roster.find({}).sort({ hub: 1, name: 1 }).lean();
            return res.json(allRosters);
        }

        // --- Existing logic for personalized pilot view ---
        const user = await User.findById(req.user._id).lean();
        if (!user) return res.status(404).json({ message: 'User not found.' });
        
        const departureIcao = user.lastKnownAirport || 'VIDP';

        const rosters = await Roster.find({
            isAvailable: true,
            'legs.0.departure': departureIcao 
        }).sort({ createdAt: -1 }).lean();

        // Rank filter: only include rosters whose legs are all at/below user's rank
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

        const searchLocations = new Set([fromDutyLocation, fromPirepLocation].filter(Boolean));
        if (searchLocations.size === 0) {
            searchLocations.add('VIDP'); // Default fallback if no location is known
        }

        const availableRosters = await Roster.find({
            isAvailable: true,
            'legs.0.departure': { $in: Array.from(searchLocations) }
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
        // Ensure each leg has operator and rankUnlock (defaults for primary IndGo rosters)
        const finishedLegs = legs.map(l => {
            const aircraft = l.aircraft || '';
            const operator = (l.operator && String(l.operator).trim()) || 'IndGo Air Virtual';
            const rankUnlock = (l.rankUnlock && String(l.rankUnlock).trim()) || deduceRankFromAircraft(aircraft);
            return { ...l, operator, rankUnlock };
        });
        const computedTFT = typeof totalFlightTime === 'number' && totalFlightTime > 0
            ? totalFlightTime
            : finishedLegs.reduce((s, L) => s + (Number(L.flightTime) || 0), 0);

        // Generates a random multiplier between 1.10 and 1.50 for manually created rosters
        const randomMultiplier = parseFloat((1.1 + Math.random() * 0.4).toFixed(2));
        const newRoster = new Roster({ 
            name, 
            hub, 
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

app.post('/api/duty/start', authMiddleware, async (req, res) => {
    const { rosterId } = req.body;
    try {
        const user = await User.findById(req.user._id);
        const roster = await Roster.findById(rosterId);

        if (!roster) return res.status(404).json({ message: 'Selected roster not found.' });
        if (user.dutyStatus === 'ON_DUTY') return res.status(400).json({ message: 'You are already on duty.' });

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

        
        // Rank enforcement: block roster if any leg requires a rank above the pilot's rank
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
        user.dailyFlightHours = 0;
        await user.save();
        
        res.json({ message: 'Duty day completed successfully! You are now on crew rest.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while ending duty.' });
    }
});

// --- Admin-Only Routes ---
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
        
        if (normalizedCallsign) {
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