// flightUtils.js
const mongoose = require('mongoose');
const Pirep = require('./models/Pirep');
const User = require('./models/User');
const Roster = require('./models/Roster');

// This function is in its own file because it's used by BOTH:
// 1. The manual /arrive endpoint in server.js
// 2. The automated tracker in if-tracker.js

/**
 * Deduces a required rank based on an aircraft string.
 * @param {string} acStr - The aircraft type string.
 * @returns {string} The deduced rank.
 */
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
    return 'Unknown';
};

/**
 * Reusable logic to finalize a flight, create a PIREP, and update user.
 * @param {mongoose.Document} flightPlan - The flight plan document to finalize.
 * @param {string} [remarks=null] - Optional remarks for the PIREP.
 * @param {string} [verificationImageUrl=null] - Optional image URL.
 * @returns {Promise<mongoose.Document>} The newly created PIREP document.
 */
const finalizeFlightAndCreatePirep = async (flightPlan, remarks = null, verificationImageUrl = null) => {
    // 1. Update Flight Plan status and times
    flightPlan.status = 'COMPLETED';
    if (!flightPlan.actualDepartureTime) {
        flightPlan.actualDepartureTime = flightPlan.etd; // Fallback for safety
    }
    flightPlan.actualArrivalTime = Date.now();
    const flightTimeHours = (flightPlan.actualArrivalTime - flightPlan.actualDepartureTime) / (1000 * 60 * 60);

    // 2. Prepare PIREP data
    const newPirepData = {
        pilot: flightPlan.pilot,
        flightNumber: flightPlan.flightNumber,
        departure: flightPlan.departure,
        arrival: flightPlan.arrival,
        aircraft: flightPlan.aircraft,
        flightTime: parseFloat(flightTimeHours.toFixed(2)),
        remarks,
        verificationImageUrl,
        status: 'PENDING',
        isMultiplierEligible: false,
    };

    // 3. Check for roster details and multipliers
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
        // For non-roster flights
        newPirepData.rankUnlock = deduceRankFromAircraft(flightPlan.aircraft);
        newPirepData.operator = 'IndGo Air Virtual';
    }

    // 4. Create and save the PIREP
    const newPirep = new Pirep(newPirepData);
    await newPirep.save();

    // 5. Update the user to remove the current flight plan link
    await User.updateOne({ _id: flightPlan.pilot }, { $set: { currentFlightPlan: null } });
    await flightPlan.save();

    console.log(`PIREP automatically generated for flight ${flightPlan.flightNumber}.`);
    
    return newPirep;
};

module.exports = {
    deduceRankFromAircraft,
    finalizeFlightAndCreatePirep
};