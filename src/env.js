/** Lädt die .env aus dem Projektordner, falls vorhanden. */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadEnvFile(path = resolve('.env')) {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}
