// server.js (Fully Merged & Updated)
// - Automated Roster Generation from a separate Google Sheet.
// - Strict Flight & Duty Time Limitations (FTPL) engine.
// - Location-aware roster availability for pilots.
// - Robust Google Sheets function with dynamic column mapping.
// - Advanced PIREP system with a staff review workflow.
// - Automatic rank promotions upon PIREP approval.
// - Cascade delete functionality for users and their associated data.
// - NEW: Codeshare route importer from a multi-sheet Google Sheet.
// - NEW: Personalized roster suggestions based on pilot's last duty/flight location.

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
const ROSTER_HUBS = ['VIDP', 'VABB', 'VOBL', 'VECC', 'VOMM']; // Primary hubs for roster generation

const pilotRanks = [
    'Cadet', 'Second Officer', 'First Officer',
    'Senior First Officer', 'Captain', 'Senior Captain'
];

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
    rank: { type: String, enum: pilotRanks, default: 'Cadet' },
    flightHours: { type: Number, default: 0 },
    bio: { type: String, default: '' },
    imageUrl: { type: String, default: '' },
    discord: { type: String, default: '' },
    ifc: { type: String, default: '' },
    youtube: { type: String, default: '' },
    preferredContact: { type: String, enum: ['none', 'discord', 'ifc', 'youtube'], default: 'none' },
    createdAt: { type: Date, default: Date.now },

    // --- ENHANCED FIELDS FOR SECTOR OPS & FTPL ---
    dutyStatus: { type: String, enum: ['ON_REST', 'ON_DUTY'], default: 'ON_REST' },
    currentRoster: { type: mongoose.Schema.Types.ObjectId, ref: 'Roster', default: null },
    lastDutyStart: { type: Date, default: null }, // Tracks when the current duty began
    lastDutyOff: { type: Date, default: null },   // Tracks when the last duty ended for rest calculation
    dailyFlightHours: { type: Number, default: 0 }, // Resets after a duty period
    monthlyFlightHours: { type: Number, default: 0 },
    lastHourReset: { type: Date, default: Date.now }, // For monthly reset
    lastKnownAirport: { type: String, uppercase: true, trim: true, default: 'VIDP' }, // Pilot's last arrival airport (from PIREP)
    lastDutyAirport: { type: String, uppercase: true, trim: true, default: null } // Where the last full duty roster ended
}, { toJSON: { virtuals: true }, toObject: { virtuals: true } }); // Ensure virtuals are included
UserSchema.index({ callsign: 1 }, { unique: true, sparse: true });
const User = mongoose.model('User', UserSchema);

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
    remarks: { type: String, trim: true },
    status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    rejectionReason: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    reviewedAt: { type: Date, default: null },
    rosterLeg: {
        rosterId: { type: mongoose.Schema.Types.ObjectId, ref: 'Roster' },
        flightNumber: { type: String }
    }
});
const Pirep = mongoose.model('Pirep', PirepSchema);

// --- Roster Schema (Enhanced for Automation) ---
const RosterSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    hub: { type: String, required: true, uppercase: true, trim: true },
    legs: [{
        flightNumber: { type: String, required: true, trim: true },
        departure: { type: String, required: true, uppercase: true, trim: true },
        arrival: { type: String, required: true, uppercase: true, trim: true },
        aircraft: { type: String, required: true, trim: true },
        // This field stores the flight time for EACH individual leg
        flightTime: { type: Number, required: true, min: 0.1 } 
    }],
    totalFlightTime: { type: Number, required: true, min: 0 },
    isAvailable: { type: Boolean, default: true },
    isGenerated: { type: Boolean, default: false }, // To distinguish auto-generated from manual
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdAt: { type: Date, default: Date.now }
});
const Roster = mongoose.model('Roster', RosterSchema);

// --- Codeshare Route Schema (for multi-sheet import) ---
const CodeshareRouteSchema = new mongoose.Schema({
    flightNumber: { type: String, required: true, trim: true },
    operator: { type: String, required: true, trim: true },
    rankUnlock: { type: String, required: true, trim: true },
    departureIcao: { type: String, required: true, uppercase: true, trim: true },
    arrivalIcao: { type: String, required: true, uppercase: true, trim: true },
    aircraft: { type: String, required: true, trim: true },
    flightTime: { type: Number, required: true, min: 0.1 },
    distance: { type: Number, required: true, min: 0 }
});
// Add indexes for faster querying by departure or arrival
CodeshareRouteSchema.index({ departureIcao: 1 });
CodeshareRouteSchema.index({ arrivalIcao: 1 });

