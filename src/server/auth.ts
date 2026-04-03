import crypto from "node:crypto";

export async function hashPassword(password: string, salt?: string) {
  const passwordSalt = salt || crypto.randomBytes(16).toString("hex");
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, passwordSalt, 64, (error, value) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    });
  });

  return {
    passwordSalt,
    passwordHash: derived.toString("hex")
  };
}

export async function verifyPassword(
  password: string,
  expectedHash: string,
  salt: string
) {
  const result = await hashPassword(password, salt);
  return crypto.timingSafeEqual(
    Buffer.from(result.passwordHash, "hex"),
    Buffer.from(expectedHash, "hex")
  );
}

export function createSessionId() {
  return crypto.randomBytes(32).toString("hex");
}
