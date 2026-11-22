// Application-wide response headers. The policy is intentionally narrow:
// inline styles are allowed because the React apps use style={{...}} on many
// elements, and the third-party sources below are the ones the apps actually
// need (Leaflet tiles, Google Maps API, Google Fonts, NY Open Data, Nominatim,
// OSRM). There is no inline/eval script allowance: Vite emits external module
// scripts and the report print call is made from the opener, not inline markup.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' https://maps.googleapis.com https://maps.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org https://maps.googleapis.com https://maps.gstatic.com https://*.googleusercontent.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://data.ny.gov https://nominatim.openstreetmap.org https://router.project-osrm.org https://maps.googleapis.com",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

function securityHeadersMiddleware(headers = SECURITY_HEADERS) {
  return (req, res, next) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    return next();
  };
}

module.exports = { CONTENT_SECURITY_POLICY, SECURITY_HEADERS, securityHeadersMiddleware };
