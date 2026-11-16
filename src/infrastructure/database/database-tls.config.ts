export function databaseTlsConfig(env: NodeJS.ProcessEnv = process.env) {
  return env.DB_SSL === 'true'
    ? { rejectUnauthorized: true, ...(env.DB_SSL_CA ? { ca: env.DB_SSL_CA } : {}) }
    : false;
}
