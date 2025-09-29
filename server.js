// server.js (Fully Merged, Updated & Performance Tuned with Rosters in DynamoDB, ACARS-lite tracking, and Aircraft Manager)
// - Roster system fully migrated to DynamoDB for scalability.
// - Automated Roster Generation now reads exclusively from the DynamoDB Routes table.
// - Strict Flight & Duty Time Limitations (FTPL) engine.
// - Staff-controlled switch to disable FTPL for individual users.
// - Location-aware roster availability for pilots.
// - Robust Google Sheets function for route *importing* with dynamic column mapping.
// - Advanced PIREP system with a staff review workflow.
// - Automatic rank promotions upon PIREP approval.
// - Cascade delete functionality for users and their associated data.
// - Personalized roster suggestions based on pilot's last duty/flight location.
// - Roster multipliers for bonus flight hours on final legs.
// - Image verification required for all PIREP submissions.
// - Map feature support via airports data endpoint.
// - Weekly and Monthly pilot leaderboards for hours and sectors.
// - Test & Practical based promotion system for specific ranks.
// - Flight Planning system with FIC/ADC codes and automated PIREP generation.
// - Invite-based registration system for new pilots.
// - Daily flight hour counter now resets intelligentlyhen starting a new duty.
// - Endpoint for user profile now includes time remaining on crew rest and notifications.
// - Off-roster (non-duty) PIREPs no longer affect FTPL counters.
// - Roster generation now creates a mix of single-rank and mixed-rank duties.
// - PIREP filing is now automated via the flight plan completion process.
// - PIREP approval now allows staff to correct the flight time.
// - Airport country codes are now automatically resolved and stored in rosters.
// - Flight Plans are now properly deleted after PIREP review (both approved and rejected).
// - ACARS-lite flight tracking system integrated via live_flights service.
// - NEW: Automatic PIREP filing on landing detection via ACARS.
// - Codeshare partner management system with logo uploads (S3 + DynamoDB).
// - Routes now require both 'operator' and 'livery' fields upon creation.
// - NEW: Aircraft management system with image uploads and rank unlocks (MongoDB + S3).
// - NEW: Enhanced /api/routes GET endpoint with server-side filtering.

// 1. IMPORT DEPENDENCIES
const cors = require('cors');
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const passport = require('passport');
const { Strategy: DiscordStrategy } = require('passport-discord');
const multer = require('multer');
const path = require('path');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand, ScanCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

const multerS3 = require('multer-s3');
const { google } = require('googleapis');
const Papa = require('papaparse');
const axios = require('axios');
const fs = require('fs').promises;
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
require('dotenv').config();

// 2. INITIALIZE EXPRESS APP & AWS CLIENTS
const app = express();
const PORT = process.env.PORT || 5000;
let airportsData = {};

// Configure the AWS S3 client
const s3Client = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

// Configure DynamoDB
const ddb = new DynamoDBClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});
const ddbDoc = DynamoDBDocumentClient.from(ddb, { marshallOptions: { removeUndefinedValues: true } });
const ROUTES_TABLE = process.env.DDB_ROUTES_TABLE || 'Routes';
const ROSTERS_TABLE = process.env.DDB_ROSTERS_TABLE || 'Rosters';
const CODESHARE_TABLE = process.env.DDB_CODESHARE_TABLE || 'CodesharePartners';


// 3. MIDDLEWARE
const corsOptions = {
    origin: 'https://indgo-va.netlify.app',
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Initialize Passport for OAuth linking
app.use(passport.initialize());

// --- Connected Accounts Linking: helpers & Discord strategy ---
function makeLinkState(userId, provider) {
  return jwt.sign({ uid: userId, provider, typ: 'link' }, process.env.JWT_SECRET, { expiresIn: '10m' });
}
function verifyLinkState(token) {
  return jwt.verify(token, process.env.JWT_SECRET);
}

const ENABLE_DISCORD = !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET && process.env.OAUTH_BASE_URL);

if (ENABLE_DISCORD) {
  passport.use('discord-link', new DiscordStrategy(
    {
      clientID: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      callbackURL: `${process.env.OAUTH_BASE_URL}/api/auth/discord/callback`,
      scope: ['identify'],
      passReqToCallback: true
    },
    async (req, accessToken, refreshToken, profile, done) => {
      try { return done(null, { profile }); } catch (err) { return done(err); }
    }
  ));
}

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

// Multer configuration specifically for codeshare logos
const uploadCodeshareLogo = multer({
    storage: multerS3({
        s3: s3Client,
        bucket: process.env.AWS_S3_BUCKET_NAME,
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: function (req, file, cb) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const fileName = `logo-${uniqueSuffix}${path.extname(file.originalname)}`;
            cb(null, `codeshares/${fileName}`);
        }
    })
});

// Multer configuration for aircraft images
const uploadAircraftImage = multer({
    storage: multerS3({
        s3: s3Client,
        bucket: process.env.AWS_S3_BUCKET_NAME,
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: function (req, file, cb) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const fileName = `aircraft-${uniqueSuffix}${path.extname(file.originalname)}`;
            cb(null, `aircraft/${fileName}`);
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


// 5. DEFINE SCHEMAS AND MODELS (MongoDB)

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
    infiniteFlightUsername: { type: String, default: '', trim: true },
    ifc: { type: String, default: '' },
    youtube: { type: String, default: '' },
    preferredContact: { type: String, enum: ['none', 'discord', 'ifc', 'youtube'], default: 'none' },

    // Connected accounts (OAuth or manual)
    connectedAccounts: [{
        provider: { type: String, enum: ['discord','google','youtube','ifc','vatsim','ivao','infiniteflight'], required: true },
        externalId: { type: String, default: '' },
        username: { type: String, default: '' },
        url: { type: String, default: '' },
        verified: { type: Boolean, default: true },
        linkedAt: { type: Date, default: Date.now },
        meta: { type: mongoose.Schema.Types.Mixed }
    }],
    createdAt: { type: Date, default: Date.now },
    // FTPL Fields
    dutyStatus: { type: String, enum: ['ON_REST', 'ON_DUTY'], default: 'ON_REST' },
    // MODIFIED: currentRoster is now a string ID for DynamoDB, not a Mongoose ref
    currentRoster: { type: String, default: null },
    lastDutyStart: { type: Date, default: null },
    lastDutyOff: { type: Date, default: null },
    dailyFlightHours: { type: Number, default: 0 },
    monthlyFlightHours: { type: Number, default: 0 }, // For FTPL (rolling 30 days)
    lastHourReset: { type: Date, default: Date.now },
    isFtplExempt: { type: Boolean, default: false },
    lastKnownAirport: { type: String, uppercase: true, trim: true, default: 'VIDP' },
    lastDutyAirport: { type: String, uppercase: true, trim: true, default: null },
    // Leaderboard Fields
    weeklyFlightHours: { type: Number, default: 0 },
    leaderboardMonthlyFlightHours: { type: Number, default: 0 }, // By calendar month
    weeklySectors: { type: Number, default: 0 },
    monthlySectors: { type: Number, default: 0 },
    lastWeeklyReset: { type: Date, default: Date.now },
    lastMonthlyReset: { type: Date, default: Date.now },
    // Promotion Fields
    promotionStatus: {
        type: String,
        enum: ['ACTIVE', 'PENDING_TEST'],
        default: 'ACTIVE'
    },
    // Active flight plans
    currentFlightPlans: [{ type: mongoose.Schema.Types.ObjectId, ref: 'FlightPlan' }],
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
        await mongoose.model('FlightPlan').deleteMany({ pilot: user._id });
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

// --- Invite Schema ---
const InviteSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, },
    expiresAt: { type: Date, required: true, },
    status: { type: String, enum: ['PENDING', 'ACCEPTED', 'EXPIRED'], default: 'PENDING', },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, },
    usedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, },
}, { timestamps: true });
const Invite = mongoose.model('Invite', InviteSchema);

InviteSchema.index(
    { "updatedAt": 1 },
    {
        expireAfterSeconds: 86400, // 24 hours
        partialFilterExpression: { status: 'ACCEPTED' }
    }
);


