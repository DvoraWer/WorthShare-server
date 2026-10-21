import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { login, register } from '../services/authService.js';
import { loginSchema, registerSchema, type LoginInput, type RegisterInput } from '../validation/auth.js';

export const authRouter = Router();

authRouter.post('/register', validateBody(registerSchema), async (req, res) => {
  res.status(201).json(await register(req.body as RegisterInput));
});

authRouter.post('/login', validateBody(loginSchema), async (req, res) => {
  res.status(200).json(await login(req.body as LoginInput));
});

authRouter.get('/me', authenticate, (req, res) => {
  res.status(200).json({ user: req.user });
});
