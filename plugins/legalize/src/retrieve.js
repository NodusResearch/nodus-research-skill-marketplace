import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { COUNTRIES, normalize, safePath } from './countries.js';
import { attribution } from './attribution.js';

/** Retrieval against a pinned legalize-dev snapshot.
 *
 *  Every host and path is fixed by the capability manifest: there is no shell, no Git, no
 *  SDK, no token and no user-supplied URL anywhere in this file. What arrives back is
 *  source data from an untrusted repository and is treated as such. */

const MAX_LAW = 10_000_000;
const MAX_ENTRIES = 350_000;
const MAX_DECLARED_BYTES = 4_000_000_000;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const running = new Set();

async function get(host, endpointId, path, { optional = false } = {}) {
  const response = await host.network.fetch(endpointId, { path, method: 'GET' });
  if (response.status === 404) { if (optional) return null; throw new Error('LEGALIZE_NOT_FOUND'); }
  if (response.status === 403 || response.status === 429) throw new Error('LEGALIZE_RATE_LIMITED');
  if (response.status !== 200) throw new Error(`LEGALIZE_UNAVAILABLE:${response.status}`);
  return Buffer.from(response.body);
}

/** Reads only scalar frontmatter, and keeps the block verbatim so attribution survives. */
export function parseDocument(raw, file, country) {
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  if (!front || front[1].length > 100_000) throw new Error('LEGALIZE_NO_METADATA');
  const fields = {};
  for (const line of front[1].split(/\r?\n/)) {
    const match = /^([a-z_]+):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { continue; } }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("''", "'");
    else if (/^[>|&*!{[]/.test(value)) continue;
    if (typeof value === 'string') fields[match[1]] = value;
  }
  if (fields.country !== country || !fields.title || !fields.identifier || !fields.source || !safePath(file)
    || file.split('/').at(-1) !== `${fields.identifier}.md`) throw new Error('LEGALIZE_DOCUMENT_MISMATCH');
  let source;
  try { source = new URL(fields.source); } catch { throw new Error('LEGALIZE_NO_SOURCE'); }
  if (!['https:', 'http:'].includes(source.protocol) || source.username || source.password) throw new Error('LEGALIZE_INVALID_SOURCE');
  return {
    id: fields.identifier, title: fields.title, path: file, source: source.href,
    metadata: front[1], text: raw.slice(front[0].length),
    lastUpdated: fields.last_updated || '', status: fields.status || '',
  };
}

export function selectArticle(text, article) {
  const escaped = article.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^(#{1,6})[ \\t]+(?:Art[ií]culo|Article|Art\\.?|Section|§)[ \\t]+${escaped}(?=[ \\t.:—–-]|$)[^\\n]*`, 'gimu');
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) throw new Error('LEGALIZE_ARTICLE_NOT_UNIQUE');
  const match = matches[0], start = match.index, tail = text.slice(start + match[0].length);
  const next = new RegExp(`^#{1,${match[1].length}}[ \\t]+`, 'm').exec(tail);
  return text.slice(start, next ? start + match[0].length + next.index : undefined).trimEnd();
}

export async function retrieve(host, plan) {
  const country = COUNTRIES.find(entry => entry.code === plan.country);
  if (!country) throw new Error('LEGALIZE_COUNTRY_UNSUPPORTED');
  // One query per country at a time: two concurrent catalogue downloads would fight over
  // the same cache entry and the same hundreds of megabytes.
  if (running.has(country.code)) throw new Error('LEGALIZE_ALREADY_RUNNING');
  running.add(country.code);
  try {
    const ref = await get(host, 'api', `/repos/legalize-dev/${country.repo}/git/ref/heads/main`);
    const revision = JSON.parse(ref.toString('utf8')).object?.sha;
    if (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('LEGALIZE_NO_REVISION');
    const base = `/legalize-dev/${country.repo}/${revision}/`;

    // The licence and the notices are what make redistribution lawful. If either has
    // changed since the version this package was reviewed against, nothing is retrieved.
    const [licence, readme] = await Promise.all([
      get(host, 'raw', `${base}LICENSE`, { optional: true }),
      get(host, 'raw', `${base}README.md`, { optional: true }),
    ]);
    if (!licence || sha256(licence) !== country.licenseSha256 || !readme || sha256(readme) !== country.readmeSha256) throw new Error('LEGALIZE_NOTICES_CHANGED');

    const result = {
      version: 1, country: country.code, query: plan.query, revision,
      fetchedAt: new Date().toISOString(), matches: [], totalMatches: 0, attribution: '',
    };

    // An exact canonical identifier avoids downloading the country catalogue at all.
    let identifier = /^[\p{L}\p{N}_.()-]+$/u.test(plan.query) ? plan.query : '';
    const usc = /^(\d+)\s*U\.?\s*S\.?\s*C\.?\s*§?\s*(\d+[a-z0-9-]*)$/i.exec(plan.query);
    if (country.code === 'us' && usc) identifier = `USC-T${usc[1]}-S${usc[2]}`;

    let document;
    if (identifier && identifier !== '.' && identifier !== '..') {
      const file = `${country.code}/${identifier}.md`;
      const raw = await get(host, 'raw', base + file.split('/').map(encodeURIComponent).join('/'), { optional: true });
      if (raw) document = parseDocument(raw.toString('utf8'), file, country.code);
    }

    if (!document) {
      const index = await countryIndex(host, country, revision);
      const query = normalize(plan.query), words = query.split(' ');
      const isExact = (entry) => normalize(entry.title) === query || normalize(entry.id) === query;
      const matches = index.entries
        .filter(entry => normalize(entry.id) === query || words.every(word => normalize(entry.title).split(' ').some(part => part === word)))
        .sort((a, b) => Number(isExact(b)) - Number(isExact(a)) || a.title.localeCompare(b.title));
      result.totalMatches = matches.length;
      result.matches = matches.slice(0, 5);
      const exact = matches.filter(isExact);
      const chosen = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : undefined;
      if (chosen) {
        if (!safePath(chosen.path)) throw new Error('LEGALIZE_INVALID_CATALOGUE_PATH');
        const raw = await get(host, 'raw', base + chosen.path.split('/').map(encodeURIComponent).join('/'), { optional: true });
        if (!raw) throw new Error('LEGALIZE_DOCUMENT_ABSENT');
        document = parseDocument(raw.toString('utf8'), chosen.path, country.code);
      }
    }

    if (document) {
      result.matches = [{ id: document.id, title: document.title, path: document.path }];
      result.totalMatches = 1;
      const text = plan.article ? selectArticle(document.text, plan.article) : document.text;
      if (text.length > 200_000) throw new Error('LEGALIZE_TOO_LONG');
      result.document = { ...document, text, ...(plan.article ? { article: plan.article } : {}) };
    }
    result.attribution = attribution(result);
    return result;
  } finally { running.delete(country.code); }
}

async function countryIndex(host, country, revision) {
  const key = `index-${country.code}`;
  const cached = await host.storage.cache.get(key);
  if (cached && cached.revision === revision && Array.isArray(cached.entries)) return cached;

  const download = await host.network.downloadToTemp('codeload', { path: `/legalize-dev/${country.repo}/zip/${revision}`, method: 'GET' });
  if (download.status !== 200) throw new Error('LEGALIZE_CATALOGUE_UNAVAILABLE');
  let entries;
  try { entries = new AdmZip(fs.readFileSync(download.path)).getEntries(); }
  finally { fs.rmSync(download.path, { force: true }); }

  if (entries.length > MAX_ENTRIES || entries.reduce((total, entry) => total + entry.header.size, 0) > MAX_DECLARED_BYTES) throw new Error('LEGALIZE_CATALOGUE_TOO_LARGE');

  const index = { revision, entries: [], skipped: 0 };
  for (let position = 0; position < entries.length; position++) {
    if (position % 64 === 0) {
      await new Promise(resolve => setImmediate(resolve));
      host.signal.throwIfAborted();
    }
    const entry = entries[position];
    const file = entry.entryName.split('/').slice(1).join('/');
    if (entry.isDirectory || !file.includes('/') || !file.endsWith('.md') || !safePath(file)) continue;
    if (entry.header.size > MAX_LAW) { index.skipped++; continue; }
    try {
      const document = parseDocument(entry.getData().toString('utf8'), file, country.code);
      index.entries.push({ id: document.id, title: document.title, path: document.path });
    } catch { index.skipped++; }
  }
  // An incomplete catalogue must never present an exhaustive negative result: "not found"
  // has to mean the law is not in the snapshot, not that indexing gave up on some of it.
  if (index.skipped || !index.entries.length) throw new Error(`LEGALIZE_CATALOGUE_INCOMPLETE:${index.skipped}`);
  await host.storage.cache.set(key, index);
  return index;
}