// --- Admin Log Schema ---
const AdminLogSchema = new mongoose.Schema({
    adminUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    action: { type: String, required: true, enum: ['ROLE_UPDATE', 'USER_DELETE', 'ROSTER_CREATE', 'ROSTER_DELETE', 'PROMOTION_TEST_REQUIRED', 'FTPL_STATUS_UPDATE'] },
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

// --- Flight Plan Schema ---
const FlightPlanSchema = new mongoose.Schema({
    pilot: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    flightNumber: { type: String, required: true, trim: true },
    departure: { type: String, required: true, uppercase: true, trim: true },
    arrival: { type: String, required: true, uppercase: true, trim: true },
    aircraft: { type: String, required: true },
    etd: { type: Date, required: true },
    eet: { type: Number, required: true },
    eta: { type: Date, required: true },
    alternate: { type: String, required: true, uppercase: true, trim: true },
    pob: { type: Number, required: true },
    route: { type: String, required: true },
    ficNumber: { type: String, required: true, unique: true },
    adcNumber: { type: String, required: true, unique: true },
    squawkCode: { type: String },
    status: {
        type: String,
        enum: ['PLANNED', 'FLYING', 'COMPLETED', 'CANCELLED'],
        default: 'PLANNED'
    },
    zfw: { type: Number },
    tow: { type: Number },
    cargo: { type: Number },
    fuelTaxi: { type: Number },
    fuelTrip: { type: Number },
    fuelTotal: { type: Number },
    v1: { type: String },
    vr: { type: String },
    v2: { type: String },
    vref: { type: String },
    departureWeather: { type: String },
    arrivalWeather: { type: String },
    // START: UPDATED FIELDS
    tlr: { type: mongoose.Schema.Types.Mixed }, // For the full Takeoff/Landing Report object
    cruiseAltitude: { type: Number },
    cruiseSpeed: { type: Number }, // Storing as a number (e.g., 0.78 for Mach)
    // END: UPDATED FIELDS
    mapData: { type: mongoose.Schema.Types.Mixed },
    rosterLeg: {
        // MODIFIED: rosterId is now a string pointing to a DynamoDB item
        rosterId: { type: String },
        flightNumber: { type: String }
    },
    actualDepartureTime: { type: Date },
    actualArrivalTime: { type: Date },
}, { timestamps: true });
FlightPlanSchema.index({ pilot: 1, status: 1 });
const FlightPlan = mongoose.model('FlightPlan', FlightPlanSchema);


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
        // MODIFIED: rosterId is now a string pointing to a DynamoDB item
        rosterId: { type: String },
        flightNumber: { type: String }
    },
    source: {
        type: String,
        enum: ['MANUAL', 'ACARS'],
        default: 'MANUAL'
    },
    sourceFlightPlanId: { type: mongoose.Schema.Types.ObjectId, ref: 'FlightPlan' }
});
const Pirep = mongoose.model('Pirep', PirepSchema);
PirepSchema.index({ pilot: 1 });
PirepSchema.index({ status: 1 });
PirepSchema.index({ 'rosterLeg.rosterId': 1, 'rosterLeg.flightNumber': 1 });

// --- REMOVED: RosterSchema and Roster model are deleted. Rosters are now in DynamoDB. ---

// --- Aircraft Schema ---
const AircraftSchema = new mongoose.Schema({
    name:       { type: String, required: true, trim: true },
    icao:       { type: String, required: true, trim: true, uppercase: true },
    type:       { type: String, required: true, trim: true }, // e.g., narrowbody, widebody, turboprop
    rankUnlock: { type: String, required: true, enum: pilotRanks }, // Uses the existing pilotRanks constant
    codeshare:  { type: String, required: true, trim: true }, // operator name (must match route.operator)
    imageUrl:   { type: String, default: null },             // external link
    s3ImageUrl: { type: String, default: null },             // S3 link for uploaded files
    createdAt:  { type: Date, default: Date.now }
}, { timestamps: true });

AircraftSchema.index({ icao: 1, codeshare: 1 });
const Aircraft = mongoose.model('Aircraft', AircraftSchema);


// 6. HELPER FUNCTIONS & MIDDLEWARE

const getCountryCode = (icao) => airportsData[icao]?.country || null;

const generateFicNumber = () => `FIC/${new Date().getFullYear()}/${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
const generateAdcNumber = () => `ADC/${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
const generateSquawkCode = () => {
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += Math.floor(Math.random() * 8); // Generates digits 0-7
    }
    return code;
};

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
    if (!s) return 'IndGo Cadet'; // Return a default valid rank
    const has = (pat) => new RegExp(pat, 'i').test(s);
    if (has('(DH8D|Q400|A320|B738)')) return 'IndGo Cadet';
    if (has('(A321|B737|B739)')) return 'Skyline Observer';
    if (has('(A330|B38M)')) return 'Route Explorer';
    if (has('(787-8|777-200LR)')) return 'Skyline Officer';
    if (has('(787-9|777-300ER)')) return 'Command Captain';
    if (has('A350')) return 'Elite Captain';
    if (has('(A380|747|744)')) return 'Blue Eagle';
    if (has('INSTRUCTOR')) return 'Line Instructor';
    if (has('CHIEF')) return 'Chief Flight Instructor';
    if (has('SKYMASTER')) return 'IndGo SkyMaster';
    if (has('COMMANDER')) return 'Blue Legacy Commander';
    return 'IndGo Cadet'; // Return a default valid rank
};


// --- DDB HELPERS ---
async function ddbScanAll(tableName) {
    const items = [];
    let ExclusiveStartKey = undefined;
    do {
        const command = new ScanCommand({ TableName: tableName, ExclusiveStartKey });
        const out = await ddbDoc.send(command);
        if (out.Items) items.push(...out.Items);
        ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items;
}

function mapDbItemToLeg(item) {
    const dep = String(item.departure || '').toUpperCase();
    const arr = String(item.arrival || '').toUpperCase();
    const ac = String(item.aircraft || '').trim();
    const ft = Number(item.flightTime || 0);
    const operator = item.operator || 'IndGo Air Virtual';
    const type = item.type || 'primary';
    const rankUnlock = item.rankUnlock || deduceRankFromAircraft(ac);
    return {
        flightNumber: String(item.flightNumber || `${dep}${arr}`),
        departure: dep,
        arrival: arr,
        departureCountry: getCountryCode(dep),
        arrivalCountry: getCountryCode(arr),
        aircraft: ac,
        flightTime: ft,
        rankUnlock,
        operator,
        isCodeshare: type === 'codeshare'
    };
}

async function fetchAllLegsFromDynamo() {
    const rows = await ddbScanAll(ROUTES_TABLE);
    return rows
        .map(mapDbItemToLeg)
        .filter(l => l.departure && l.arrival && l.aircraft && !isNaN(l.flightTime) && l.flightTime > 0);
}

// --- DDB BATCH OPERATION HELPERS ---
async function batchWriteToDynamo(items, tableName, operation = 'PutRequest') {
    const BATCH_SIZE = 25;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const chunk = items.slice(i, i + BATCH_SIZE);
        const requestItems = chunk.map(item => ({
            [operation]: {
                [operation === 'PutRequest' ? 'Item' : 'Key']: item
            }
        }));

        const command = new BatchWriteCommand({
            RequestItems: { [tableName]: requestItems }
        });

        try {
            await ddbDoc.send(command);
        } catch (error) {
            console.error(`Error during batch ${operation} to ${tableName}:`, error);
        }
    }
}

// --- Roster generation logic (now with DynamoDB saving) ---
async function processAndSaveRosters(generatedRosters) {
    if (generatedRosters.length === 0) {
        return 0;
    }

    const activeUsers = await User.find({ dutyStatus: 'ON_DUTY', currentRoster: { $ne: null } }).select('currentRoster').lean();
    const activeRosterIds = new Set(activeUsers.map(user => user.currentRoster));
    if (activeRosterIds.size > 0) {
        console.log(`Preserving ${activeRosterIds.size} active roster(s) currently in use by pilots.`);
    }

    const allOldRosters = await ddbScanAll(ROSTERS_TABLE);
    const oldGeneratedRosters = allOldRosters.filter(r => r.isGenerated);

    const rostersToDelete = oldGeneratedRosters
        .filter(r => !activeRosterIds.has(r.rosterId))
        .map(r => ({ rosterId: r.rosterId }));

    if (rostersToDelete.length > 0) {
        console.log(`Deleting ${rostersToDelete.length} old, unused generated rosters from DynamoDB.`);
        await batchWriteToDynamo(rostersToDelete, ROSTERS_TABLE, 'DeleteRequest');
    }

    const rostersToInsert = generatedRosters.map(roster => ({
        ...roster,
        rosterId: crypto.randomUUID(),
        createdAt: new Date().toISOString()
    }));

    await batchWriteToDynamo(rostersToInsert, ROSTERS_TABLE, 'PutRequest');

    console.log(`Successfully generated and saved ${rostersToInsert.length} new rosters to DynamoDB.`);
    return rostersToInsert.length;
}

// REMOVED: The generateRostersFromGoogleSheet function has been deleted as it is no longer used.

