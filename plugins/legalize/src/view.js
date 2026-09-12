import { COUNTRIES } from './countries.js';
import { attribution, repositoryUrl } from './attribution.js';
import { text } from './messages.js';

/** The declarative view a retrieved law is shown as.
 *
 *  Retrieved legislation is source data, never markup: it goes into a preformatted block
 *  so nothing in a foreign repository can decide how this reply is rendered. */

const MAX_INLINE = 20_000;

export function resultView(result, locale) {
  const country = COUNTRIES.find(entry => entry.code === result.country);
  const nodes = [];

  if (result.document) {
    nodes.push({ kind: 'heading', level: 3, text: result.document.title });
    nodes.push({
      kind: 'badges',
      items: [
        { label: country.name, tone: 'info' },
        { label: result.document.id },
        ...(result.document.article ? [{ label: `${text('article', locale)} ${result.document.article}`, tone: 'info' }] : []),
        { label: `${text('snapshot', locale)} ${result.revision.slice(0, 7)}` },
      ],
    });
    // A declared status and date describe the repository, not legal force. Saying so is
    // part of the result, not a footnote someone may or may not scroll to.
    nodes.push({
      kind: 'notice', tone: 'warning',
      title: text('notOfficial.title', locale),
      spans: [{ text: text('notOfficial.body', locale) }],
    });
    const body = result.document.text.length > MAX_INLINE
      ? `${result.document.text.slice(0, MAX_INLINE)}\n…`
      : result.document.text;
    nodes.push({ kind: 'code', text: body });
    if (result.document.text.length > MAX_INLINE) {
      nodes.push({ kind: 'paragraph', spans: [{ text: text('truncated', locale) }] });
    }
    nodes.push({
      kind: 'links',
      items: [
        { href: result.document.source, label: text('officialSource', locale), description: country.sourceName },
        { href: repositoryUrl(result.country, result.revision, result.document.path), label: text('repository', locale), description: `legalize-dev/${country.repo}` },
      ],
    });
  } else if (result.matches.length) {
    nodes.push({ kind: 'heading', level: 3, text: text('candidates.title', locale) });
    // Candidates are candidates. Presenting them as an answer is how a near-miss becomes
    // a confident citation of the wrong law.
    nodes.push({ kind: 'paragraph', spans: [{ text: text('candidates.body', locale) }] });
    nodes.push({
      kind: 'table',
      columns: [{ label: text('identifier', locale) }, { label: text('title', locale) }],
      rows: result.matches.map(match => [match.id, match.title]),
    });
    nodes.push({
      kind: 'links',
      items: result.matches.map(match => ({ href: repositoryUrl(result.country, result.revision, match.path), label: match.id, description: match.title })),
    });
    if (result.totalMatches > result.matches.length) {
      nodes.push({ kind: 'paragraph', spans: [{ text: text('moreMatches', locale).replace('{total}', String(result.totalMatches)) }] });
    }
  } else {
    nodes.push({
      kind: 'notice', tone: 'info',
      title: text('noMatch.title', locale),
      spans: [{ text: text('noMatch.body', locale) }],
    });
  }

  nodes.push({
    kind: 'details',
    summary: text('attribution', locale),
    children: [{ kind: 'code', text: attribution(result) }],
  });

  return {
    schemaVersion: 1,
    title: result.document ? result.document.title : text('candidates.title', locale),
    summary: summarize(result, locale),
    nodes,
  };
}

export function summarize(result, locale) {
  const country = COUNTRIES.find(entry => entry.code === result.country);
  if (result.document) {
    return `${result.document.title} (${result.document.id}, ${country.name})${result.document.article ? `, ${text('article', locale)} ${result.document.article}` : ''}`.slice(0, 500);
  }
  if (result.matches.length) return `${result.totalMatches} ${text('candidates.title', locale)} — ${country.name}`.slice(0, 500);
  return `${text('noMatch.title', locale)} — ${country.name}`.slice(0, 500);
}

export function noticeView(code, locale) {
  return {
    schemaVersion: 1,
    summary: text(`error.${code}`, locale),
    nodes: [{ kind: 'notice', tone: 'warning', title: 'Legalize', spans: [{ text: text(`error.${code}`, locale) }] }],
  };
}
