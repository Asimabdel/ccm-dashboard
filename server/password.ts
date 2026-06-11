import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 10;

/** Hash a plaintext password with bcrypt. */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/** Verify a plaintext password against a stored bcrypt hash. */
export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/**
 * Validate password strength. Returns an error message string if invalid, or null if OK.
 * Minimum policy suitable for a HIPAA-adjacent internal tool: >= 8 chars, with letters and numbers.
 */
export function validatePasswordStrength(plain: string): string | null {
  if (typeof plain !== "string" || plain.length < 8) {
    return "Password must be at least 8 characters long.";
  }
  if (plain.length > 128) {
    return "Password must be at most 128 characters long.";
  }
  if (!/[A-Za-z]/.test(plain) || !/[0-9]/.test(plain)) {
    return "Password must include at least one letter and one number.";
  }
  return null;
}