const generateRostersFromDynamo = async () => {
    console.log('Starting automated roster generation from DynamoDB routes...');
    const allLegs = await fetchAllLegsFromDynamo();
    console.log(`Total available legs for roster generation from DynamoDB: ${allLegs.length}`);
    if (allLegs.length === 0) return { created: 0, legsFound: 0 };

    const generatedRosters = [];
    // --- MODIFICATION START ---
    // Define specific counts for single-rank and mixed-rank rosters.
    const minRostersPerRank = 3;
    const mixedRostersPerHub = 5;
    // --- MODIFICATION END ---

    const legsByDeparture = allLegs.reduce((acc, leg) => { (acc[leg.departure] = acc[leg.departure] || []).push(leg); return acc; }, {});
    const legsByRank = allLegs.reduce((acc, leg) => { (acc[leg.rankUnlock] = acc[leg.rankUnlock] || []).push(leg); return acc; }, {});

    // --- LOOP 1: Generate dedicated rosters for each rank ---
    console.log(`Attempting to generate ${minRostersPerRank} rosters per rank per hub...`);
    for (const rank in legsByRank) {
        if (!pilotRanks.includes(rank)) continue;
        const legsByDepartureForRank = legsByRank[rank].reduce((acc, leg) => { (acc[leg.departure] = acc[leg.departure] || []).push(leg); return acc; }, {});
        
        for (const departureAirport of Object.keys(legsByDepartureForRank)) {
            // This loop will now attempt to create 3 single-rank rosters.
            for (let i = 0; i < minRostersPerRank; i++) {
                const rosterLegs = []; 
                let currentAirport = departureAirport; 
                let totalTime = 0; 
                const usedFlightNumbers = new Set();
                
                // Build a roster with 2 to 4 legs
                for (let j = 0; j < (Math.floor(Math.random() * 3) + 2); j++) {
                    const possibleNextLegs = (legsByDepartureForRank[currentAirport] || []).filter(l => !usedFlightNumbers.has(l.flightNumber));
                    if (possibleNextLegs.length === 0) break;
                    
                    const nextLeg = possibleNextLegs[Math.floor(Math.random() * possibleNextLegs.length)];
                    if ((totalTime + nextLeg.flightTime) > MAX_DAILY_FLIGHT_HOURS) break;
                    
                    rosterLegs.push(nextLeg); 
                    totalTime += nextLeg.flightTime; 
                    currentAirport = nextLeg.arrival; 
                    usedFlightNumbers.add(nextLeg.flightNumber);
                }
                
                if (rosterLegs.length >= 2) {
                    generatedRosters.push({ 
                        name: `${departureAirport} ${rank} Duty #${i + 1}`, 
                        hub: departureAirport, 
                        legs: rosterLegs, 
                        totalFlightTime: totalTime, 
                        multiplier: parseFloat((1.1 + Math.random() * 0.4).toFixed(2)), 
                        isGenerated: true, 
                        isAvailable: true 
                    });
                }
            }
        }
    }

    // --- LOOP 2: Generate additional mixed-rank rosters for variety ---
    console.log(`Attempting to generate ${mixedRostersPerHub} mixed-rank rosters per hub...`);
    for (const departureAirport of Object.keys(legsByDeparture)) {
        // This loop will now create 5 mixed-rank rosters.
        for (let i = 0; i < mixedRostersPerHub; i++) {
            const rosterLegs = []; 
            let currentAirport = departureAirport; 
            let totalTime = 0; 
            const usedFlightNumbers = new Set();
            
            // Build a roster with 2 to 4 legs
            for (let j = 0; j < (Math.floor(Math.random() * 3) + 2); j++) {
                const possibleNextLegs = (legsByDeparture[currentAirport] || []).filter(l => !usedFlightNumbers.has(l.flightNumber));
                if (possibleNextLegs.length === 0) break;
                
                const nextLeg = possibleNextLegs[Math.floor(Math.random() * possibleNextLegs.length)];
                if ((totalTime + nextLeg.flightTime) > MAX_DAILY_FLIGHT_HOURS) break;
                
                rosterLegs.push(nextLeg); 
                totalTime += nextLeg.flightTime; 
                currentAirport = nextLeg.arrival; 
                usedFlightNumbers.add(nextLeg.flightNumber);
            }
            
            if (rosterLegs.length >= 2) {
                generatedRosters.push({ 
                    name: `${departureAirport} Sector Duty #${i + 1}`, 
                    hub: departureAirport, 
                    legs: rosterLegs, 
                    totalFlightTime: totalTime, 
                    multiplier: parseFloat((1.1 + Math.random() * 0.4).toFixed(2)), 
                    isGenerated: true, 
                    isAvailable: true 
                });
            }
        }
    }

    generatedRosters.sort(() => Math.random() - 0.5);
    const createdCount = await processAndSaveRosters(generatedRosters);
    return { created: createdCount, legsFound: allLegs.length };
};


// Rank Promotion Helper
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

// --- ACARS Tracking Config & Helpers ---
const LIVE_FLIGHTS_URL = (process.env.LIVE_FLIGHTS_URL || '').trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').trim();
const TRACK_WEBHOOK_SECRET = (process.env.TRACK_WEBHOOK_SECRET || '').trim();
const DEFAULT_IF_SERVER = (process.env.DEFAULT_IF_SERVER || 'Expert Server').trim();

function requireWebhookSecret(req, res, next) {
    const got = req.header('x-acars-signature') || '';
    if (!TRACK_WEBHOOK_SECRET || got !== TRACK_WEBHOOK_SECRET) {
        return res.status(401).json({ message: 'Unauthorized webhook' });
    }
    next();
}

function ensureMap(obj) {
    if (!obj.mapData) obj.mapData = {};
    if (!obj.mapData.ifTracking) obj.mapData.ifTracking = {};
}

async function callLiveFlightsStart({ username, server, flightPlanId }) {
    if (!LIVE_FLIGHTS_URL) throw new Error('LIVE_FLIGHTS_URL not set');
    const callbackUrl = `${PUBLIC_BASE_URL}/api/acars/track-hook?flightPlanId=${encodeURIComponent(flightPlanId)}`;
    const body = { username, server: server || DEFAULT_IF_SERVER, callbackUrl };

    const r = await axios.post(`${LIVE_FLIGHTS_URL}/track/start`, body, {
        timeout: 10000,
        headers: { 'x-acars-signature': TRACK_WEBHOOK_SECRET || '' }
    });
    return r.data;
}


// 7. API ROUTES (ENDPOINTS)

app.get('/api/airports', async (req, res) => {
    try {
        if (Object.keys(airportsData).length === 0) {
            return res.status(503).json({ message: 'Airport data is not available at the moment. Please try again later.' });
        }
        res.json(airportsData);
    } catch (error) {
        console.error('Error in /api/airports endpoint:', error);
        res.status(500).json({ message: 'Could not load airport data.' });
    }
});

// --- Admin Routes & Codeshares CRUD (DynamoDB) ---

// Add/replace a route — now requires operator and livery
app.post('/api/routes', authMiddleware, isRouteManager, async (req, res) => {
    try {
        const item = req.body || {};
        const required = ['flightNumber', 'departure', 'arrival', 'aircraft', 'flightTime', 'operator', 'livery'];
        const missing = required.filter(k => !item[k]);
        if (missing.length) {
            return res.status(400).json({ message: `Missing fields: ${missing.join(', ')}` });
        }

        // Normalize and clean data
        item.flightNumber = String(item.flightNumber).toUpperCase().trim();
        item.departure = String(item.departure).toUpperCase().trim();
        item.arrival = String(item.arrival).toUpperCase().trim();
        item.aircraft = String(item.aircraft).trim();
        item.operator = String(item.operator).trim();
        item.livery = String(item.livery).trim();
        item.flightTime = Number(item.flightTime);
        item.type = item.type || 'primary';
        item.rankUnlock = item.rankUnlock || deduceRankFromAircraft(item.aircraft || '');

        await ddbDoc.send(new PutCommand({ TableName: ROUTES_TABLE, Item: item }));
        res.status(201).json({ message: 'Route saved.' });
    } catch (e) {
        console.error('POST /api/routes failed:', e);
        res.status(500).json({ message: 'Failed to save route.' });
    }
});

app.delete('/api/routes/:flightNumber', authMiddleware, isRouteManager, async (req, res) => {
    try {
        const flightNumber = String(req.params.flightNumber || '').toUpperCase().trim();
        if (!flightNumber) return res.status(400).json({ message: 'flightNumber is required' });
        await ddbDoc.send(new DeleteCommand({ TableName: ROUTES_TABLE, Key: { flightNumber } }));
        res.json({ message: 'Route deleted.' });
    } catch (e) {
        console.error('DELETE /api/routes/:flightNumber failed:', e);
        res.status(500).json({ message: 'Failed to delete route.' });
    }
});

// Enhanced GET with server-side filtering
app.get('/api/routes', authMiddleware, isRouteManager, async (req, res) => {
    try {
        const items = await ddbScanAll(ROUTES_TABLE);
        const { operator, aircraft, icao } = req.query;
        const norm = s => String(s || '').trim().toUpperCase();

        const filtered = items.filter(it => {
            const opOk   = !operator || String(it.operator || '') === operator;
            const acOk   = !aircraft || norm(it.aircraft).includes(norm(aircraft));
            const icaoOk = !icao || (norm(it.departure).includes(norm(icao)) || norm(it.arrival).includes(norm(icao)));
            return opOk && acOk && icaoOk;
        });

        res.json(filtered);
    } catch (e) {
        console.error('[GET /api/routes] error:', e);
        res.status(500).json({ message: 'Failed to fetch routes.' });
    }
});


app.get('/api/routes/by-departure/:icao', authMiddleware, isRouteManager, async (req, res) => {
    try {
        const icao = req.params.icao.toUpperCase();
        // Fallback scan if GSI is not configured. For production, a GSI on 'departure' is recommended.
        const out = await ddbScanAll(ROUTES_TABLE);
        const items = out.filter(it => (it.departure || '').toUpperCase() === icao);
        return res.json(items);
    } catch (e) {
        res.status(500).json({ message: 'Failed to query routes.' });
    }
});

// NEW: GET all routes for any authenticated pilot, with filtering
app.get('/api/routes/all', authMiddleware, async (req, res) => {
    try {
        // Fetch all items from the DynamoDB table for routes
        const allRoutes = await ddbScanAll(ROUTES_TABLE);
        const { operator, aircraft, icao } = req.query;

        // Function to normalize strings for case-insensitive searching
        const normalize = s => String(s || '').trim().toUpperCase();

        // Filter the routes on the server based on query parameters
        const filteredRoutes = allRoutes.filter(route => {
            const operatorOK = !operator || normalize(route.operator).includes(normalize(operator));
            const aircraftOK = !aircraft || normalize(route.aircraft).includes(normalize(aircraft));
            const icaoOK = !icao || (normalize(route.departure).includes(normalize(icao)) || normalize(route.arrival).includes(normalize(icao)));
            return operatorOK && aircraftOK && icaoOK;
        });

        res.json(filteredRoutes); // Send back the filtered list
    } catch (e) {
        console.error('[GET /api/routes/all] error:', e);
        res.status(500).json({ message: 'Failed to fetch all routes.' });
    }
});


