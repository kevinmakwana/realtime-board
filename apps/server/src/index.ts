import { loadConfig } from './config.js';
import { createServerInstance } from './server.js';

for (const file of ['.env', '../../.env']) {
  try {
    process.loadEnvFile(file); // never overrides variables already set in the environment
  } catch {
    /* no .env here */
  }
}

const config = loadConfig();
const log = (m: string) => console.log(m);

const instance = await createServerInstance(config, log);

const shutdown = async (signal: string) => {
  log(`[${config.INSTANCE_ID}] ${signal} received, shutting down`);
  await instance.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
