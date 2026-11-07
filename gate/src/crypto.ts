import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = (s: string) => createHash("sha256").update(s).digest();

// scrypt is in node itself: no native module to compile on an ARM board. N=2^15
// costs 32 MB and roughly a tenth of a second per check on a small ARM core,
// which is the budget a login can afford on a 4 GB machine. The parameters are
// stored with each hash, so raising them later only affects new passwords.
const N = 32768;
const R = 8;
const P = 3;
const KEYLEN = 32;
const MAXMEM = 96 * 1024 * 1024;
let deriving = 0;
const waiting: (() => void)[] = [];
export class PasswordBusyError extends Error {}

async function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  if (deriving >= 2) {
    if (waiting.length >= 8) throw new PasswordBusyError("password service busy; try again shortly");
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else deriving++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
    scrypt(password.normalize("NFKC"), salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
    );
  } finally {
    const next = waiting.shift();
    if (next) next(); else deriving--;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export const passwordNeedsRehash = (stored: string) => !stored.startsWith(`scrypt$${N}$${R}$${P}$`);

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (password.length > 1024 || password.normalize("NFKC").length > 200) return false;
  const [algo, n, r, p, salt, key] = stored.split("$");
  if (algo !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), Number(n), Number(r), Number(p));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Checked when the login matches no account, so a wrong username takes as long
// as a wrong password and the response time does not reveal who has an account.
let dummy: Promise<string> | null = null;
export async function burnTime(password: string) {
  dummy ??= hashPassword(randomToken()).catch((err) => { dummy = null; throw err; });
  await verifyPassword(password, await dummy);
}

// a short list of the passwords every guessing tool tries first
const COMMON = new Set([
  "password", "password1", "password123", "1234567890", "12345678910", "qwertyuiop",
  "azertyuiop", "motdepasse", "iloveyou12", "letmein123", "welcome123", "admin12345",
  "administrator", "passw0rd123", "1q2w3e4r5t", "qwerty1234", "0123456789", "abcdefghij",
  "trustno1234", "football12", "baseball12", "sunshine12", "princess12", "dragon1234",
]);

export function passwordProblem(password: string, username: string): string | null {
  password = password.normalize("NFKC");
  if (password.length < 10) return "pwTooShort";
  if (password.length > 200) return "pwTooLong";
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || lower === username.toLowerCase()) return "pwTooCommon";
  return null;
}
