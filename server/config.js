export function runtimeConfig(env = process.env) {
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const codespaces = env.CODESPACES === 'true';
  let defaultOrigin = `http://localhost:${port}`;
  if (codespaces) {
    const name = env.CODESPACE_NAME;
    const domain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev';
    if (!/^[a-zA-Z0-9-]+$/.test(name || '') || !/^[a-zA-Z0-9.-]+$/.test(domain)) throw new Error('Codespaces forwarding environment is incomplete.');
    defaultOrigin = `https://${name}-${port}.${domain}`;
  }
  const origin = new URL(env.APP_ORIGIN || defaultOrigin).origin;
  if (!/^https?:\/\//.test(origin)) throw new Error('APP_ORIGIN must be an HTTP or HTTPS URL.');
  if (env.NODE_ENV === 'production' && !origin.startsWith('https://')) throw new Error('Production requires an HTTPS APP_ORIGIN.');
  return {
    port, host: env.HOST || '127.0.0.1', origin,
    secureCookies: origin.startsWith('https://'),
    // Codespaces can rewrite Host to the local destination. Only direct loopback
    // connections may use these aliases; browser Origin verification stays strict.
    localProxyHosts: codespaces ? [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`] : []
  };
}