const CodeshareRoute = mongoose.model('CodeshareRoute', CodeshareRouteSchema);


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

// --- AUTOMATED ROSTER GENERATION LOGIC (PULLS AIRCRAFT & FLIGHT TIME PER LEG) ---
const generateRostersFromGoogleSheet = async () => {
    console.log('Starting automated roster generation...');
    const routesSheetURL = process.env.ROUTES_SHEET_URL;
    if (!routesSheetURL) {
        console.error('ROUTES_SHEET_URL is not defined in .env file. Aborting roster generation.');
        throw new Error('Server configuration missing for roster generation.');
    }

    const convertTimeToDecimal = (timeStr) => {
        if (!timeStr || typeof timeStr !== 'string') return NaN;
        let totalHours = 0;
        const hourMatch = timeStr.match(/(\d+)\s*h/);
        const minMatch = timeStr.match(/(\d+)\s*m/);
        if (hourMatch) totalHours += parseInt(hourMatch[1], 10);
        if (minMatch) totalHours += parseInt(minMatch[1], 10) / 60;
        return totalHours;
    };

    const extractIcao = (text) => {
        if (!text) return null;
        const match = text.match(/^\s*([A-Z]{4})/);
        return match ? match[1] : null;
    };

    try {
        const response = await axios.get(routesSheetURL);
        const parsed = Papa.parse(response.data, { header: false });
        const allRows = parsed.data;

        const requiredHeaders = ['Callsign', 'Origin', 'Destination', 'Flight Time', 'Aircraft'];
        let columnMap = {};
        let headerRowFound = false;

        for (const row of allRows) {
            if (requiredHeaders.every(h => row.some(cell => cell.trim() === h))) {
                row.forEach((header, index) => {
                    if (requiredHeaders.includes(header.trim())) {
                        columnMap[header.trim()] = index;
                    }
                });
                headerRowFound = true;
                break;
            }
        }

        if (!headerRowFound) {
            throw new Error('Could not find a valid header row containing Callsign, Aircraft, etc. in the Google Sheet.');
        }

        const allLegs = allRows
            .map(row => {
                // This function gets the flight time for the current row (leg)
                const flightTimeDecimal = convertTimeToDecimal(row[columnMap['Flight Time']]);
                
                // The complete leg object, including its specific aircraft and flight time
                const leg = {
                    flightNumber: row[columnMap['Callsign']]?.trim(),
                    departure: extractIcao(row[columnMap['Origin']]),
                    arrival: extractIcao(row[columnMap['Destination']]),
                    aircraft: row[columnMap['Aircraft']]?.trim(),
                    flightTime: flightTimeDecimal 
                };
                return leg;
            })
            // Filter out any rows that are missing critical data
            .filter(leg => leg.flightNumber && leg.departure && leg.arrival && leg.aircraft && !isNaN(leg.flightTime) && leg.flightTime > 0);


        if (allLegs.length === 0) {
            console.warn('No valid legs found in the Google Sheet after filtering.');
            return { created: 0, legsFound: 0 };
        }

        const legsByDeparture = allLegs.reduce((acc, leg) => {
            if (!acc[leg.departure]) acc[leg.departure] = [];
            acc[leg.departure].push(leg);
            return acc;
        }, {});

        const generatedRosters = [];
        for (const hub of ROSTER_HUBS) {
            if (!legsByDeparture[hub]) continue;

            for (let i = 0; i < 5; i++) { 
                const rosterLegs = [];
                let currentAirport = hub;
                let totalTime = 0;
                const usedFlightNumbers = new Set();
                const legCount = Math.floor(Math.random() * 3) + 2;

                for (let j = 0; j < legCount; j++) {
                    const possibleNextLegs = (legsByDeparture[currentAirport] || []).filter(
                        l => !usedFlightNumbers.has(l.flightNumber)
                    );
                    if (possibleNextLegs.length === 0) break;

                    const nextLeg = possibleNextLegs[Math.floor(Math.random() * possibleNextLegs.length)];
                    if ((totalTime + nextLeg.flightTime) > MAX_DAILY_FLIGHT_HOURS) break;

                    // The 'nextLeg' object contains the individual flight time and is added to the roster
                    rosterLegs.push(nextLeg);
                    totalTime += nextLeg.flightTime;
                    currentAirport = nextLeg.arrival;
                    usedFlightNumbers.add(nextLeg.flightNumber);
                }

                if (rosterLegs.length >= 2) {
                    generatedRosters.push({
                        name: `${hub} Sector Duty #${i + 1}`,
                        hub,
                        legs: rosterLegs, // This array now contains legs with all their details
                        totalFlightTime: totalTime,
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
    } catch (error) {
        console.error('Failed to generate rosters from Google Sheet:', error);
        throw new Error('Error during automated roster generation.');
    }
};

// --- AUTOMATED CODESHARE ROUTE IMPORT LOGIC (MULTI-SHEET) ---
const importCodeshareRoutesFromSheet = async () => {
    console.log('Starting codeshare route import...');
    const spreadsheetId = process.env.CODESHARE_SHEET_ID;
    if (!spreadsheetId) {
        console.error('CODESHARE_SHEET_ID is not defined in .env file. Aborting import.');
        throw new Error('Server configuration missing for codeshare route import.');
    }

    // Helper to convert time strings like "1h 30m" to a decimal (e.g., 1.5)
    const convertTimeToDecimal = (timeStr) => {
        if (!timeStr || typeof timeStr !== 'string') return NaN;
        let totalHours = 0;
        const hourMatch = timeStr.match(/(\d+)\s*h/);
        const minMatch = timeStr.match(/(\d+)\s*m/);
        if (hourMatch) totalHours += parseInt(hourMatch[1], 10);
        if (minMatch) totalHours += parseInt(minMatch[1], 10) / 60;
        return totalHours;
    };

    // Helper to extract a 4-letter ICAO code
    const extractIcao = (text) => {
        if (!text) return null;
        const match = text.match(/^\s*([A-Z]{4})/);
        return match ? match[1] : null;
    };

    try {
        const auth = new google.auth.GoogleAuth({
            keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
            scopes: 'https://www.googleapis.com/auth/spreadsheets.readonly',
        });
        const sheets = google.sheets({ version: 'v4', auth });

        // 1. Get metadata to find all sheet (tab) names
        const metaData = await sheets.spreadsheets.get({ spreadsheetId });
        const sheetNames = metaData.data.sheets.map(sheet => sheet.properties.title);
        console.log(`Found sheets: ${sheetNames.join(', ')}`);

        const allRoutes = [];
        const requiredHeaders = [
            'Flight No.', 'Operator', 'Rank Unlock', 'Departure ICAO',
            'Arrival ICAO', 'Aircraft(s)', 'Avg. Flight Time', 'Route Distance (nm)'
        ];

        // 2. Loop through each sheet
        for (const sheetName of sheetNames) {
            console.log(`Processing sheet: "${sheetName}"...`);
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId,
                range: sheetName, // Process the entire sheet
            });

            const rows = response.data.values;
            if (!rows || rows.length === 0) {
                console.log(`Sheet "${sheetName}" is empty. Skipping.`);
                continue;
            }

            // 3. Find the header row and map columns dynamically
            let headerRowIndex = -1;
            const columnMap = {};
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const foundHeaders = new Set();
                row.forEach((cell, index) => {
                    const trimmedCell = cell.trim();
                    if (requiredHeaders.includes(trimmedCell)) {
                        columnMap[trimmedCell] = index;
                        foundHeaders.add(trimmedCell);
                    }
                });
                if (foundHeaders.size === requiredHeaders.length) {
                    headerRowIndex = i;
                    console.log(`Header row found at index ${i} in sheet "${sheetName}".`);
                    break;
                }
            }
            
            if (headerRowIndex === -1) {
                console.warn(`Could not find a valid header row in sheet "${sheetName}". Skipping.`);
                continue;
            }

            // 4. Process all rows after the header row
            for (let i = headerRowIndex + 1; i < rows.length; i++) {
                const row = rows[i];
                const departureIcao = extractIcao(row[columnMap['Departure ICAO']]);
                const arrivalIcao = extractIcao(row[columnMap['Arrival ICAO']]);
                const flightTime = convertTimeToDecimal(row[columnMap['Avg. Flight Time']]);
                const distance = parseFloat(String(row[columnMap['Route Distance (nm)']]).replace(/,/g, ''));

                // Basic validation to skip empty/invalid rows
                if (!departureIcao || !arrivalIcao || isNaN(flightTime) || isNaN(distance)) {
                    continue;
                }

                allRoutes.push({
                    flightNumber: row[columnMap['Flight No.']]?.trim(),
                    operator: row[columnMap['Operator']]?.trim(),
                    rankUnlock: row[columnMap['Rank Unlock']]?.trim(),
                    departureIcao: departureIcao,
                    arrivalIcao: arrivalIcao,
                    aircraft: row[columnMap['Aircraft(s)']]?.trim(),
                    flightTime: flightTime,
                    distance: distance
                });
            }
        }

        // 5. Update the database
        if (allRoutes.length > 0) {
            console.log(`Found a total of ${allRoutes.length} valid codeshare routes. Updating database...`);
            // Clear the existing collection and insert the fresh data
            await CodeshareRoute.deleteMany({});
            await CodeshareRoute.insertMany(allRoutes);
            console.log('Successfully updated the codeshare routes in the database.');
        } else {
            console.log('No valid codeshare routes were found to import.');
        }

        return { imported: allRoutes.length, sheetsProcessed: sheetNames.length };

    } catch (error) {
        console.error('Failed to import codeshare routes from Google Sheet:', error);
        throw new Error('Error during automated codeshare route import.');
    }
};

// Rank Promotion Helper
const rankThresholds = {
    'Cadet': 0, 'Second Officer': 10, 'First Officer': 50,
    'Senior First Officer': 150, 'Captain': 400, 'Senior Captain': 1000
};
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
        res.status(500).json({ message: 'Server error while creating event.' });
    }
});

