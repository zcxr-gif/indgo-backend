/**
 * ifGrade.js — resolve an Infinite Flight stats block to the grade number a
 * pilot actually holds.
 *
 * The Live API's `gradeDetails.gradeIndex` is an index into
 * `gradeDetails.grades` — grades[0] is "Grade 1", grades[4] is "Grade 5" — so
 * reading it as the grade reports every pilot one grade too low. That matters
 * here beyond cosmetics: it is the number VA join requirements are gated on,
 * so a Grade 3 pilot gets turned away from a Grade 3+ crew center.
 *
 * Resolution order:
 *   1. grades[gradeIndex].name — the API's own label.
 *   2. gradeIndex + 1 — the same mapping when the grades array wasn't sent.
 *   3. An explicit `grade` / `calculatedGrade` field, which POST /users and
 *      the acars backend both return already resolved to 1-5.
 */

function numeric(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * @param {object|null} stats a GradeInfo/UserStats block, or a gradeDetails
 *        object on its own.
 * @returns {number|null} the grade, or null when nothing identifies one.
 */
function resolveGrade(stats) {
    if (!stats) return null;

    const details = stats.gradeDetails || stats;
    const idx = numeric(details && details.gradeIndex);
    if (idx !== null && idx >= 0) {
        const name = details.grades && details.grades[idx] && details.grades[idx].name;
        const digits = typeof name === 'string' ? name.match(/\d+/) : null;
        return digits ? Number(digits[0]) : idx + 1;
    }

    const explicit = numeric(stats.grade);
    return explicit !== null ? explicit : numeric(stats.calculatedGrade);
}

module.exports = { resolveGrade };
