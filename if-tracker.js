// if-tracker.js
const mongoose = require('mongoose');
const { getAllLiveFlights } = require('./infiniteFlightService');
const { finalizeFlightAndCreatePirep } = require('./flightUtils'); // Import the shared helper

// Import your database models
const FlightPlan = require('./models/FlightPlan');

const checkFlights = async () => {
    console.log('[IF Tracker] Checking Infinite Flight API for active flights...');
    try {
        // 1. Fetch ALL live flights using our service
        const liveFlights = await getAllLiveFlights();
        // Create a Set of active usernames from the API for fast lookups
        const liveUsernames = new Set(liveFlights.map(f => f.username));

        // 2. Get all our flight plans that are currently 'FLYING'
        // Populate the pilot's 'infiniteFlightUsername' field
        const activePlans = await FlightPlan.find({ status: 'FLYING' })
            .populate('pilot', 'callsign infiniteFlightUsername');
        
        if (activePlans.length === 0) {
            console.log('[IF Tracker] No active flight plans to track.');
            return;
        }

        console.log(`[IF Tracker] Tracking ${activePlans.length} plans against ${liveUsernames.size} live users.`);

        // 3. Compare our active plans with the live flights by username
        for (const plan of activePlans) {
            // Ensure pilot object exists
            if (!plan.pilot) {
                console.warn(`[IF Tracker] Skipping plan ${plan._id} due to missing pilot data.`);
                continue;
            }

            // Get the pilot's registered Infinite Flight username from their profile
            const pilotUsername = plan.pilot.infiniteFlightUsername;

            // Skip tracking if the pilot hasn't set their IF username in their profile
            if (!pilotUsername) {
                console.warn(`[IF Tracker] Skipping plan for ${plan.pilot.callsign} because they have no IF username set.`);
                continue;
            }

            // If the pilot's username is NOT in the live flight list, they have landed.
            if (!liveUsernames.has(pilotUsername)) {
                console.log(`[IF Tracker] Pilot ${pilotUsername} (Flight ${plan.flightNumber}) is no longer live. Finalizing flight...`);
                
                // Use the shared helper function to finalize the flight and create the PIREP
                await finalizeFlightAndCreatePirep(
                    plan,
                    "Flight automatically finalized by the Infinite Flight Live Tracker.",
                    null // No verification image for automated finalization
                );

                console.log(`[IF Tracker] PIREP finalized for ${pilotUsername}.`);
            } else {
                console.log(`[IF Tracker] Pilot ${pilotUsername} is still in the air.`);
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