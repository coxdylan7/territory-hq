// Territory HQ API on Netlify: web-standard Request -> Lambda-style event ->
// the same Express app used by Docker/local development -> web Response.
import serverless from 'serverless-http';
import { withLambda } from '@netlify/aws-lambda-compat';
import server from '../../api/src/server.js';
import { makeLambdaHandler } from '../lib/api-adapter.mjs';

// Netlify serves web/dist from the CDN; the function must never fall back to it.
const app = server.getApp({ serveWeb: false });
const expressLambda = serverless(app, { requestId: false, binary: false });

export default withLambda(makeLambdaHandler(expressLambda, 'hq-api'));
