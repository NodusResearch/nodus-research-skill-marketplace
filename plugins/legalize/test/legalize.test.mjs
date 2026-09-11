// Contract and behaviour tests for the Legalize capability package. No network: the host
// is a stub that serves fixtures, which is exactly what the real host is from the
// worker's point of view.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { runConformanceSuite, conformanceFailures } from '../../../scripts/contract-v2.mjs';
import createWorker from '../src/worker.js';
import { parsePlan } from '../src/plan.js';
import { parseDocument, selectArticle } from '../src/retrieve.js';
import { attribution, exportText } from '../src/attribution.js';
import { COUNTRIES } from '../src/countries.js';

const manifest = JSON.parse(fs.readFileSync(new URL('../capabilities/legal/capability.json', import.meta.url), 'utf8'));
const spain = COUNTRIES.find(entry => entry.code === 'es');
const REVISION = 'a'.repeat(40);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const LAW = `---
country: es
identifier: BOE-A-1978-31229
title: Constitución Española
source: https://www.boe.es/eli/es/c/1978/12/27/(1)/con
last_updated: 2011-09-27
status: Vigente
---

# Artículo 14

Los españoles son iguales ante la ley.

# Artículo 15

Todos tienen derecho a la vida.
`;

/** A host that answers exactly what the manifest permits, and nothing else. */
function stubHost(options = {}) {
  const cache = new Map();
  const calls = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legalize-test-'));
  return {
    dir, calls, cache,
    signal: new AbortController().signal,
    log: () => {},
    storage: {
      cache: {
        get: async key => cache.get(key) ?? null,
        set: async (key, value) => { cache.set(key, value); },
        delete: async key => { cache.delete(key); },
        keys: async () => [...cache.keys()],
      },
      state: { get: async () => null, set: async () => {}, delete: async () => {}, keys: async () => [] },
      temp: { dir: async () => dir, clear: async () => {} },
    },
    network: {
      async fetch(endpointId, request) {
        calls.push(`${endpointId}${request.path}`);
        const declared = manifest.permissions.network.find(entry => entry.id === endpointId);
        assert.ok(declared, `the package declared the ${endpointId} endpoint`);
        assert.ok(declared.pathPrefixes.some(prefix => request.path.startsWith(prefix)), `${request.path} is inside a declared prefix`);
        const body = options.fetch?.(endpointId, request.path);
        if (body === undefined) return { status: 404, headers: {}, body: Buffer.alloc(0) };
        if (typeof body === 'number') return { status: body, headers: {}, body: Buffer.alloc(0) };
        return { status: 200, headers: {}, body: Buffer.from(body) };
      },
      async downloadToTemp(endpointId, request) {
        calls.push(`${endpointId}${request.path}`);
        const archive = options.archive?.();
        if (!archive) return { status: 404, path: '', bytes: 0 };
        const file = path.join(dir, 'catalogue.zip');
        fs.writeFileSync(file, archive);
        return { status: 200, path: file, bytes: archive.length };
      },
    },
  };
}

const snapshot = (extra = {}) => (endpointId, target) => {
  if (endpointId === 'api') return JSON.stringify({ object: { sha: REVISION } });
  if (target.endsWith('/LICENSE')) return extra.licence ?? Buffer.from(LICENCE_BYTES);
  if (target.endsWith('/README.md')) return extra.readme ?? Buffer.from(README_BYTES);
  return extra.files?.[target];
};

// The package refuses to retrieve anything unless the notices hash exactly as reviewed,
// so the fixtures have to carry the real bytes for those two files.
const LICENCE_BYTES = 'licence fixture';
const README_BYTES = 'readme fixture';
const originalLicence = spain.licenseSha256, originalReadme = spain.readmeSha256;

test.before(() => {
  spain.licenseSha256 = sha256(Buffer.from(LICENCE_BYTES));
  spain.readmeSha256 = sha256(Buffer.from(README_BYTES));
});
test.after(() => { spain.licenseSha256 = originalLicence; spain.readmeSha256 = originalReadme; });

// ---------------------------------------------------------------- grounding

