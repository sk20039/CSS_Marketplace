'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// Derive a 32-byte AES key from TOTP_ENCRYPTION_KEY by hashing it.
// SHA-256 gives a consistent 32-byte key regardless of input length.
function getEncryptionKey() {
  const keyStr = process.env.TOTP_ENCRYPTION_KEY || '';
  if (!keyStr) throw new Error('TOTP_ENCRYPTION_KEY is not set');
  return crypto.createHash('sha256').update(keyStr).digest();
}

// Encrypt a TOTP secret (Base32 string) with AES-256-GCM.
// Returns: "<iv_hex>:<ciphertext_hex>:<tag_hex>"
function encryptSecret(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

// Decrypt an AES-256-GCM encrypted TOTP secret.
function decryptSecret(ciphertext) {
  const key = getEncryptionKey();
  const [ivHex, encHex, tagHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// Characters for recovery codes — no ambiguous chars (0/O, 1/l/I).
const RECOVERY_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

// Generate 8 random 10-character recovery codes.
function generateRecoveryCodes() {
  return Array.from({ length: 8 }, () =>
    Array.from({ length: 10 }, () =>
      RECOVERY_CHARS[crypto.randomInt(RECOVERY_CHARS.length)]
    ).join('')
  );
}

async function hashRecoveryCode(code) {
  return bcrypt.hash(code, 10);
}

async function verifyRecoveryCode(code, hash) {
  return bcrypt.compare(code, hash);
}

module.exports = { encryptSecret, decryptSecret, generateRecoveryCodes, hashRecoveryCode, verifyRecoveryCode };
