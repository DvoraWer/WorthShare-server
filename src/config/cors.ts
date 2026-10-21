import type { CorsOptions } from 'cors';
import { env } from './env.js';

// Only origins listed in CORS_ALLOWED_ORIGINS are allowed. Requests without an
// Origin header (curl, server-to-server, same-origin) are not affected by CORS.
export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin || env.CORS_ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