app.get('/api/events', async (req, res) => {
    try {
        const events = await Event.find().sort({ date: -1 });
        res.json(events);
    } catch (error) {
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
        res.status(500).json({ message: 'Server error while creating highlight.' });
    }
});

app.get('/api/highlights', async (req, res) => {
    try {
        const highlights = await Highlight.find().sort({ createdAt: -1 });
        res.json(highlights);
    } catch (error) {
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
        res.status(500).json({ message: 'Server error while deleting highlight.' });
    }
});


// --- User and Staff Routes ---
app.get('/api/staff', async (req, res) => {
    try {
        const staffRoles = User.schema.path('role').enumValues.filter(r => r !== 'pilot');
        const staffMembers = await User.find({ role: { $in: staffRoles } }).select('-password').sort({ createdAt: -1 });
        res.json(staffMembers);
    } catch (error) {
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
        res.status(500).json({ message: 'Server error during login.' });
    }
});

app.get('/api/me', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('-password');
        if (!user) return res.status(404).json({ message: 'User not found.' });
        res.json(user);
    } catch (err) {
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
        res.status(500).json({ message: 'Server error while updating password.' });
    }
});


// --- PIREP Workflow Routes ---
app.post('/api/pireps', authMiddleware, async (req, res) => {
    try {
        const { flightNumber, departure, arrival, aircraft, flightTime, remarks } = req.body;
        if (!flightNumber || !departure || !arrival || !aircraft || !flightTime) {
            return res.status(400).json({ message: 'Please fill out all required flight details.' });
        }
        
        const pilot = await User.findById(req.user._id);
        if (!pilot) return res.status(404).json({ message: 'Pilot not found.' });

        const newPirepData = {
            pilot: req.user._id, flightNumber, departure, arrival, aircraft, remarks,
            flightTime: parseFloat(flightTime),
            status: 'PENDING'
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

            const existingPirep = await Pirep.findOne({
                pilot: req.user._id,
                'rosterLeg.rosterId': roster._id,
                'rosterLeg.flightNumber': flightNumber
            });

            if (existingPirep) return res.status(400).json({ message: 'You have already filed a PIREP for this roster leg.' });
            
            newPirepData.rosterLeg = { rosterId: roster._id, flightNumber: flightNumber };
        }

        const newPirep = new Pirep(newPirepData);
        await newPirep.save();
        res.status(201).json({ message: 'Flight report submitted successfully and is pending review.', pirep: newPirep });
    } catch (error) {
        res.status(500).json({ message: 'Server error while filing flight report.' });
    }
});

