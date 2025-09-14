// if-tracker.js
const mongoose = require('mongoose');
const { getAllLiveFlights } = require('./infiniteFlightService'); // Use our new service

// Import your database models
const FlightPlan = require('./models/FlightPlan');
const Pirep = require('./models/Pirep');
const User = require('./models/User');

const checkFlights = async () => {
    console.log('Checking Infinite Flight API for active flights...');
    try {
        // 1. Fetch ALL live flights using our service
        const liveFlights = await getAllLiveFlights();

        // 2. Get all our flight plans that are currently 'FLYING'
        const activePlans = await FlightPlan.find({ status: 'FLYING' }).populate('pilot', 'callsign');
        
        if (activePlans.length === 0) {
            console.log('No active flight plans to track.');
            return;
        }

        console.log(`Tracking ${activePlans.length} plans against ${liveFlights.length} live flights.`);

        // 3. Compare our active plans with the live flights
        for (const plan of activePlans) {
            // Ensure pilot and callsign exist to prevent errors
            if (!plan.pilot || !plan.pilot.callsign) {
                console.warn(`Skipping plan ${plan._id} due to missing pilot or callsign.`);
                continue;
            }

            const pilotCallsign = plan.pilot.callsign;
            const liveFlight = liveFlights.find(f => f.callsign === pilotCallsign);

            if (liveFlight) {
                // The pilot is still flying.
                console.log(`Pilot ${pilotCallsign} is still in the air.`);
                // OPTIONAL: You could update the flight plan with current location
                // plan.lastKnownLatitude = liveFlight.latitude;
                // plan.lastKnownLongitude = liveFlight.longitude;
                // await plan.save();
            } else {
                // The pilot is NOT in the live flight list, meaning they have landed.
                console.log(`Pilot ${pilotCallsign} has landed. Finalizing PIREP...`);
                
                // Finalize the flight plan and create the PIREP
                plan.status = 'COMPLETED';
                plan.actualArrivalTime = new Date();
                await plan.save();
                
                // TODO: Add your logic to create and save a new PIREP here
                // const newPirep = new Pirep({ ... });
                // await newPirep.save();
                
                // TODO: Update user stats like flight time, etc.
                
                // Clear the user's current flight plan
                await User.updateOne({ _id: plan.pilot._id }, { $set: { currentFlightPlan: null } });
                console.log(`PIREP finalized for ${pilotCallsign}.`);
            }
        }

    } catch (error) {
        console.error('Error during flight check:', error.message);
    }
};

// This function is exported and called from your main server file (e.g., server.js)
const startFlightTracker = () => {
    console.log('🚀 Infinite Flight Tracker has been initialized.');
    // Run the check immediately, then run it every 2 minutes (120,000 milliseconds)
    checkFlights();
    setInterval(checkFlights, 120000); 
};

module.exports = { startFlightTracker };