test('a plan must be copied from the current message, not invented', () => {
  const question = 'Dame el artículo 14 de la Constitución Española.';
  const plan = parsePlan(JSON.stringify({ version: 1, country: 'es', query: 'Constitución Española', article: '14' }), question);
  assert.deepEqual(plan, { version: 1, country: 'es', query: 'Constitución Española', article: '14' });

  const rejects = (source, hint) => assert.throws(() => parsePlan(source, question), error => {
    assert.match(error.message, hint);
    return true;
  });
  // A law the user never mentioned, an article they never asked for, a country they never named.
  rejects(JSON.stringify({ version: 1, country: 'es', query: 'Ley de Enjuiciamiento Civil' }), /NOT_IN_MESSAGE/);
  rejects(JSON.stringify({ version: 1, country: 'es', query: 'Constitución Española', article: '27' }), /NOT_IN_MESSAGE/);
  assert.throws(() => parsePlan(JSON.stringify({ version: 1, country: 'fr', query: 'Constitución Española' }), question), /NOT_IN_MESSAGE|INVALID_PLAN/);
  rejects('not json', /INVALID_JSON/);
  rejects(JSON.stringify({ version: 1, country: 'es', query: 'a' }), /INVALID_PLAN/);
  rejects(JSON.stringify({ version: 1, country: 'es', query: 'Constitución Española', extra: 1 }), /INVALID_PLAN/);
});

// ---------------------------------------------------------------- documents

test('a document is accepted only when its own metadata agrees with where it was found', () => {
  const document = parseDocument(LAW, 'es/BOE-A-1978-31229.md', 'es');
  assert.equal(document.title, 'Constitución Española');
  assert.equal(document.source, 'https://www.boe.es/eli/es/c/1978/12/27/(1)/con');
  assert.match(document.metadata, /identifier: BOE-A-1978-31229/);

  assert.throws(() => parseDocument(LAW, 'fr/BOE-A-1978-31229.md', 'fr'), /DOCUMENT_MISMATCH/);
  assert.throws(() => parseDocument(LAW, 'es/other.md', 'es'), /DOCUMENT_MISMATCH/);
  assert.throws(() => parseDocument('no frontmatter', 'es/x.md', 'es'), /NO_METADATA/);
  assert.throws(() => parseDocument(LAW.replace('https://www.boe.es', 'javascript:alert(1)'), 'es/BOE-A-1978-31229.md', 'es'), /INVALID_SOURCE|NO_SOURCE/);
});

test('an article is extracted only when exactly one heading matches', () => {
  const document = parseDocument(LAW, 'es/BOE-A-1978-31229.md', 'es');
  const article = selectArticle(document.text, '14');
  assert.match(article, /Los españoles son iguales ante la ley/);
  assert.doesNotMatch(article, /derecho a la vida/, 'the next article is not swept in');
  assert.throws(() => selectArticle(document.text, '99'), /ARTICLE_NOT_UNIQUE/);
});

// ---------------------------------------------------------------- retrieval

test('an exact identifier is retrieved without downloading the catalogue', async () => {
  const host = stubHost({ fetch: snapshot({ files: { [`/legalize-dev/legalize-es/${REVISION}/es/BOE-A-1978-31229.md`]: LAW } }) });
  const worker = createWorker(host);
  const result = await worker.invoke({ invocationId: 'i1', toolId: 'retrieve', locale: 'es', input: { version: 1, country: 'es', query: 'BOE-A-1978-31229' } });
  const artifact = result.artifacts[0];
  assert.equal(artifact.artifactType, 'legal-result');
  assert.equal(artifact.data.document.title, 'Constitución Española');
  assert.equal(artifact.data.revision, REVISION);
  assert.ok(!host.calls.some(call => call.startsWith('codeload')), 'the country catalogue is never downloaded for an exact identifier');
  assert.match(artifact.summary, /Constitución Española/);
});

test('retrieval stops if the repository notices are not the ones that were reviewed', async () => {
  const host = stubHost({ fetch: snapshot({ licence: Buffer.from('a different licence') }) });
  const worker = createWorker(host);
  await assert.rejects(
    worker.invoke({ invocationId: 'i2', toolId: 'retrieve', locale: 'en', input: { version: 1, country: 'es', query: 'BOE-A-1978-31229' } }),
    error => { assert.match(error.message, /licence has to be reviewed/); return true; },
  );
});

