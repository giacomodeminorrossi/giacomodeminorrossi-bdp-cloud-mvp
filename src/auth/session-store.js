import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');

function safeUserId(userId) {
  return String(userId || 'default').replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 120) || 'default';
}

function sessionPath(userId) {
  return path.join(SESSION_DIR, `${safeUserId(userId)}.json.enc`);
}

function encryptionKey() {
  const raw = process.env.SESSION_ENCRYPTION_KEY;
  if (!raw) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_ENCRYPTION_KEY is required in production. Use a base64-encoded 32-byte key.');
    }
    return crypto.createHash('sha256').update('dev-session-key-change-me').digest();
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('SESSION_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  return key;
}

function encryptJson(value) {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function decryptJson(payload) {
  const raw = Buffer.from(payload, 'base64');
  if (raw.length < 29) throw new Error('Encrypted session payload is invalid.');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

export async function saveStoredSession(userId, storageState) {
  await fs.mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
  const wrapped = {
    savedAt: new Date().toISOString(),
    storageState
  };
  await fs.writeFile(sessionPath(userId), encryptJson(wrapped), { mode: 0o600 });
  return { savedAt: wrapped.savedAt };
}

export async function loadStoredSession(userId) {
  try {
    const payload = await fs.readFile(sessionPath(userId), 'utf8');
    return decryptJson(payload).storageState;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export async function hasStoredSession(userId) {
  try {
    await fs.access(sessionPath(userId));
    return true;
  } catch {
    return false;
  }
}

export async function deleteStoredSession(userId) {
  try {
    await fs.unlink(sessionPath(userId));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}
