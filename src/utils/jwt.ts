import { errors, jwtVerify, SignJWT } from 'jose';
import { env } from '../config/env.js';

// Tokens identify the user only (`sub`). Role and account status are always
// read from the database per request, never trusted from the token.
const ALGORITHM = 'HS256';
const ISSUER = 'worthshare-api';
const AUDIENCE = 'worthshare-client';
const secret = new TextEncoder().encode(env.JWT_SECRET);

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 } as const;

export const accessTokenTtlSeconds = (() => {
  const match = /^(\d+)([smhd])$/.exec(env.JWT_EXPIRES_IN)!;
  return Number(match[1]) * UNIT_SECONDS[match[2] as keyof typeof UNIT_SECONDS];
})();

export function signAccessToken(userId: number): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setSubject(String(userId))
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${accessTokenTtlSeconds}s`)
    .sign(secret);
}

/** Returns the user id from a valid token, or null for any invalid/expired token. */
export async function verifyAccessToken(token: string): Promise<number | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: [ALGORITHM],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    const id = Number(payload.sub);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch (error) {
    if (error instanceof errors.JOSEError) return null;
    throw error;
  }
}