test('an incomplete catalogue is refused rather than answered as "not found"', async () => {
  const zip = new AdmZip();
  zip.addFile('legalize-es/es/BOE-A-1978-31229.md', Buffer.from(LAW));
  zip.addFile('legalize-es/es/broken.md', Buffer.from('no frontmatter here'));
  const host = stubHost({ fetch: snapshot(), archive: () => zip.toBuffer() });
  const worker = createWorker(host);
  await assert.rejects(
    worker.invoke({ invocationId: 'i3', toolId: 'retrieve', locale: 'en', input: { version: 1, country: 'es', query: 'Constitución Española' } }),
    error => { assert.match(error.message, /incompatible or incomplete/); return true; },
  );
});

test('a title search indexes the snapshot once and reuses the cache', async () => {
  const zip = new AdmZip();
  zip.addFile('legalize-es/es/BOE-A-1978-31229.md', Buffer.from(LAW));
  const host = stubHost({
    fetch: snapshot({ files: { [`/legalize-dev/legalize-es/${REVISION}/es/BOE-A-1978-31229.md`]: LAW } }),
    archive: () => zip.toBuffer(),
  });
  const worker = createWorker(host);
  const first = await worker.invoke({ invocationId: 'i4', toolId: 'retrieve', locale: 'es', input: { version: 1, country: 'es', query: 'Constitución Española' } });
  assert.equal(first.artifacts[0].data.document.id, 'BOE-A-1978-31229');
  assert.equal(host.calls.filter(call => call.startsWith('codeload')).length, 1);

  await worker.invoke({ invocationId: 'i5', toolId: 'retrieve', locale: 'es', input: { version: 1, country: 'es', query: 'Constitución Española' } });
  assert.equal(host.calls.filter(call => call.startsWith('codeload')).length, 1, 'the second search reuses the cached index');
  assert.deepEqual(await host.storage.cache.keys(), ['index-es']);
});

// ---------------------------------------------------------------- attribution