// --- CODESHARE PARTNER MANAGEMENT ---

// List all codeshare partners
app.get('/api/codeshares', authMiddleware, isRouteManager, async (req, res) => {
    try {
        const items = await ddbScanAll(CODESHARE_TABLE);
        res.json(items);
    } catch (e) {
        console.error('GET /api/codeshares failed:', e);
        res.status(500).json({ message: 'Failed to load codeshare partners.' });
    }
});

// Add/update a codeshare partner
app.post('/api/codeshares', authMiddleware, isRouteManager, async (req, res) => {
    try {
        const { name, logoUrl } = req.body || {};
        if (!name || !logoUrl) {
            return res.status(400).json({ message: 'Missing fields: name, logoUrl' });
        }
        await ddbDoc.send(new PutCommand({
            TableName: CODESHARE_TABLE,
            Item: { name, logoUrl }
        }));
        res.status(201).json({ message: 'Codeshare partner saved.' });
    } catch (e) {
        console.error('POST /api/codeshares failed:', e);
        res.status(500).json({ message: 'Failed to save codeshare partner.' });
    }
});

// Delete a codeshare partner by name
app.delete('/api/codeshares/:name', authMiddleware, isRouteManager, async (req, res) => {
    try {
        const name = req.params.name;
        await ddbDoc.send(new DeleteCommand({
            TableName: CODESHARE_TABLE,
            Key: { name }
        }));
        res.json({ message: 'Codeshare partner deleted.' });
    } catch (e) {
        console.error('DELETE /api/codeshares/:name failed:', e);
        res.status(500).json({ message: 'Failed to delete codeshare partner.' });
    }
});

// Upload a logo for a codeshare partner
app.post('/api/codeshares/logo', authMiddleware, isRouteManager, (req, res, next) => {
    if (!process.env.AWS_S3_BUCKET_NAME) {
        return res.status(400).json({ message: 'AWS_S3_BUCKET_NAME environment variable not set.' });
    }
    next();
}, uploadCodeshareLogo.single('logo'), (req, res) => {
    if (!req.file || !req.file.location) {
        return res.status(400).json({ message: 'File upload failed.' });
    }
    res.status(201).json({ logoUrl: req.file.location });
});

// --- AIRCRAFT MANAGEMENT ---

// GET all aircraft (optional filter by codeshare/operator)
app.get('/api/aircrafts', authMiddleware, async (req, res) => {
    try {
        const { codeshare } = req.query;
        const q = codeshare ? { codeshare } : {};
        const items = await Aircraft.find(q).sort({ codeshare: 1, icao: 1 }).lean();
        res.json(items);
    } catch (e) {
        console.error('[GET /api/aircrafts] error:', e);
        res.status(500).json({ message: 'Failed to load aircraft.' });
    }
});

// GET unique aircraft types
app.get('/api/aircrafts/types', authMiddleware, isRouteManager, async (req, res) => {
    try {
        const types = await Aircraft.distinct('type');
        res.json(types.sort());
    } catch (e) {
        console.error('[GET /api/aircrafts/types] error:', e);
        res.status(500).json({ message: 'Failed to load aircraft types.' });
    }
});

// POST create/upsert aircraft
app.post('/api/aircrafts', authMiddleware, isRouteManager,
    (req, res, next) => {
        const ct = (req.headers['content-type'] || '').toLowerCase();
        if (ct.includes('multipart/form-data')) {
            if (!process.env.AWS_S3_BUCKET_NAME) {
                return res.status(400).json({ message: 'AWS_S3_BUCKET_NAME not set for uploads.' });
            }
            return uploadAircraftImage.single('aircraftImage')(req, res, next);
        }
        next();
    },
    async (req, res) => {
        try {
            const body = req.body || {};
            const doc = {
                name: (body.name || '').trim(),
                icao: String(body.icao || '').trim().toUpperCase(),
                type: (body.type || '').trim(),
                rankUnlock: (body.rankUnlock || '').trim(),
                codeshare: (body.codeshare || '').trim(),
            };

            if (!doc.name || !doc.icao || !doc.type || !doc.rankUnlock || !doc.codeshare) {
                return res.status(400).json({ message: 'Missing fields: name, icao, type, rankUnlock, codeshare' });
            }

            const uploaded = req.file && req.file.location ? req.file.location : null;
            const external = (body.imageUrl || '').trim() || null;

            doc.s3ImageUrl = uploaded;
            doc.imageUrl = uploaded || external;


            const saved = await Aircraft.findOneAndUpdate(
                { icao: doc.icao, codeshare: doc.codeshare },
                { $set: doc },
                { new: true, upsert: true }
            );

            res.status(201).json(saved);
        } catch (e) {
            console.error('[POST /api/aircrafts] error:', e);
            res.status(500).json({ message: 'Failed to save aircraft.' });
        }
    }
);

// NEW: PUT update existing aircraft by ID
app.put('/api/aircrafts/:id', authMiddleware, isRouteManager,
    (req, res, next) => {
        const ct = (req.headers['content-type'] || '').toLowerCase();
        if (ct.includes('multipart/form-data')) {
            if (!process.env.AWS_S3_BUCKET_NAME) {
                return res.status(400).json({ message: 'AWS_S3_BUCKET_NAME not set for uploads.' });
            }
            return uploadAircraftImage.single('aircraftImage')(req, res, next);
        }
        next();
    },
    async (req, res) => {
        try {
            const { id } = req.params;
            const body = req.body || {};

            const aircraft = await Aircraft.findById(id);
            if (!aircraft) {
                return res.status(404).json({ message: 'Aircraft not found.' });
            }

            // Update fields from request body
            aircraft.name = (body.name || aircraft.name).trim();
            aircraft.icao = String(body.icao || aircraft.icao).trim().toUpperCase();
            aircraft.type = (body.type || aircraft.type).trim();
            aircraft.rankUnlock = (body.rankUnlock || aircraft.rankUnlock).trim();
            aircraft.codeshare = (body.codeshare || aircraft.codeshare).trim();

            const uploaded = req.file && req.file.location ? req.file.location : null;
            const external = (body.imageUrl || '').trim() || null;

            // Image update logic
            if (uploaded) {
                // If a new file is uploaded, delete the old one from S3
                if (aircraft.s3ImageUrl) {
                    await deleteS3Object(aircraft.s3ImageUrl);
                }
                aircraft.s3ImageUrl = uploaded;
                aircraft.imageUrl = uploaded;
            } else if (external) {
                 // If an external URL is provided, remove any old S3 image
                if (aircraft.s3ImageUrl) {
                    await deleteS3Object(aircraft.s3ImageUrl);
                    aircraft.s3ImageUrl = null;
                }
                aircraft.imageUrl = external;
            }

            const updatedAircraft = await aircraft.save();
            res.json(updatedAircraft);

        } catch (e) {
            console.error('[PUT /api/aircrafts/:id] error:', e);
            res.status(500).json({ message: 'Failed to update aircraft.' });
        }
    }
);


