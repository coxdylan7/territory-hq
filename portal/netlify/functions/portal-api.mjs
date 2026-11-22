// Territory Portal API on Netlify: same Express app, no listening socket.
import serverless from 'serverless-http';
import { withLambda } from '@netlify/aws-lambda-compat';
import server from '../../api/src/server.js';
import { makeLambdaHandler } from '../../../netlify/lib/api-adapter.mjs';

const app = server.getApp({ serveWeb: false });
const expressLambda = serverless(app, { requestId: false, binary: false });

export default withLambda(makeLambdaHandler(expressLambda, 'portal-api'));
