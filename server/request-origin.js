const loopbacks = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isAllowedRequestOrigin(req, expectedOrigin, localProxyHosts = []) {
  const incoming = req.headers.origin;
  if (!incoming || incoming === expectedOrigin) return true;

  // Codespaces forwarding may rewrite Origin as well as Host. Accept only
  // known loopback aliases from the local proxy, with the browser's same-origin
  // metadata and explicit public origin intact. Ordinary hosting is unchanged.
  if (!localProxyHosts.length || !loopbacks.has(req.socket.remoteAddress)) return false;
  if (req.headers['sec-fetch-site'] !== 'same-origin') return false;
  if (req.headers['x-studio-origin'] !== expectedOrigin) return false;
  let origin;
  try { origin = new URL(incoming); } catch { return false; }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== incoming) return false;
  const aliases = new Set(localProxyHosts);
  // Some forwarding layers omit the internal port when rewriting Origin.
  for (const host of localProxyHosts) {
    const url = new URL(`http://${host}`);
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) aliases.add(url.hostname);
  }
  return aliases.has(origin.host);
}
