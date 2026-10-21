import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { openApiDocument } from '../docs/openapi.js';

export const docsRouter = Router();

// Raw OpenAPI document (for tools and code generators).
docsRouter.get('/openapi.json', (_req, res) => {
  res.json(openApiDocument);
});

// Swagger UI. "Authorize" accepts the accessToken from /api/auth/login;
// persistAuthorization keeps it across page reloads in this browser only.
docsRouter.use(
  '/',
  swaggerUi.serve,
  swaggerUi.setup(openApiDocument as unknown as swaggerUi.JsonObject, {
    customSiteTitle: 'WorthShare API',
    swaggerOptions: { persistAuthorization: true },
  }),
);
