import jwt from "jsonwebtoken";
import { envStore } from "../env-store";

export interface TokenPayload {
  userId: string;
  name: string;
  email: string;
  role: string;
  team: string;
  platformAccess: string;
}

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, envStore.JWT_SECRET, {
    expiresIn: envStore.JWT_EXPIRY,
  } as jwt.SignOptions);
}

export function verifyToken(token: string): TokenPayload {
  return jwt.verify(token, envStore.JWT_SECRET) as TokenPayload;
}