app.get('/api/me/pireps', authMiddleware, async (req, res) => {
    try {
        const pireps = await Pirep.find({ pilot: req.user._id }).sort({ createdAt: -1 });
        res.json(pireps);
    } catch (error) {
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
        res.status(500).json({ message: 'Server error while fetching pending PIREPs.' });
    }
});

app.put('/api/pireps/:pirepId/approve', authMiddleware, isPirepManager, async (req, res) => {
    try {
        const pirep = await Pirep.findById(req.params.pirepId);
        if (!pirep) return res.status(404).json({ message: 'PIREP not found.' });
        if (pirep.status !== 'PENDING') return res.status(400).json({ message: `This PIREP has already been ${pirep.status.toLowerCase()}.` });

        const pilot = await User.findById(pirep.pilot);
        if (!pilot) return res.status(404).json({ message: 'Associated pilot profile not found.' });

        // **MERGED**: Update all flight hour counters and pilot location
        pilot.flightHours += pirep.flightTime;
        pilot.monthlyFlightHours += pirep.flightTime;
        pilot.dailyFlightHours += pirep.flightTime;
        pilot.lastKnownAirport = pirep.arrival; // Update pilot's location

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
        res.status(500).json({ message: 'Server error while approving PIREP.' });
    }
});

app.put('/api/pireps/:pirepId/reject', authMiddleware, isPirepManager, async (req, res) => {
    try {
        const { reason } = req.body;
        if (!reason) return res.status(400).json({ message: 'A reason for rejection is required.' });

        const pirep = await Pirep.findByIdAndUpdate(req.params.pirepId, {
            status: 'REJECTED', rejectionReason: reason, reviewedBy: req.user._id, reviewedAt: Date.now()
        }, { new: false });

        if (!pirep) return res.status(404).json({ message: 'PIREP not found.' });
        if (pirep.status !== 'PENDING') return res.status(400).json({ message: `This PIREP was already ${pirep.status.toLowerCase()}.` });
        
        res.json({ message: 'PIREP has been successfully rejected.' });
    } catch (error) {
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
             await updateGoogleSheet({ callsign: user.callsign, name: user.name, rank: user.rank, flightHours: user.flightHours });
        }
        res.json({ message: `Successfully updated ${user.name}'s rank to ${newRank}.` });
    } catch (error) {
        res.status(500).json({ message: 'Server error while updating rank.' });
    }
});


