// infiniteFlightService.js
const axios = require('axios');

const apiKey = process.env.INFINITE_FLIGHT_API_KEY;
const api = axios.create({
    baseURL: 'https://api.infiniteflight.com/public/v2',
    headers: {
        'Authorization': `Bearer ${apiKey}`
    }
});

/**
 * Fetches all active server sessions (Training, Expert, etc.).
 * @returns {Promise<Array>} A list of session objects.
 */
exports.getSessions = async () => {
    try {
        const response = await api.get('/sessions');
        // Filter for Training and Expert servers
        return response.data.result.filter(s =>
            s.name && (s.name.toLowerCase().includes('training') || s.name.toLowerCase().includes('expert'))
        );
    } catch (error) {
        console.error('Error fetching sessions:', error.message);
        throw new Error('Failed to fetch sessions from Infinite Flight.');
    }
};

/**
 * Fetches all flights for a specific session ID.
 * @param {string} sessionId - The ID of the server session.
 * @returns {Promise<Array>} A list of flight objects for the session.
 */
exports.getFlightsForSession = async (sessionId) => {
    try {
        // Fetch aircraft data to map IDs to names
        const aircraftResponse = await api.get('/aircraft');
        const aircraftMap = new Map(aircraftResponse.data.result.map(ac => [ac.id, ac.name]));

        // Fetch flight data for the session
        const flightsResponse = await api.get(`/sessions/${sessionId}/flights`);
        
        // Map flight data and enrich it with the aircraft name
        return flightsResponse.data.result.map(f => ({
            flightId: f.flightId,
            latitude: f.latitude,
            longitude: f.longitude,
            heading: f.heading,
            callsign: f.callsign,
            aircraftName: aircraftMap.get(f.aircraftId) || "Unknown Aircraft",
            username: f.username,
            altitude: f.altitude,
            speed: f.speed,
            originAirport: f.originAirport,
            destinationAirport: f.destinationAirport
        }));
    } catch (error) {
        console.error(`Error fetching flights for session ${sessionId}:`, error.message);
        throw new Error('Failed to fetch flights from Infinite Flight.');
    }
};

/**
 * Fetches the flight plan for a specific flight.
 * @param {string} sessionId - The ID of the server session.
 * @param {string} flightId - The ID of the flight.
 * @returns {Promise<Object>} The flight plan data.
 */
exports.getFlightPlan = async (sessionId, flightId) => {
    try {
        const response = await api.get(`/sessions/${sessionId}/flights/${flightId}/flightplan`);
        return response.data; // The API returns the whole object including 'result'
    } catch (error) {
        console.error(`Error fetching flight plan for flight ${flightId}:`, error.message);
        throw new Error('Failed to fetch flight plan from Infinite Flight.');
    }
};

/**
 * Fetches ALL live flights across ALL sessions. Used by the tracker.
 * @returns {Promise<Array>} A list of all currently active flights.
 */
exports.getAllLiveFlights = async () => {
    try {
        const response = await api.get('/flights');
        return response.data.result;
    } catch (error) {
        console.error('Error fetching all live flights:', error.message);
        throw new Error('Failed to fetch all live flights from Infinite Flight.');
    }
};