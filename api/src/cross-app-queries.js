// SQL-facing helpers for owner-scoped cross-app reads.
// Every query is parameterized and refuses to build SQL without an owner id.
function requireOwnerScope(ownerUserId) {
  if (typeof ownerUserId !== 'string' || !ownerUserId.trim()) {
    throw new TypeError('ownerUserId is required for cross-app queries');
  }
  return ownerUserId;
}

function licenseFilter(license, values) {
  if (typeof license !== 'string' || !license) return '';
  values.push(license);
  return '\n    AND license_number = $' + values.length;
}

function creditsBalancesQuery(ownerUserId, license) {
  const owner = requireOwnerScope(ownerUserId);
  const values = [owner];
  const licenseClause = licenseFilter(license, values);

  return {
    text: `SELECT account_id, account_name, license_number, city,
       SUM(amount)::float AS balance
    FROM credits
    WHERE user_id = $1${licenseClause}
    GROUP BY account_id, account_name, license_number, city`,
    values,
  };
}

function sharedMessagesQuery(ownerUserId, license) {
  const owner = requireOwnerScope(ownerUserId);
  const values = [owner];
  const licenseClause = licenseFilter(license, values);

  return {
    text: `SELECT id, account_id, account_name, license_number, city,
       channel, purpose, body, recipient, direction, date, status
    FROM messages
    WHERE user_id = $1${licenseClause}
    ORDER BY date DESC`,
    values,
  };
}

module.exports = { creditsBalancesQuery, sharedMessagesQuery };
