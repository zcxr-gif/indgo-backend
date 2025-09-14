// server.js (Fully Merged, Updated & Performance Tuned with Leaderboards & IF Tracker)

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
const Papa = require('papaparse');
const axios = require('axios');
const fs = require('fs').promises;
const crypto = require('crypto');
require('dotenv').config();

// IMPORT FROM PROJECT MODULES
const { startFlightTracker } = require('./if-tracker');
const { finalizeFlightAndCreatePirep } = require('./flightUtils');
const { deduceRankFromAircraft } = require('./flightUtils'); // Replaces local version

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

// --- Models (Assuming they are defined in separate files as per best practice) ---
const User = require('./models/User');
const AdminLog = require('./models/AdminLog');
const Event = require('./models/Event');
const Highlight = require('./models/Highlight');
const FlightPlan = require('./models/FlightPlan');
const Pirep = require('./models/Pirep');
const Roster = require('./models/Roster');


// 6. HELPER FUNCTIONS & MIDDLEWARE

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
    // Using the imported helper function from flightUtils.js
    return deduceRankFromAircraft(leg?.aircraft);
};


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
    
    const generatedRosters = [];
    const rosterCountPerType = 2;

    console.log('--- Generating Single-Rank Rosters ---');
    const legsByRank = allLegs.reduce((acc, leg) => {
        const rank = leg.rankUnlock; 
        if (!acc[rank]) acc[rank] = [];
        acc[rank].push(leg);
        return acc;
    }, {});

    for (const rank in legsByRank) {
        if (!pilotRanks.includes(rank)) continue;

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
                const legCount = Math.floor(Math.random() * 3) + 2;

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
                        name: `${departureAirport} ${rank} Duty #${i + 1}`,
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
            const legCount = Math.floor(Math.random() * 3) + 2;

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
        generatedRosters.sort(() => Math.random() - 0.5); 
        await Roster.insertMany(generatedRosters);
        console.log(`Successfully generated and saved ${generatedRosters.length} new mixed and single-rank rosters.`);
    }
    return { created: generatedRosters.length, legsFound: allLegs.length };
};

const checkAndApplyRankUpdate = (pilot) => {
    const currentHours = pilot.flightHours;
    const currentRank = pilot.rank;
    let prospectiveRank = currentRank;

    for (let i = pilotRanks.length - 1; i >= 0; i--) {
        const rankName = pilotRanks[i];
        if (currentHours >= rankThresholds[rankName]) {
            prospectiveRank = rankName;
            break;
        }
    }

    if (prospectiveRank === currentRank) {
        return { promoted: false, pendingTest: false };
    }

    if (testGatedRanks.includes(prospectiveRank)) {
        if (pilot.promotionStatus === 'ACTIVE') {
            pilot.promotionStatus = 'PENDING_TEST';
            return { promoted: false, pendingTest: true, prospectiveRank: prospectiveRank };
        }
        return { promoted: false, pendingTest: false };

    } else {
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
        const filePath = path.join(__dirname, 'airports.json');
        const data = await fs.readFile(filePath, 'utf8');
        res.json(JSON.parse(data));
    } catch (error) {
        console.error('Error reading airports.json:', error);
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

app.get('/api/me', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('-password').populate('currentFlightPlan').lean();
        if (!user) return res.status(404).json({ message: 'User not found.' });

        user.timeUntilNextDutyMs = 0;
        if (user.dutyStatus === 'ON_REST' && user.lastDutyOff) {
            const restEndsAt = new Date(user.lastDutyOff).getTime() + MIN_REST_PERIOD;
            const now = Date.now();
            if (restEndsAt > now) {
                user.timeUntilNextDutyMs = restEndsAt - now;
            }
        }

        user.unreadNotifications = (user.notifications || []).filter(n => !n.read);
        res.json(user);
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error.' });
    }
});

app.put('/api/me', authMiddleware, upload.single('profilePicture'), async (req, res) => {
    try {
        const { name, bio, discord, ifc, youtube, preferredContact, infiniteFlightUsername } = req.body;
        const updatedData = { name, bio, discord, ifc, youtube, preferredContact, infiniteFlightUsername };

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

app.post('/api/me/notifications/read', authMiddleware, async (req, res) => {
    try {
        const { notificationIds } = req.body;
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

// --- FLIGHT PLANNING & PIREP AUTOMATION ROUTES ---

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
            rosterLeg: pilot.dutyStatus === 'ON_DUTY' ? rosterLegData : undefined
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
        if (!pilot.currentFlightPlan) return res.json(null);

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

        // Using the imported helper function from flightUtils.js
        const newPirep = await finalizeFlightAndCreatePirep(
            flightPlan,
            remarks,
            req.file.location
        );

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

app.put('/api/pireps/:pirepId/approve', authMiddleware, isPirepManager, async (req, res) => {
    try {
        const pirep = await Pirep.findById(req.params.pirepId);
        if (!pirep) return res.status(404).json({ message: 'PIREP not found.' });
        if (pirep.status !== 'PENDING') return res.status(400).json({ message: `This PIREP has already been ${pirep.status.toLowerCase()}.` });
        if (pirep.verificationImageUrl) { deleteS3Object(pirep.verificationImageUrl); }

        const pilot = await User.findById(pirep.pilot);
        if (!pilot) return res.status(404).json({ message: 'Associated pilot profile not found.' });

        let hoursToAdd = pirep.flightTime;
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

        if (pirep.rosterLeg && pirep.rosterLeg.rosterId) {
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
        if (multiplierApplied > 1) { message += ` A ${multiplierApplied}x multiplier was applied!`; }

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

app.put('/api/users/:userId/rank', authMiddleware, isPilotManager, async (req, res) => {
    try {
        const { userId } = req.params;
        const { newRank } = req.body;
        if (!newRank || !pilotRanks.includes(newRank)) return res.status(400).json({ message: 'Invalid rank specified.' });

        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found.' });

        const oldRank = user.rank;
        user.rank = newRank;

        if (user.promotionStatus === 'PENDING_TEST') {
            user.promotionStatus = 'ACTIVE';
            user.notifications.push({
                message: `Congratulations! You have passed your tests and have been promoted from ${oldRank} to ${newRank}. You are now cleared for normal flight operations.`
            });
        }

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
            return { 
                ...l, 
                operator, 
                rankUnlock,
                departure: normalizeICAO(l.departure),
                arrival: normalizeICAO(l.arrival)
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

        if (user.lastDutyOff && (Date.now() - new Date(user.lastDutyOff).getTime()) >= MIN_REST_PERIOD) {
            user.dailyFlightHours = 0;
            console.log(`Daily flight hours for ${user.email} reset due to starting a new duty period.`);
        }

        if (user.lastDutyOff && (Date.now() - new Date(user.lastDutyOff).getTime()) < MIN_REST_PERIOD) {
            const timeToRest = Math.ceil((MIN_REST_PERIOD - (Date.now() - new Date(user.lastDutyOff).getTime())) / (60 * 1000));
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
    
    // Initialize the Infinite Flight Tracker using the modularized code
    if (process.env.IF_API_KEY) {
        startFlightTracker();
    } else {
        console.warn("******************************************************************");
        console.warn("WARNING: IF_API_KEY is not defined in your .env file.");
        console.warn("The automated Infinite Flight tracker will not be started.");
        console.warn("******************************************************************");
    }
});