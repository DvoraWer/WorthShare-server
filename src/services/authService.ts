import { randomBytes } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { safeUserSelect, toSafeUser, type SafeUserDto } from '../dto/user.js';
import { Prisma } from '../generated/prisma/client.js';
import { AppError } from '../utils/AppError.js';
import { accessTokenTtlSeconds, signAccessToken } from '../utils/jwt.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import type { LoginInput, RegisterInput } from '../validation/auth.js';

export interface AuthResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: SafeUserDto;
}

const INVALID_CREDENTIALS = 'Invalid email or password.';

// Compared against when the email is unknown, so response time does not
// reveal whether an account exists. Created lazily on first use.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword(randomBytes(32).toString('hex')));

async function buildAuthResponse(user: SafeUserDto): Promise<AuthResponse> {
  return {
    accessToken: await signAccessToken(user.id),
    tokenType: 'Bearer',
    expiresIn: accessTokenTtlSeconds,
    user: toSafeUser(user),
  };
}

export async function register(input: RegisterInput): Promise<AuthResponse> {
  const passwordHash = await hashPassword(input.password);
  try {
    const user = await prisma.user.create({
      // Role and status always come from database defaults (User, active).
      data: { fullName: input.fullName, email: input.email, passwordHash },
      select: safeUserSelect,
    });
    return buildAuthResponse(user);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw AppError.conflict('An account with this email already exists.');
    }
    throw error;
  }
}

export async function login(input: LoginInput): Promise<AuthResponse> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    select: { ...safeUserSelect, passwordHash: true, isActive: true },
  });

  const passwordMatches = await verifyPassword(
    input.password,
    user?.passwordHash ?? (await getDummyHash()),
  );

  // One generic message for unknown email, wrong password and inactive account.
  if (!user || !passwordMatches || !user.isActive) {
    throw AppError.unauthorized(INVALID_CREDENTIALS);
  }
  return buildAuthResponse(user);
}
