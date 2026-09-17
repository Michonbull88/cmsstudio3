export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireValue(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}
function text(value, limit, field, required = false) {
  requireValue(typeof value === 'string' && value.length <= limit && (!required || value.trim()), `Invalid ${field}.`);
  return value;
}
function date(value, field) {
  requireValue(typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)), `Invalid ${field}.`);
  return new Date(value).toISOString();
}
function identifier(value) {
  requireValue(typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value), 'Invalid ID.');
  return value;
}
function choice(value, options, field) {
  requireValue(options.includes(value), `Invalid ${field}.`);
  return value;
}
export function settings(value) {
  requireValue(value && typeof value === 'object', 'Workspace details are required.');
  return { name: text(value.name, 80, 'display name', true).trim(), workspace: text(value.workspace, 80, 'workspace name', true).trim() };
}
export function entry(value) {
  requireValue(value && typeof value === 'object', 'Invalid content entry.');
  return {
    id: identifier(value.id), title: text(value.title, 200, 'title', true).trim(),
    excerpt: text(value.excerpt, 400, 'excerpt'), body: text(value.body, 200000, 'body'),
    type: choice(value.type, ['Article', 'Page', 'Newsletter'], 'content type'),
    status: choice(value.status, ['Draft', 'In review', 'Published', 'Scheduled'], 'status'),
    category: choice(value.category, ['Design', 'Product', 'Company', 'Engineering', 'Culture'], 'category'),
    date: date(value.date, 'publish date'), updated: date(value.updated, 'updated date')
  };
}
export function media(value) {
  requireValue(value && typeof value === 'object', 'Invalid media item.');
  const match = typeof value.data === 'string' && value.data.match(/^data:image\/(png|jpeg|gif|webp|avif);base64,([A-Za-z0-9+/]+={0,2})$/);
  requireValue(match && match[2].length <= 1400000, 'Upload a PNG, JPEG, GIF, WebP, or AVIF image under 1 MB.');
  const bytes = Buffer.from(match[2], 'base64');
  requireValue(bytes.length > 0 && bytes.length <= 1048576 && bytes.toString('base64') === match[2], 'Invalid image encoding.');
  const signatures = {
    png: () => bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')),
    jpeg: () => bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255,
    gif: () => ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6)),
    webp: () => bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP',
    avif: () => bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 32))
  };
  requireValue(signatures[match[1]](), 'Image contents do not match its file type.');
  return { id: identifier(value.id), name: text(value.name, 255, 'file name', true), size: bytes.length, data: value.data, date: date(value.date, 'upload date') };
}
export function workspace(value) {
  requireValue(value && value.version === 1, 'Unsupported workspace backup.');
  requireValue(Array.isArray(value.entries) && value.entries.length <= 10000, 'A workspace can contain up to 10,000 entries.');
  requireValue(Array.isArray(value.media) && value.media.length <= 500, 'A workspace can contain up to 500 images.');
  const entries = value.entries.map(entry), images = value.media.map(media);
  requireValue(new Set(entries.map(e => e.id)).size === entries.length && new Set(images.map(e => e.id)).size === images.length, 'Duplicate IDs in workspace.');
  requireValue(images.reduce((sum, m) => sum + m.size, 0) <= 12000000, 'Media storage limit is 12 MB for this workspace.');
  return { version: 1, settings: settings(value.settings), entries, media: images };
}
export function credentials(value, setup = false) {
  requireValue(value && typeof value === 'object', 'Credentials are required.');
  const email = text(value.email, 254, 'email', true).trim().toLowerCase();
  requireValue(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), 'Enter a valid email address.');
  const password = text(value.password, 256, 'password', true);
  requireValue(!setup || password.length >= 12, 'Use a password with at least 12 characters.');
  return { email, password };
}
