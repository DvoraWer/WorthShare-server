import cors from 'cors';
import express from 'express';
import { corsOptions } from './config/cors.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { adminCategoriesRouter } from './routes/adminCategories.js';
import { adminRecommendationsRouter } from './routes/adminRecommendations.js';
import { adminUsersRouter } from './routes/adminUsers.js';
import { authRouter } from './routes/auth.js';
import { categoriesRouter } from './routes/categories.js';
import { docsRouter } from './routes/docs.js';
import { healthRouter } from './routes/health.js';
import { recommendationsRouter } from './routes/recommendations.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors(corsOptions));
  app.use(express.json({ limit: '100kb' }));

  app.use('/api/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/recommendations', recommendationsRouter);
  app.use('/api/admin/recommendations', adminRecommendationsRouter);
  app.use('/api/admin/categories', adminCategoriesRouter);
  app.use('/api/admin/users', adminUsersRouter);
  app.use('/api/docs', docsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