// --- NEW/ENHANCED: ROSTER & DUTY MANAGEMENT ROUTES ---

// General endpoint for browsing rosters, now less critical for individual pilots
app.get('/api/rosters', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ message: 'User not found.' });
        
        const departureIcao = user.lastKnownAirport || ROSTER_HUBS[0];

        const rosters = await Roster.find({
            isAvailable: true,
            'legs.0.departure': departureIcao 
        }).sort({ createdAt: -1 });

        res.json(rosters);
    } catch (error) {
        res.status(500).json({ message: 'Server error while fetching available rosters.' });
    }
});

// NEW: Personalized endpoint for individual pilots
app.get('/api/rosters/my-rosters', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ message: 'User not found.' });

        const fromDutyLocation = user.lastDutyAirport;
        const fromPirepLocation = user.lastKnownAirport;

        // Use a Set to avoid duplicate locations if they are the same
        const searchLocations = new Set([fromDutyLocation, fromPirepLocation].filter(Boolean));

        if (searchLocations.size === 0) {
            // Fallback to a default hub if user has no location data
            searchLocations.add(ROSTER_HUBS[0]);
        }

        const availableRosters = await Roster.find({
            isAvailable: true,
            'legs.0.departure': { $in: Array.from(searchLocations) }
        }).sort({ createdAt: -1 });

        res.json({
            rosters: availableRosters,
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
        if (!name || !hub || !legs || legs.length === 0 || !totalFlightTime) {
            return res.status(400).json({ message: 'All roster fields are required.' });
        }
        const newRoster = new Roster({ name, hub, legs, totalFlightTime, createdBy: req.user._id });
        await newRoster.save();

        const log = new AdminLog({ adminUser: req.user._id, action: 'ROSTER_CREATE', details: `Created new roster: "${name}"` });
        await log.save();
        
        res.status(201).json(newRoster);
    } catch (error) {
        res.status(500).json({ message: 'Server error while creating roster.' });
    }
});

app.post('/api/rosters/generate', authMiddleware, isRouteManager, async (req, res) => {
    try {
        const result = await generateRostersFromGoogleSheet();
        res.status(201).json({
            message: `Roster generation complete. Found ${result.legsFound} legs and created ${result.created} new rosters.`
        });
    } catch (error) {
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

        // --- FTPL CHECKS ---
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

        user.dutyStatus = 'ON_DUTY';
        user.currentRoster = roster._id;
        user.lastDutyStart = Date.now();
        await user.save();
        
        res.json({ message: `You are now on duty for roster "${roster.name}".`, roster });
    } catch (error) {
        res.status(500).json({ message: 'Server error while starting duty.' });
    }
});