// DELETE aircraft by id
app.delete('/api/aircrafts/:id', authMiddleware, isRouteManager, async (req, res) => {
    try {
        const { id } = req.params;
        const item = await Aircraft.findById(id);
        if (!item) return res.status(404).json({ message: 'Not found' });

        if (item.s3ImageUrl) {
            await deleteS3Object(item.s3ImageUrl);
        }
        await item.deleteOne();
        res.json({ message: 'Aircraft deleted.' });
    } catch (e) {
        console.error('[DELETE /api/aircrafts/:id] error:', e);
        res.status(500).json({ message: 'Failed to delete aircraft.' });
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

app.post('/api/register', async (req, res) => {
    try {
        const { name, email, password, callsign, inviteCode } = req.body;

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

        const invite = await Invite.findOne({ code: inviteCode, status: 'PENDING' });
        if (!invite) {
            return res.status(400).json({ message: 'This invite code is invalid or has already been used.' });
        }
        if (invite.expiresAt < new Date()) {
            invite.status = 'EXPIRED';
            await invite.save();
            return res.status(400).json({ message: 'This invite code has expired.' });
        }

        const salt = await bcrypt.genSalt(10);
        const newUser = new User({
            name,
            email: String(email).toLowerCase().trim(),
            password: await bcrypt.hash(password, salt),
            callsign: normalizedCallsign,
            role: 'pilot'
        });
        await newUser.save();

        invite.status = 'ACCEPTED';
        invite.usedBy = newUser._id;
        await invite.save();

        updateGoogleSheet({
            callsign: newUser.callsign,
            name: newUser.name,
            rank: newUser.rank,
            flightHours: newUser.flightHours
        });

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

app.get('/api/me', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('-password').populate('currentFlightPlans').lean();
        if (!user) return res.status(404).json({ message: 'User not found.' });

        user.timeUntilNextDutyMs = 0;
        if (user.dutyStatus === 'ON_REST' && user.lastDutyOff) {
            const restEndsAt = user.lastDutyOff.getTime() + MIN_REST_PERIOD;
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
        const { name, bio, discord, infiniteFlightUsername, ifc, youtube, preferredContact } = req.body;
        const updatedData = { name, bio, discord, infiniteFlightUsername, ifc, youtube, preferredContact };

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

app.post('/api/flightplans', authMiddleware, async (req, res) => {
    try {
        // START: UPDATED DESTRUCTURING
        const {
            flightNumber, departure, arrival, aircraft, etd, eet, alternate, pob, route, squawkCode,
            zfw, tow, cargo, fuelTaxi, fuelTrip, fuelTotal, v1, vr, v2, vref, departureWeather, arrivalWeather, mapData,
            tlr, cruiseAltitude, cruiseSpeed // <-- Added the new fields here
        } = req.body;
        // END: UPDATED DESTRUCTURING

        if (!flightNumber || !departure || !arrival || !aircraft || !etd || !eet || !alternate || !pob || !route) {
            return res.status(400).json({ message: 'Please provide all required flight plan details.' });
        }

        const pilot = await User.findById(req.user._id);
        if (!pilot) return res.status(404).json({ message: 'Pilot not found.' });

        if (pilot.promotionStatus === 'PENDING_TEST') {
            return res.status(403).json({ message: 'You are awaiting promotion tests and cannot file new flight plans.' });
        }
        if (pilot.currentFlightPlans && pilot.currentFlightPlans.length >= 2) {
            return res.status(400).json({ message: 'You have reached the maximum of 2 active flights. Please complete or cancel one first.' });
        }

        const planData = {};
        const rosterLegData = {};

        if (pilot.dutyStatus === 'ON_DUTY' && pilot.currentRoster) {
            const rosterResponse = await ddbDoc.send(new GetCommand({ TableName: ROSTERS_TABLE, Key: { rosterId: pilot.currentRoster } }));
            const roster = rosterResponse.Item;
            const leg = roster?.legs.find(l => l.flightNumber.toUpperCase() === flightNumber.toUpperCase());

            if (leg) {
                const existingPlanForLeg = await FlightPlan.findOne({
                    pilot: pilot._id,
                    'rosterLeg.rosterId': roster.rosterId,
                    'rosterLeg.flightNumber': flightNumber,
                    status: { $in: ['PLANNED', 'FLYING', 'COMPLETED'] }
                });
                if (existingPlanForLeg) {
                    return res.status(400).json({ message: 'You have already filed a flight plan for this specific roster leg.' });
                }

                planData.departure = leg.departure;
                planData.arrival = leg.arrival;
                planData.aircraft = leg.aircraft;
                rosterLegData.rosterId = roster.rosterId;
                rosterLegData.flightNumber = leg.flightNumber;
            }
        }

        if (!rosterLegData.rosterId) {
            planData.departure = departure;
            planData.arrival = arrival;
            planData.aircraft = aircraft;
        }

        const requiredRank = deduceRankFromAircraft(planData.aircraft);
        if (!canFlyLeg(pilot.rank, requiredRank)) {
            return res.status(403).json({ message: `This aircraft/route requires ${requiredRank}, which is above your rank (${pilot.rank}).` });
        }

        const eetHours = parseFloat(eet);
        const etdDate = new Date(etd);
        const etaDate = new Date(etdDate.getTime() + eetHours * 60 * 60 * 1000);

        // START: UPDATED FLIGHT PLAN CONSTRUCTOR
        const newFlightPlan = new FlightPlan({
            pilot: pilot._id, flightNumber, departure: planData.departure, arrival: planData.arrival,
            aircraft: planData.aircraft, alternate, pob, route, etd: etdDate, eet: eetHours, eta: etaDate,
            ficNumber: generateFicNumber(), adcNumber: generateAdcNumber(), squawkCode: squawkCode || generateSquawkCode(),
            rosterLeg: rosterLegData.rosterId ? rosterLegData : undefined,
            zfw, tow, cargo, fuelTaxi, fuelTrip, fuelTotal, v1, vr, v2, vref,
            departureWeather, arrivalWeather, mapData,
            tlr, cruiseAltitude, cruiseSpeed // <-- Added the new fields here
        });
        // END: UPDATED FLIGHT PLAN CONSTRUCTOR

        await newFlightPlan.save();
        pilot.currentFlightPlans.push(newFlightPlan._id);
        await pilot.save();

        res.status(201).json({ message: 'Flight plan filed successfully. You are cleared to depart at your ETD.', flightPlan: newFlightPlan });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while filing flight plan.' });
    }
});

app.get('/api/flightplans/:id', authMiddleware, async (req, res) => {
    try {
        const flightPlan = await FlightPlan.findOne({
            _id: req.params.id,
            pilot: req.user._id
        });

        if (!flightPlan) {
            return res.status(404).json({ message: 'Flight plan not found or you do not have permission to view it.' });
        }

        res.json(flightPlan);
    } catch (error) {
        console.error('Error fetching flight plan by ID:', error);
        res.status(500).json({ message: 'Server error while fetching flight plan.' });
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
            pilot: flightPlan.pilot, flightNumber: flightPlan.flightNumber, departure: flightPlan.departure,
            arrival: flightPlan.arrival, aircraft: flightPlan.aircraft, flightTime: parseFloat(flightTimeHours.toFixed(2)),
            remarks, verificationImageUrl: req.file.location, status: 'PENDING', isMultiplierEligible: false,
            source: 'MANUAL',
            sourceFlightPlanId: flightPlan._id
        };

        if (flightPlan.rosterLeg && flightPlan.rosterLeg.rosterId) {
            const rosterResponse = await ddbDoc.send(new GetCommand({ TableName: ROSTERS_TABLE, Key: { rosterId: flightPlan.rosterLeg.rosterId } }));
            const roster = rosterResponse.Item;
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

        await User.updateOne({ _id: flightPlan.pilot }, { $pull: { currentFlightPlans: flightPlan._id } });
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

        await FlightPlan.findByIdAndDelete(req.params.id);
        await User.updateOne({ _id: flightPlan.pilot }, { $pull: { currentFlightPlans: flightPlan._id } });

        res.json({ message: 'Flight plan has been successfully cancelled and deleted.' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while cancelling flight plan.' });
    }
});

// --- ACARS Tracking Routes ---

app.post('/api/acars/track/start/:flightPlanId', authMiddleware, async (req, res) => {
    try {
        const { flightPlanId } = req.params;
        const server = (req.body?.server || DEFAULT_IF_SERVER);

        const flightPlan = await FlightPlan.findById(flightPlanId);
        if (!flightPlan) return res.status(404).json({ message: 'Flight plan not found.' });
        if (flightPlan.pilot.toString() !== req.user._id) return res.status(403).json({ message: 'This is not your flight plan.' });

        const pilot = await User.findById(req.user._id).lean();
        const username = (pilot?.infiniteFlightUsername || '').trim();
        if (!username) return res.status(400).json({ message: 'Please set your Infinite Flight username in your profile.' });

        // <<< NEW LOGGING: Log the URL we are about to call >>>
        console.log(`[ACARS B2B] Attempting to contact ACARS service at: ${LIVE_FLIGHTS_URL}/track/start`);
        
        const resp = await callLiveFlightsStart({ username, server, flightPlanId });
        
        // <<< NEW LOGGING: Log success >>>
        console.log(`[ACARS B2B] Successfully started ACARS tracking service for user: ${username}`);


        const plan = await FlightPlan.findById(flightPlanId);
        ensureMap(plan);
        plan.mapData.ifTracking = {
            status: 'searching',
            server,
            tracker: (resp?.trackers?.[0] || null),
            lastUpdate: new Date().toISOString()
        };
        await plan.save();

        res.json({ ok: true, message: 'Tracking started', tracker: plan.mapData.ifTracking });

    } catch (e) {
        // <<< MODIFIED LOGGING: Log the FULL, DETAILED error >>>
        console.error('[ACARS B2B] FAILED to contact ACARS service. Full Error:', e);
        
        // Also check for axios-specific error details
        if (e.response) {
            console.error('[ACARS B2B] Axios Response Error Data:', e.response.data);
            console.error('[ACARS B2B] Axios Response Error Status:', e.response.status);
        } else if (e.request) {
            console.error('[ACARS B2B] Axios Request Error: No response received.', e.request);
        } else {
            console.error('[ACARS B2B] General Error:', e.message);
        }

        res.status(500).json({ message: 'Failed to start tracking. The ACARS service could not be reached.' });
    }
});

app.post('/api/acars/track-hook', requireWebhookSecret, async (req, res) => {
    try {
        const { status, username, server, flight, trackerId, flightDurationMs, airport, reason } = req.body || {};
        const flightPlanId = req.query.flightPlanId;
        if (!flightPlanId) return res.status(400).json({ message: 'Missing flightPlanId' });

        const plan = await FlightPlan.findById(flightPlanId);
        if (!plan) return res.status(404).json({ message: 'Flight plan not found.' });

        ensureMap(plan);
        const info = plan.mapData.ifTracking || {};
        info.lastUpdate = new Date().toISOString();
        info.status = status || info.status;
        if (trackerId) info.tracker = { ...(info.tracker || {}), id: trackerId };
        if (server) info.server = server;

        if (status === 'found' && flight) {
            // <<< DEBUGGER: Log that the departure event was received >>>
            console.log(`[ACARS Debug] Received 'found' (departure) event for Flight Plan ${plan._id} and user ${username}.`);

            info.flight = {
                sessionId: flight.sessionId,
                flightId: flight.flightId,
                callsign: flight.callsign,
                userId: flight.userId
            };
            if (plan.status === 'PLANNED') {
                plan.status = 'FLYING';
                plan.actualDepartureTime = new Date();
            }
        } else if (status === 'not_found') {
            info.reason = reason || 'timeout_15m';
        } else if (status === 'landed') {
            // --- START: NEW ACARS PIREP FILING LOGIC ---
            info.status = 'landed';
            if (airport) info.landedAt = airport.icao;

            if (plan.status === 'COMPLETED') {
                console.log(`[ACARS] Received 'landed' webhook for already completed flight plan ${plan._id}. Ignoring.`);
                plan.mapData.ifTracking = info;
                await plan.save();
                return res.json({ ok: true, message: 'Flight plan was already completed.' });
            }

            plan.status = 'COMPLETED';
            plan.actualArrivalTime = new Date();

            const flightTimeHours = flightDurationMs > 0 ? (flightDurationMs / (1000 * 60 * 60)) : 0;

            const newPirepData = {
                pilot: plan.pilot,
                flightNumber: plan.flightNumber,
                departure: plan.departure,
                arrival: plan.arrival,
                aircraft: plan.aircraft,
                flightTime: parseFloat(flightTimeHours.toFixed(2)),
                remarks: `Automatically filed via ACARS. Detected landing at ${airport?.icao || plan.arrival}.`,
                status: 'PENDING',
                isMultiplierEligible: false,
                sourceFlightPlanId: plan._id,
                source: 'ACARS' // Tag this PIREP as coming from ACARS
            };

            // Handle Roster Leg logic for multipliers and rank unlocks
            if (plan.rosterLeg && plan.rosterLeg.rosterId) {
                const rosterResponse = await ddbDoc.send(new GetCommand({ TableName: ROSTERS_TABLE, Key: { rosterId: plan.rosterLeg.rosterId } }));
                const roster = rosterResponse.Item;
                if (roster) {
                    const leg = roster.legs.find(l => l.flightNumber === plan.flightNumber);
                    if (leg) {
                        newPirepData.rankUnlock = leg.rankUnlock;
                        newPirepData.operator = leg.operator;
                        newPirepData.rosterLeg = plan.rosterLeg;
                        const lastLegInRoster = roster.legs[roster.legs.length - 1];
                        if (lastLegInRoster.flightNumber.toUpperCase() === plan.flightNumber.toUpperCase()) {
                            newPirepData.isMultiplierEligible = true;
                        }
                    }
                }
            } else {
                newPirepData.rankUnlock = deduceRankFromAircraft(plan.aircraft);
                newPirepData.operator = 'IndGo Air Virtual';
            }

            const newPirep = new Pirep(newPirepData);
            await newPirep.save();
            
            console.log(`[ACARS] Filed new PIREP ${newPirep._id} for Flight Plan ${plan._id}`);

            // Update pilot's active flights and send notification
            // <<< DEBUGGER: Log that the system is looking for the user >>>
            console.log(`[ACARS Debug] Looking for user with ID: ${plan.pilot}`);
            const pilot = await User.findById(plan.pilot);
            
            if (pilot) {
                // <<< DEBUGGER: Log that the user was found >>>
                console.log(`[ACARS Debug] User found: ${pilot.callsign} (${pilot.email})`);
                
                pilot.notifications.push({ message: `Flight ${plan.flightNumber} landed. A PIREP has been automatically filed for review.`, createdAt: new Date() });
                pilot.currentFlightPlans.pull(plan._id);
                await pilot.save();
            } else {
                // <<< DEBUGGER: Log if the user was NOT found >>>
                console.warn(`[ACARS Debug] User NOT found for pilot ID: ${plan.pilot}`);
            }
            // --- END: NEW ACARS PIREP FILING LOGIC ---
        }

        plan.mapData.ifTracking = info;
        await plan.save();

        res.json({ ok: true });
    } catch (e) {
        console.error('track-hook error', e?.message, e);
        res.status(500).json({ message: 'Server error in webhook.' });
    }
});

app.post('/api/acars/track/stop/:flightPlanId', authMiddleware, async (req, res) => {
    try {
        const plan = await FlightPlan.findById(req.params.flightPlanId);
        if (!plan) return res.status(404).json({ message: 'Flight plan not found.' });
        if (plan.pilot.toString() !== req.user._id) return res.status(403).json({ message: 'This is not your flight plan.' });

        ensureMap(plan);
        if (plan.mapData.ifTracking) plan.mapData.ifTracking.status = 'stopped';
        await plan.save();

        res.json({ ok: true, message: 'Tracking stopped.' });
    } catch (e) {
        res.status(500).json({ message: 'Failed to stop tracking.' });
    }
});

app.get('/api/acars/status/:flightPlanId', authMiddleware, async (req, res) => {
    try {
        const plan = await FlightPlan.findById(req.params.flightPlanId);
        if (!plan) return res.status(404).json({ message: 'Flight plan not found.' });
        if (plan.pilot.toString() !== req.user._id) return res.status(403).json({ message: 'This is not your flight plan.' });

        ensureMap(plan);
        res.json({ ok: true, ifTracking: plan.mapData.ifTracking || null, status: plan.status });
    } catch (e) {
        res.status(500).json({ message: 'Failed to get tracking status.' });
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
        const { correctedFlightTime } = req.body;

        const pirep = await Pirep.findById(req.params.pirepId);
        if (!pirep) return res.status(404).json({ message: 'PIREP not found.' });
        if (pirep.status !== 'PENDING') return res.status(400).json({ message: `This PIREP has already been ${pirep.status.toLowerCase()}.` });
        if (pirep.verificationImageUrl) { deleteS3Object(pirep.verificationImageUrl); }

        const pilot = await User.findById(pirep.pilot);
        if (!pilot) return res.status(404).json({ message: 'Associated pilot profile not found.' });

        let hoursToAdd = pirep.flightTime;
        let timeWasCorrected = false;

        const parsedTime = parseFloat(correctedFlightTime);
        if (parsedTime && !isNaN(parsedTime) && parsedTime > 0) {
            hoursToAdd = parsedTime;
            pirep.flightTime = hoursToAdd;
            timeWasCorrected = true;
        }

        let multiplierApplied = 1;
        if (pirep.isMultiplierEligible && pirep.rosterLeg?.rosterId) {
            const rosterResponse = await ddbDoc.send(new GetCommand({ TableName: ROSTERS_TABLE, Key: { rosterId: pirep.rosterLeg.rosterId } }));
            const roster = rosterResponse.Item;
            if (roster && roster.multiplier > 1) {
                hoursToAdd *= roster.multiplier;
                multiplierApplied = roster.multiplier;
            }
        }

        checkAndResetLeaderboardStats(pilot);
        const oldRank = pilot.rank;
        pilot.flightHours += hoursToAdd;
        pilot.weeklyFlightHours += hoursToAdd;
        pilot.leaderboardMonthlyFlightHours += hoursToAdd;
        pilot.weeklySectors += 1;
        pilot.monthlySectors += 1;

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
        await pirep.save();

        let message = `PIREP approved. ${pilot.name} now has ${pilot.flightHours.toFixed(2)} hours.`;
        if (timeWasCorrected) { message += ` Flight time was manually corrected to ${pirep.flightTime.toFixed(2)} hours.`; }
        if (multiplierApplied > 1) { message += ` A ${multiplierApplied}x multiplier was applied!`; }

        if (promotionResult.promoted) {
            message += ` Congratulations on the promotion to ${promotionResult.rank}!`;
            pilot.notifications.push({ message: `Congratulations! Your flight hours have earned you a promotion from ${oldRank} to ${promotionResult.rank}.` });
        }

        if (promotionResult.pendingTest) {
            const log = new AdminLog({ adminUser: req.user._id, action: 'PROMOTION_TEST_REQUIRED', targetUser: pilot._id, details: `${pilot.name} (${pilot.email}) has reached the required hours for ${promotionResult.prospectiveRank} and requires testing.` });
            await log.save();
            message += ` You have reached the flight hour requirement for the next rank! Staff has been notified to schedule your practical and written tests. Your account is now in an observation period.`;
            pilot.notifications.push({ message: `You have met the hour requirement for ${promotionResult.prospectiveRank}. To proceed, staff will contact you for mandatory promotion tests. Your flight operations are suspended until the tests are complete.` });
            const staffNotification = { message: `Action Required: Pilot ${pilot.name} (${pilot.callsign || 'N/A'}) is awaiting tests for promotion to ${promotionResult.prospectiveRank}.` };
            await User.updateMany({ role: { $in: ['admin', 'Chief Executive Officer (CEO)', 'Chief Operating Officer (COO)', 'Head of Training (COT)'] } }, { $push: { notifications: staffNotification } });
        }

        await pilot.save();

        if (pilot.callsign) {
            updateGoogleSheet({ callsign: pilot.callsign, name: pilot.name, rank: pilot.rank, flightHours: pilot.flightHours });
        }

        try {
            if (pirep.sourceFlightPlanId) {
                await FlightPlan.findByIdAndDelete(pirep.sourceFlightPlanId);
            }
        } catch (deleteError) {
            console.error('Could not delete the source flight plan:', deleteError);
        }

        res.json({ message });

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

        try {
            if (pirep.sourceFlightPlanId) {
                await FlightPlan.findByIdAndDelete(pirep.sourceFlightPlanId);
            }
        } catch (deleteError) {
            console.error('Could not delete the source flight plan for rejected PIREP:', deleteError);
        }

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
            user.notifications.push({ message: `Congratulations! You have passed your tests and have been promoted from ${oldRank} to ${newRank}. You are now cleared for normal flight operations.` });
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

// MODIFIED: All Roster routes now use DynamoDB
app.get('/api/rosters', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).lean();
        if (!user) return res.status(404).json({ message: 'User not found.' });

        const allRosters = await ddbScanAll(ROSTERS_TABLE);

        const departureIcao = String(user.lastKnownAirport || 'VIDP').toUpperCase().trim();
        const availableRosters = allRosters.filter(r =>
            r.isAvailable &&
            (r.hub === departureIcao || (r.legs && r.legs[0] && r.legs[0].departure === departureIcao))
        );

        const filtered = availableRosters.filter(r =>
            Array.isArray(r.legs) && r.legs.length > 0 &&
            r.legs.every(l => canFlyLeg(user.rank, getLegRequiredRank(l)))
        );
        res.json(filtered);
    } catch (error) {
        res.status(500).json({ message: 'Server error while fetching available rosters.' });
    }
});

app.get('/api/rosters/my-rosters', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).lean();
        if (!user) return res.status(404).json({ message: 'User not found.' });

        const searchLocations = new Set(
            [user.lastDutyAirport, user.lastKnownAirport].filter(Boolean).map(s => String(s).toUpperCase().trim())
        );
        if (searchLocations.size === 0) searchLocations.add('VIDP');
        const searchArray = Array.from(searchLocations);

        const allRosters = await ddbScanAll(ROSTERS_TABLE);
        const availableRosters = allRosters.filter(r =>
            r.isAvailable &&
            (searchArray.includes(r.hub) || (r.legs && r.legs[0] && searchArray.includes(r.legs[0].departure)))
        );

        res.json({
            rosters: availableRosters.filter(r =>
                Array.isArray(r.legs) && r.legs.length > 0 &&
                r.legs.every(l => canFlyLeg(user.rank, getLegRequiredRank(l)))
            ),
            searchCriteria: {
                fromLastDuty: user.lastDutyAirport,
                fromLastPirep: user.lastKnownAirport,
                searched: searchArray
            }
        });

    } catch (error) {
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
            const departureIcao = normalizeICAO(l.departure);
            const arrivalIcao = normalizeICAO(l.arrival);
            return {
                ...l,
                operator: (l.operator || '').trim() || 'IndGo Air Virtual',
                rankUnlock: (l.rankUnlock || '').trim() || deduceRankFromAircraft(l.aircraft),
                departure: departureIcao,
                arrival: arrivalIcao,
                departureCountry: getCountryCode(departureIcao),
                arrivalCountry: getCountryCode(arrivalIcao)
            };
        });

        const newRoster = {
            rosterId: crypto.randomUUID(),
            name,
            hub: normalizeICAO(hub || finishedLegs[0]?.departure),
            legs: finishedLegs,
            totalFlightTime: typeof totalFlightTime === 'number' && totalFlightTime > 0 ? totalFlightTime : finishedLegs.reduce((s, L) => s + (Number(L.flightTime) || 0), 0),
            multiplier: parseFloat((1.1 + Math.random() * 0.4).toFixed(2)),
            createdBy: req.user._id,
            createdAt: new Date().toISOString(),
            isGenerated: false,
            isAvailable: true
        };

        await ddbDoc.send(new PutCommand({ TableName: ROSTERS_TABLE, Item: newRoster }));

        await new AdminLog({ adminUser: req.user._id, action: 'ROSTER_CREATE', details: `Created new roster: "${name}"` }).save();

        res.status(201).json(newRoster);
    } catch (error) {
        res.status(500).json({ message: 'Server error while creating roster.' });
    }
});

app.post('/api/rosters/generate', authMiddleware, isRouteManager, async (req, res) => {
    try {
        // The endpoint now directly calls the function that uses DynamoDB.
        const result = await generateRostersFromDynamo();
        res.status(201).json({
            message: `Roster generation complete. Found ${result.legsFound} legs and created ${result.created} new rosters.`,
            source: 'DynamoDB' // The source is now always DynamoDB.
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server error while generating rosters.' });
    }
});

app.delete('/api/rosters/:rosterId', authMiddleware, isRouteManager, async (req, res) => {
    try {
        const { rosterId } = req.params;
        const command = new DeleteCommand({ TableName: ROSTERS_TABLE, Key: { rosterId } });
        await ddbDoc.send(command);

        await new AdminLog({ adminUser: req.user._id, action: 'ROSTER_DELETE', details: `Deleted roster with ID: ${rosterId}` }).save();

        res.json({ message: 'Roster deleted successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Server error while deleting roster.' });
    }
});

// MODIFIED: Duty start now uses DynamoDB to fetch roster
app.post('/api/duty/start', authMiddleware, async (req, res) => {
    const { rosterId } = req.body;
    try {
        const user = await User.findById(req.user._id);

        const rosterResponse = await ddbDoc.send(new GetCommand({ TableName: ROSTERS_TABLE, Key: { rosterId } }));
        const roster = rosterResponse.Item;

        if (!roster) return res.status(404).json({ message: 'Selected roster not found.' });
        if (user.dutyStatus === 'ON_DUTY') return res.status(400).json({ message: 'You are already on duty.' });
        if (user.promotionStatus === 'PENDING_TEST') return res.status(403).json({ message: 'You are awaiting promotion tests and cannot start a new duty.' });

        if (user.lastDutyOff && (Date.now() - user.lastDutyOff.getTime()) >= MIN_REST_PERIOD) {
            user.dailyFlightHours = 0;
        }

        if (!user.isFtplExempt) {
            if (user.lastDutyOff && (Date.now() - user.lastDutyOff) < MIN_REST_PERIOD) {
                const timeToRest = Math.ceil((MIN_REST_PERIOD - (Date.now() - user.lastDutyOff)) / 60000);
                return res.status(403).json({ message: `Crew rest required. You can go on duty in ${timeToRest} minutes.` });
            }
            if ((user.monthlyFlightHours + roster.totalFlightTime) > MAX_MONTHLY_FLIGHT_HOURS) return res.status(403).json({ message: `This duty would exceed your ${MAX_MONTHLY_FLIGHT_HOURS}-hour monthly limit.` });
            if ((user.dailyFlightHours + roster.totalFlightTime) > MAX_DAILY_FLIGHT_HOURS) return res.status(403).json({ message: `This duty would exceed your ${MAX_DAILY_FLIGHT_HOURS}-hour daily flight limit.` });
        }

        const overRankLeg = roster.legs.find(l => !canFlyLeg(user.rank, getLegRequiredRank(l)));
        if (overRankLeg) return res.status(403).json({ message: `This roster includes leg ${overRankLeg.flightNumber} (${overRankLeg.aircraft}) requiring ${getLegRequiredRank(overRankLeg)}, which is above your rank (${user.rank}).` });

        user.dutyStatus = 'ON_DUTY';
        user.currentRoster = roster.rosterId; // Save DynamoDB ID (string)
        user.lastDutyStart = Date.now();
        await user.save();

        res.json({ message: `You are now on duty for roster "${roster.name}".`, roster });
    } catch (error) {
        res.status(500).json({ message: 'Server error while starting duty.' });
    }
});

app.post('/api/duty/end', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (user.dutyStatus !== 'ON_DUTY') return res.status(400).json({ message: 'You are not currently on duty.' });
        if (!user.currentRoster) return res.status(400).json({ message: 'No roster assigned to end duty.' });

        const rosterResponse = await ddbDoc.send(new GetCommand({ TableName: ROSTERS_TABLE, Key: { rosterId: user.currentRoster } }));
        const roster = rosterResponse.Item;
        if (!roster) {
            user.dutyStatus = 'ON_REST';
            user.currentRoster = null;
            await user.save();
            return res.status(404).json({ message: 'The roster for your duty could not be found. Duty has been ended.' });
        }

        const filedPireps = await Pirep.countDocuments({
            pilot: user._id,
            'rosterLeg.rosterId': roster.rosterId,
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
            .select('name email callsign rank flightHours role createdAt promotionStatus')
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

app.put('/api/users/:userId/toggle-ftpl', authMiddleware, isPilotManager, async (req, res) => {
    try {
        const { userId } = req.params;
        const user = await User.findById(userId);
        if (!user) return res.status(404).json({ message: 'User not found.' });

        user.isFtplExempt = !user.isFtplExempt;
        await user.save();

        const status = user.isFtplExempt ? 'DISABLED' : 'ENABLED';

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

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, status: 'alive', timestamp: new Date().toISOString() });
});

app.post('/api/routes/import-sheet', authMiddleware, isRouteManager, async (req, res) => {
    const { sheetUrl, operator } = req.body;

    if (!sheetUrl || !operator) {
        return res.status(400).json({ message: 'A sheetUrl and operator are required.' });
    }

    console.log(`Starting route import for operator "${operator}" from URL: ${sheetUrl}`);

    const headerAliases = {
        flightNumber: ['Flight No.', 'Flight Number', 'Callsign'],
        departure: ['Departure ICAO', 'Departure', 'Origin', 'From'],
        arrival: ['Arrival ICAO', 'Arrival', 'Destination', 'To'],
        aircraft: ['Aircraft(s)', 'Aircraft', 'Plane', 'ICAO'],
        flightTime: ['Avg. Flight Time', 'Flight Time', 'Duration', 'EET']
    };
    const canonicalKeys = Object.keys(headerAliases);

    try {
        const response = await axios.get(sheetUrl.trim());
        const parsed = Papa.parse(response.data, { header: false, skipEmptyLines: true });
        if (!parsed.data || parsed.data.length < 2) {
            return res.status(400).json({ message: 'Sheet is empty or could not be parsed. Ensure it has a header row and data.' });
        }

        let headerRowIndex = -1;
        let columnMap = {};
        for (let i = 0; i < parsed.data.length; i++) {
            const row = parsed.data[i];
            const tempMap = {};
            row.forEach((cell, index) => {
                const header = String(cell || '').trim().toLowerCase();
                if (!header) return;
                for (const key of canonicalKeys) {
                    if (headerAliases[key].some(alias => alias.toLowerCase() === header)) {
                        tempMap[key] = index;
                        break;
                    }
                }
            });
            if (Object.keys(tempMap).length >= canonicalKeys.length) {
                columnMap = tempMap;
                headerRowIndex = i;
                console.log(`- Found a valid header row at index ${i}.`);
                break;
            }
        }

        if (headerRowIndex === -1) {
            return res.status(400).json({ message: `Could not find a valid header row. Please ensure columns like "${canonicalKeys.join('", "')}" are present.` });
        }
        
        // --- START OF FIX ---
        // Use a Map to automatically handle duplicates. The key will be the flight number.
        const routesMap = new Map();
        const newAircraftAdded = new Set();
        const dataRows = parsed.data.slice(headerRowIndex + 1);

        for (const row of dataRows) {
            const convertTimeToDecimal = (timeStr) => {
                if (!timeStr || typeof timeStr !== 'string') return NaN;
                const trimmedStr = timeStr.trim();
                if (trimmedStr.includes(':')) {
                    const parts = trimmedStr.split(':');
                    if (parts.length >= 2) {
                        const hours = parseInt(parts[0], 10);
                        const minutes = parseInt(parts[1], 10);
                        return !isNaN(hours) && !isNaN(minutes) ? hours + (minutes / 60) : NaN;
                    }
                }
                const hourMatch = trimmedStr.match(/(\d+)\s*h/);
                const minMatch = trimmedStr.match(/(\d+)\s*m/);
                let totalHours = 0;
                if (hourMatch) totalHours += parseInt(hourMatch[1], 10);
                if (minMatch) totalHours += parseInt(minMatch[1], 10) / 60;
                return totalHours > 0 ? totalHours : NaN;
            };
            const extractIcao = (text) => text ? (String(text).match(/^\s*([A-Z]{4})/) || [])[1] || null : null;

            const aircraftIcao = String(row[columnMap.aircraft] || '').trim().toUpperCase();
            const flightNumber = String(row[columnMap.flightNumber] || '').trim().toUpperCase();

            // Skip rows that don't have a flight number
            if (!flightNumber) {
                continue;
            }

            const item = {
                flightNumber: flightNumber,
                departure: extractIcao(row[columnMap.departure]),
                arrival: extractIcao(row[columnMap.arrival]),
                aircraft: aircraftIcao,
                flightTime: convertTimeToDecimal(row[columnMap.flightTime]),
                operator: operator.trim(),
                rankUnlock: deduceRankFromAircraft(aircraftIcao),
                type: operator.trim().toLowerCase() === 'indgo air virtual' ? 'primary' : 'codeshare'
            };

            if (item.departure && item.arrival && item.aircraft && item.flightTime > 0) {
                // If a flight number already exists in the map, this will overwrite it.
                // This ensures only the last-seen version of a route is kept.
                routesMap.set(item.flightNumber, item);

                const newAircraft = await Aircraft.findOneAndUpdate(
                    { icao: item.aircraft, codeshare: item.operator },
                    { 
                        $setOnInsert: {
                            name: item.aircraft,
                            icao: item.aircraft,
                            codeshare: item.operator,
                            type: 'Unknown',
                            rankUnlock: item.rankUnlock
                        }
                    },
                    { new: true, upsert: true }
                );
                
                if (newAircraft && newAircraft.createdAt.getTime() === newAircraft.updatedAt.getTime()) {
                    newAircraftAdded.add(item.aircraft);
                }
            }
        }
        
        // Convert the map's values back to an array for batch writing.
        const routesToSave = Array.from(routesMap.values());

        // --- END OF FIX ---


        if (routesToSave.length === 0) {
            return res.status(400).json({ message: 'No valid routes were found in the provided sheet.' });
        }

        await batchWriteToDynamo(routesToSave, ROUTES_TABLE, 'PutRequest');

        res.status(201).json({
            message: 'Import successful!',
            routesAdded: routesToSave.length,
            newAircraftCreated: newAircraftAdded.size,
            aircraftList: Array.from(newAircraftAdded)
        });

    } catch (error) {
        console.error(`- ERROR: Failed to process sheet for operator ${operator}:`, error.message);
        // Add more detailed logging for the specific batch write error
        if (error.name === 'ValidationException') {
            console.error('DynamoDB Validation Error Details:', error);
        }
        res.status(500).json({ message: 'Failed to fetch or process the Google Sheet. Please check the URL and sheet format.' });
    }
});


// 8. START THE SERVER
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});


// ===== Connected Accounts Linking Routes =====

// Start Discord linking (stateless)
app.get('/auth/discord/start', authMiddleware, (req, res) => {
  if (!ENABLE_DISCORD) return res.status(501).json({ message: 'Discord linking not configured.' });
  const state = makeLinkState(req.user._id, 'discord');
  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    response_type: 'code',
    scope: 'identify',
    redirect_uri: `${process.env.OAUTH_BASE_URL}/api/auth/discord/callback`,
    state
  });
  const discordAuthUrl = `https://discord.com/api/oauth2/authorize?${params.toString()}`;
  res.json({ redirectUrl: discordAuthUrl });
});

// Discord callback
app.get('/api/auth/discord/callback', async (req, res, next) => {
  if (!ENABLE_DISCORD) return res.status(501).send('Discord linking not configured');
  try {
    const { state } = req.query;
    if (!state) return res.status(400).send('Missing state');
    let decoded;
    try { decoded = verifyLinkState(state); } catch { return res.status(400).send('State expired or invalid'); }
    if (decoded.typ !== 'link' || decoded.provider !== 'discord') return res.status(400).send('Invalid state');

    passport.authenticate('discord-link', { session: false }, async (err, data) => {
      if (err || !data?.profile) return res.status(400).send('Discord auth failed');
      const profile = data.profile;
      const discordId = profile.id;
      const username = `${profile.username}${profile.discriminator ? '#' + profile.discriminator : ''}`;

      const user = await User.findById(decoded.uid);
      if (!user) return res.status(404).send('User not found');

      user.connectedAccounts = user.connectedAccounts || [];
      const existing = user.connectedAccounts.find(a => a.provider === 'discord');
      const payload = {
        provider: 'discord',
        externalId: discordId,
        username,
        url: `https://discord.com/users/${discordId}`,
        verified: true,
        linkedAt: new Date(),
        meta: { avatar: profile.avatar }
      };
      if (existing) { Object.assign(existing, payload); } else { user.connectedAccounts.push(payload); }
      if (!user.discord) user.discord = username; // optional mirror
      await user.save();

      const redirectTo = process.env.POST_LINK_REDIRECT || '/';
      res.redirect(redirectTo);
    })(req, res, next);
  } catch (e) {
    console.error('Discord link callback error', e);
    res.status(500).send('Linking failed');
  }
});

// List connected accounts
app.get('/api/me/links', authMiddleware, async (req, res) => {
  const me = await User.findById(req.user._id).select('connectedAccounts discord ifc youtube');
  if (!me) return res.status(404).json({ message: 'User not found' });
  res.json({ connectedAccounts: me.connectedAccounts || [], legacy: { discord: me.discord, ifc: me.ifc, youtube: me.youtube } });
});

// Manually add/update a link (unverified)
app.post('/api/me/links', authMiddleware, async (req, res) => {
  const { provider, externalId, username, url } = req.body || {};
  const allowed = ['ifc','vatsim','ivao','infiniteflight','youtube','google','discord'];
  if (!allowed.includes(provider)) return res.status(400).json({ message: 'Unsupported provider' });
  if (!externalId && !username && !url) return res.status(400).json({ message: 'Provide at least one of externalId, username, or url' });

  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  user.connectedAccounts = user.connectedAccounts || [];

  let entry = user.connectedAccounts.find(a => a.provider === provider);
  if (!entry) {
    entry = { provider, externalId: externalId || '', username: username || '', url: url || '', verified: false, linkedAt: new Date(), meta: {} };
    user.connectedAccounts.push(entry);
  } else {
    if (externalId != null) entry.externalId = externalId;
    if (username   != null) entry.username  = username;
    if (url        != null) entry.url       = url;
    entry.verified = entry.verified && provider !== 'ifc' ? entry.verified : false;
    entry.linkedAt = new Date();
  }
  await user.save();
  res.json({ message: 'Account link saved', connectedAccounts: user.connectedAccounts });
});

// Unlink
app.delete('/api/me/links/:provider', authMiddleware, async (req, res) => {
  const provider = req.params.provider;
  const user = await User.findById(req.user._id);
  if (!user) return res.status(404).json({ message: 'User not found' });
  const before = (user.connectedAccounts || []).length;
  user.connectedAccounts = (user.connectedAccounts || []).filter(a => a.provider !== provider);
  await user.save();
  res.json({ message: before === (user.connectedAccounts || []).length ? 'No link found for provider' : 'Unlinked successfully' });
});