test('every result carries its repository, source, licence and what Nodus changed', () => {
  const result = {
    version: 1, country: 'es', query: 'Constitución Española', revision: REVISION,
    fetchedAt: '2026-09-11T10:00:00.000Z', matches: [], totalMatches: 1, attribution: '',
    document: { ...parseDocument(LAW, 'es/BOE-A-1978-31229.md', 'es'), article: '14', text: 'Los españoles son iguales ante la ley.' },
  };
  const notice = attribution(result);
  assert.match(notice, /Legalize — España/);
  assert.match(notice, /github\.com\/legalize-dev\/legalize-es\/blob\//);
  assert.match(notice, /Agencia Estatal Boletín Oficial del Estado/);
  assert.match(notice, /Documento oficial: https:\/\/www\.boe\.es/);
  assert.match(notice, /Reproducción automatizada no oficial/);
  assert.match(notice, /extracción del artículo 14/);
  assert.match(exportText(result), /--- TEXTO RECUPERADO ---/);
});

// ---------------------------------------------------------------- contract

test('the worker satisfies the capability contract it declares', async () => {
  const host = stubHost({ fetch: snapshot({ files: { [`/legalize-dev/legalize-es/${REVISION}/es/BOE-A-1978-31229.md`]: LAW } }) });
  const findings = await runConformanceSuite(manifest, createWorker(host), {
    invocations: [{ toolId: 'retrieve', input: { version: 1, country: 'es', query: 'BOE-A-1978-31229' } }],
    chatNodes: [
      { id: 'n0', kind: 'prose', content: 'Dame la Constitución Española.', complete: true },
      { id: 'n1', kind: 'fence', fence: 'legal-plan', content: JSON.stringify({ version: 1, country: 'es', query: 'Constitución Española' }), complete: true },
    ],
    artifacts: [{
      artifactType: 'legal-result', artifactVersion: 1,
      data: {
        version: 1, country: 'es', query: 'Constitución Española', revision: REVISION,
        fetchedAt: '2026-09-11T10:00:00.000Z', matches: [], totalMatches: 1, attribution: '',
        document: parseDocument(LAW, 'es/BOE-A-1978-31229.md', 'es'),
      },
    }],
  });
  assert.deepEqual(conformanceFailures(findings), []);
});

// ------------------------------------------------ what 5.3.1 left behind

const migrate = createRequire(import.meta.url)('../migrations/001-adopt-index-cache.cjs');

const legacyIndex = (revision = REVISION) => ({
  revision,
  entries: [{ identifier: 'BOE-A-1978-31229', title: 'Constitución Española', path: 'es/BOE-A-1978-31229.md' }],
});

test('the migration adopts a cached country index instead of downloading it again', async () => {
  const host = stubHost();
  const result = await migrate({
    host,
    legacy: { legalizeIndexes: [{ country: 'es', index: legacyIndex() }] },
    fromDataVersion: 0, toDataVersion: 1,
  });

  assert.equal(result.dataVersion, 1);
  assert.deepEqual((await host.storage.cache.get('index-es')).entries, legacyIndex().entries);
  assert.match(result.notes, /Adopted cached indexes: es/);
});

test('an index that cannot be trusted to be what it says is left behind', async () => {
  const host = stubHost();
  const result = await migrate({
    host,
    legacy: {
      legalizeIndexes: [
        { country: 'es', index: { revision: 'not-a-revision', entries: [{}] } },
        { country: 'zz9', index: legacyIndex() },
        { country: 'fr', index: { ...legacyIndex(), skipped: 3 } },
        { country: 'it', index: { revision: REVISION, entries: [] } },
      ],
    },
    fromDataVersion: 0, toDataVersion: 1,
  });

  assert.deepEqual(await host.storage.cache.keys(), [], 'a partial or unidentifiable index is rebuilt, not trusted');
  assert.match(result.notes, /No reusable cached index/);
});

test('one country failing does not cost the others theirs', async () => {
  const host = stubHost();
  const realSet = host.storage.cache.set;
  host.storage.cache.set = async (key, value) => {
    if (key === 'index-fr') throw new Error('disk full');
    return realSet(key, value);
  };
  const result = await migrate({
    host,
    legacy: { legalizeIndexes: [{ country: 'fr', index: legacyIndex() }, { country: 'es', index: legacyIndex() }] },
    fromDataVersion: 0, toDataVersion: 1,
  });

  assert.equal(result.dataVersion, 1, 'a rebuildable cache never fails the migration');
  assert.match(result.notes, /Adopted cached indexes: es/);
  assert.match(result.notes, /Left behind and will be rebuilt: fr/);
});

test('running the migration twice does not overwrite an index the package refreshed since', async () => {
  const host = stubHost();
  await migrate({ host, legacy: { legalizeIndexes: [{ country: 'es', index: legacyIndex() }] }, fromDataVersion: 0, toDataVersion: 1 });
  const newer = 'b'.repeat(40);
  await host.storage.cache.set('index-es', { revision: newer, entries: [], skipped: 0 });
  await migrate({ host, legacy: { legalizeIndexes: [{ country: 'es', index: legacyIndex() }] }, fromDataVersion: 0, toDataVersion: 1 });

  assert.equal((await host.storage.cache.get('index-es')).revision, newer);
});

test('a retrieval saved by the built-in still renders, with its attribution', async () => {
  const host = stubHost({ fetch: snapshot({ files: { [`/legalize-dev/legalize-es/${REVISION}/es/BOE-A-1978-31229.md`]: LAW } }) });
  const worker = createWorker(host);
  const fresh = await worker.invoke({
    invocationId: 'i1', toolId: 'retrieve', locale: 'en',
    input: { version: 1, country: 'es', query: 'BOE-A-1978-31229' },
  });
  const saved = fresh.artifacts[0].data;

  const view = await worker.renderLegacyResult({ fence: 'legal-result', payload: JSON.stringify(saved), locale: 'en' });
  assert.equal(view.schemaVersion, 1);
  assert.deepEqual(view, await worker.renderArtifact({ artifactType: 'legal-result', data: saved, locale: 'en' }),
    'an old block and a new artifact of the same retrieval draw the same thing');

  await assert.rejects(worker.renderLegacyResult({ fence: 'legal-result', payload: '<not json>', locale: 'en' }), /UNREADABLE/);
  await assert.rejects(worker.renderLegacyResult({ fence: 'genomics-result', payload: '{}', locale: 'en' }), /Unknown legacy fence/);
});