app.post('/api/duty/end', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).populate('currentRoster');
        if (user.dutyStatus !== 'ON_DUTY') return res.status(400).json({ message: 'You are not currently on duty.' });
        if (!user.currentRoster) return res.status(400).json({ message: 'No roster assigned to end duty.' });

        const roster = user.currentRoster;
        const filedPireps = await Pirep.find({
            pilot: user._id,
            'rosterLeg.rosterId': roster._id,
            status: { $in: ['APPROVED', 'PENDING'] }
        });

        if (filedPireps.length < roster.legs.length) {
            return res.status(400).json({ message: `You must file PIREPs for all roster legs. ${filedPireps.length}/${roster.legs.length} complete.` });
        }
        
        // --- UPDATED LOGIC ---
        // Find the final leg of the roster to set the last duty airport
        const finalLeg = roster.legs[roster.legs.length - 1];
        if (finalLeg) {
            user.lastDutyAirport = finalLeg.arrival;
        }
        // --- END UPDATED LOGIC ---

        user.dutyStatus = 'ON_REST';
        user.currentRoster = null;
        user.lastDutyOff = Date.now();
        user.lastDutyStart = null;
        user.dailyFlightHours = 0; // Reset daily flight hours
        await user.save();
        
        res.json({ message: 'Duty day completed successfully! You are now on crew rest.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error while ending duty.' });
    }
});


// --- CODESHARE ROUTE MANAGEMENT ---

app.post('/api/codeshare/import', authMiddleware, isRouteManager, async (req, res) => {
    try {
        const result = await importCodeshareRoutesFromSheet();
        res.status(200).json({
            message: `Codeshare import complete. Processed ${result.sheetsProcessed} sheets and imported ${result.imported} routes.`
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error during codeshare import.', error: error.message });
    }
});

app.get('/api/codeshare-routes', authMiddleware, async (req, res) => {
    try {
        // You can add query-based filtering here later, e.g., ?departure=VIDP
        const routes = await CodeshareRoute.find({}).sort({ operator: 1, flightNumber: 1 });
        res.json(routes);
    } catch (error) {
        res.status(500).json({ message: 'Server error while fetching codeshare routes.' });
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
            await updateGoogleSheet({ callsign: normalizedCallsign, name: user.name, rank: user.rank, flightHours: user.flightHours || 0 });
        }
        
        const userResponse = user.toObject();
        delete userResponse.password;
        return res.status(201).json(userResponse);

    } catch (error) {
        if (error?.code === 11000) {
            return res.status(400).json({ message: `A user with this ${Object.keys(error.keyValue)[0]} already exists.` });
        }
        return res.status(500).json({ message: 'Server error while creating user.' });
    }
});

app.get('/api/users', authMiddleware, isAdmin, async (req, res) => {
    try {
        const users = await User.find().select('-password');
        res.json(users);
    } catch (error) {
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

        await updateGoogleSheet({ callsign, name: user.name, rank: user.rank, flightHours: user.flightHours || 0 });
        res.json({ message: `Callsign ${callsign} assigned to ${user.email}` });
    } catch (error) {
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

        if (userToDelete.callsign) await deleteRowFromGoogleSheet(userToDelete.callsign);
        if (userToDelete.imageUrl) await deleteS3Object(userToDelete.imageUrl);

        await Pirep.deleteMany({ pilot: userId });

        const userEvents = await Event.find({ author: userId });
        for (const event of userEvents) {
            if (event.imageUrl) await deleteS3Object(event.imageUrl);
        }
        await Event.deleteMany({ author: userId });

        const userHighlights = await Highlight.find({ author: userId });
        for (const highlight of userHighlights) {
            if (highlight.imageUrl) await deleteS3Object(highlight.imageUrl);
        }
        await Highlight.deleteMany({ author: userId });

        await User.findByIdAndDelete(userId);

        const log = new AdminLog({
            adminUser: req.user._id,
            action: 'USER_DELETE',
            details: `Deleted user with email ${userToDelete.email} and all associated data.`
        });
        await log.save();

        res.json({ message: 'User and all associated data deleted successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error while deleting user.' });
    }
});

app.get('/api/logs', authMiddleware, isAdmin, async (req, res) => {
    try {
        const logs = await AdminLog.find()
            .populate('adminUser', 'name email')
            .populate('targetUser', 'name email')
            .sort({ timestamp: -1 });
        res.json(logs);
    } catch (error) {
        res.status(500).json({ message: 'Server error while fetching logs.' });
    }
});

// 8. START THE SERVER
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});