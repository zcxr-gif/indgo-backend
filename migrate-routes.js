// migrate-routes.js
// A one-time script to export routes from Google Sheets into your DynamoDB table.

// 1. IMPORT DEPENDENCIES
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');
const { google } = require('googleapis');
const Papa = require('papaparse');
const axios = require('axios');
require('dotenv').config();

// 2. INITIALIZE AWS DYNAMODB CLIENT
const ddb = new DynamoDBClient({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});
const ddbDoc = DynamoDBDocumentClient.from(ddb);
const ROUTES_TABLE = process.env.DDB_ROUTES_TABLE || 'Routes';

// 3. HELPER FUNCTIONS (Copied from your server.js)
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

const extractIcao = (text) => text ? (text.match(/^\s*([A-Z]{4})/) || [])[1] || null : null;

const deduceRankFromAircraft = (acStr) => {
    const s = String(acStr || '').toUpperCase();
    if (!s) return 'Unknown';
    const has = (pat) => new RegExp(pat, 'i').test(s);
    if (has('(DH8D|Q400|A320|B738)')) return 'IndGo Cadet';
    if (has('(A321|B737|B739)')) return 'Skyline Observer';
    if (has('(A330|B38M)')) return 'Route Explorer';
    if (has('(787-8|777-200LR)')) return 'Skyline Officer';
    if (has('(787-9|777-300ER)')) return 'Command Captain';
    if (has('A350')) return 'Elite Captain';
    if (has('(A380|747|744)')) return 'Blue Eagle';
    return 'IndGo Cadet'; // Default fallback
};

// 4. BATCH WRITING FUNCTION FOR DYNAMODB
async function batchWriteToDynamo(items, tableName) {
    const BATCH_SIZE = 25; // DynamoDB has a 25-item limit per batch write request
    console.log(`\nPreparing to write ${items.length} items to DynamoDB in batches of ${BATCH_SIZE}...`);

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const chunk = items.slice(i, i + BATCH_SIZE);
        const requestItems = chunk.map(item => ({
            PutRequest: { Item: item }
        }));

        const command = new BatchWriteCommand({
            RequestItems: { [tableName]: requestItems }
        });

        try {
            await ddbDoc.send(command);
            console.log(`Successfully wrote batch #${(i / BATCH_SIZE) + 1} (${chunk.length} items) to ${tableName}.`);
        } catch (error) {
            console.error(`Error writing batch to ${tableName}:`, JSON.stringify(error, null, 2));
        }
    }
    console.log('Batch writing complete.');
}

// 5. MAIN MIGRATION LOGIC
async function migrateRoutes() {
    console.log('Starting route migration from Google Sheets to DynamoDB...');

    const headerAliasesBase = { flightNumber: ['Flight No.', 'Flight Number', 'Callsign'], departure: ['Departure ICAO', 'Departure', 'Origin', 'From'], arrival: ['Arrival ICAO', 'Arrival', 'Destination', 'To'], aircraft: ['Aircraft(s)', 'Aircraft', 'Plane'], flightTime: ['Avg. Flight Time', 'Flight Time', 'Duration'] };
    const headerAliasesCodeshare = { ...headerAliasesBase, rankUnlock: ['Rank Unlock', 'Rank', 'Rank Required', 'Unlock Rank'], operator: ['Operator', 'Airline', 'Carrier', 'Virtual Airline'] };

    let allRoutesToSave = [];
    const primaryUrls = (process.env.ROUTES_SHEET_URL || '').split(',').filter(Boolean);
    const codeshareUrls = (process.env.CODESHARE_SHEET_URLS || '').split(',').filter(Boolean);
    const allUrls = [...primaryUrls, ...codeshareUrls];

    if (allUrls.length === 0) {
        console.error('ERROR: No ROUTES_SHEET_URL or CODESHARE_SHEET_URLS found in your .env file. Aborting.');
        return;
    }

    for (const url of allUrls) {
        const isCodeshare = codeshareUrls.map(s => s.trim()).includes(url.trim());
        const headerAliases = isCodeshare ? headerAliasesCodeshare : headerAliasesBase;
        const canonicalKeys = Object.keys(headerAliases);
        try {
            console.log(`\nFetching routes from: ${url.substring(0, 80)}...`);
            const response = await axios.get(url.trim());
            const parsed = Papa.parse(response.data, { header: false, skipEmptyLines: true });
            if (!parsed.data || parsed.data.length === 0) {
                console.log('- Sheet is empty or could not be parsed. Skipping.');
                continue;
            }

            let headerRowIndex = -1;
            let columnMap = {};
            for (let i = 0; i < parsed.data.length; i++) {
                const row = parsed.data[i];
                const tempMap = {};
                row.forEach((cell, index) => {
                    const header = cell.trim().toLowerCase();
                    if (!header) return;
                    for (const key of canonicalKeys) {
                        if (headerAliases[key].some(alias => alias.toLowerCase() === header)) {
                            tempMap[key] = index;
                            break;
                        }
                    }
                });
                if (Object.keys(tempMap).length >= canonicalKeys.length) { // Made this check more flexible
                    columnMap = tempMap;
                    headerRowIndex = i;
                    console.log(`- Found a valid header row at index ${i}.`);
                    break;
                }
            }
            if (headerRowIndex === -1) {
                console.warn(`- WARNING: Could not find a valid header row in sheet: ${url}. Skipping this sheet.`);
                continue;
            }

            const routesFromSheet = parsed.data.slice(headerRowIndex + 1).map(row => {
                const aircraft = row[columnMap.aircraft]?.trim();
                const item = {
                    flightNumber: row[columnMap.flightNumber]?.trim(),
                    departure: extractIcao(row[columnMap.departure]),
                    arrival: extractIcao(row[columnMap.arrival]),
                    aircraft: aircraft,
                    flightTime: convertTimeToDecimal(row[columnMap.flightTime]),
                    operator: isCodeshare ? row[columnMap.operator]?.trim() : 'IndGo Air Virtual',
                    rankUnlock: isCodeshare ? row[columnMap.rankUnlock]?.trim() : deduceRankFromAircraft(aircraft),
                    type: isCodeshare ? 'codeshare' : 'primary'
                };

                // Validate the created item to ensure it's usable
                if (item.flightNumber && item.departure && item.arrival && item.aircraft && item.flightTime > 0) {
                    return item;
                }
                return null;
            }).filter(Boolean); // Filter out any null (invalid) items

            allRoutesToSave.push(...routesFromSheet);
            console.log(`- Found ${routesFromSheet.length} valid routes in this sheet.`);

        } catch (error) {
            console.error(`- ERROR: Failed to process URL ${url}:`, error.message);
        }
    }

    if (allRoutesToSave.length > 0) {
        console.log(`\nTotal valid routes found from all sources: ${allRoutesToSave.length}`);
        await batchWriteToDynamo(allRoutesToSave, ROUTES_TABLE);
        console.log('\n✅ Migration finished successfully!');
    } else {
        console.warn('\n⚠️ Migration finished, but no valid routes were found to save to DynamoDB.');
    }
}

// 6. EXECUTE THE SCRIPT
migrateRoutes();