import type { ChemistryDocument } from './engine/chemistryDocument';
import { text } from './messages';

/** The declarative view of a verified chemistry document.
 *
 *  The drawing is an SVG the package produced and the core sanitizes like any other. What
 *  surrounds it is the part that matters chemically: what was verified, against which
 *  references, and what the picture does not establish. */

interface Attachment { attachmentId: string; bytes: number }

export interface ChemistryAttachments {
  document?: Attachment;
  chemfig?: Attachment;
}

type Node = Record<string, unknown>;

export function documentView(document: ChemistryDocument, locale: string, attachments: ChemistryAttachments = {}): Record<string, unknown> {
  const nodes: Node[] = [];
  const partial = document.status === 'partial';

  nodes.push({
    kind: 'badges',
    items: [
      { label: partial ? text('partial', locale) : text('verified', locale), tone: partial ? 'warning' : 'success' },
      ...document.species.map(species => ({ label: species.input.value.slice(0, 60) })),
    ],
  });

  if (partial && document.reason) {
    nodes.push({ kind: 'notice', tone: 'warning', title: text('notice.partial-validation', locale), spans: [{ text: document.reason.slice(0, 700) }] });
  }
  if (document.assumedIdentity) {
    nodes.push({ kind: 'notice', tone: 'warning', title: text('notice.assumed-identity', locale), spans: [{ text: document.assumedIdentity.slice(0, 700) }] });
  }

  const reaction = document.reaction;
  const mechanism = document.mechanism;
  if (reaction && typeof reaction.svg === 'string') {
    nodes.push(svgNode(reaction.svg, text('studio', locale), text('reactionScope', locale)));
  } else if (mechanism && typeof mechanism.svg === 'string') {
    const panels = Array.isArray(mechanism.panels) ? mechanism.panels : [];
    if (panels.length) for (const panel of panels) nodes.push(svgNode(panel.svg, text('studio', locale), text('mechanismScope', locale)));
    else nodes.push(svgNode(mechanism.svg, text('studio', locale), text('mechanismScope', locale)));
  } else {
    for (const species of document.species) {
      if (typeof species.svg === 'string') nodes.push(svgNode(species.svg, species.input.value.slice(0, 80), species.input.value));
    }
  }

  const limitations = [...(reaction?.limitations ?? []), ...(mechanism?.limitations ?? [])].filter(entry => typeof entry === 'string');
  if (limitations.length) {
    nodes.push({ kind: 'heading', level: 4, text: text('limitations', locale) });
    nodes.push({ kind: 'list', items: limitations.slice(0, 20).map(entry => [{ text: entry.slice(0, 500) }]) });
  }

  const links = document.species.flatMap(species => (species.references ?? [])
    .filter(reference => typeof reference?.url === 'string' && reference.url.startsWith('https://'))
    .map(reference => ({ href: reference.url, label: `${reference.provider}: ${species.input.value}`.slice(0, 120), description: reference.smiles?.slice(0, 120) })));
  if (links.length) {
    nodes.push({ kind: 'details', summary: text('references', locale), children: [{ kind: 'links', items: links.slice(0, 40) }] });
  }

  if (attachments.document) nodes.push(download(attachments.document, text('downloadDocument', locale), 'chemistry-document-v2.json', 'application/json'));
  if (attachments.chemfig) nodes.push(download(attachments.chemfig, text('downloadChemfig', locale), 'structure.chemfig.tex', 'text/x-tex'));

  return {
    schemaVersion: 1,
    title: document.species.map(species => species.input.value).join(' · ').slice(0, 120) || text('studio', locale),
    summary: summarize(document, locale),
    nodes,
  };
}

const svgNode = (svg: string, title: string, alt: string): Node => ({ kind: 'svg', svg, title: title.slice(0, 200), alt: alt.slice(0, 1000) });

const download = (attachment: Attachment, label: string, name: string, mimeType: string): Node =>
  ({ kind: 'download', attachmentId: attachment.attachmentId, label, name, mimeType, bytes: attachment.bytes });

export function summarize(document: ChemistryDocument, locale: string): string {
  const names = document.species.map(species => species.input.value).join(', ');
  const kind = document.reaction ? text('reactionScope', locale) : document.mechanism ? text('mechanismScope', locale) : text(document.status === 'partial' ? 'partial' : 'verified', locale);
  return `${names} — ${kind}`.slice(0, 500);
}

export function noticeView(key: string, locale: string, detail?: string): Record<string, unknown> {
  const message = text(`notice.${key}`, locale);
  return {
    schemaVersion: 1,
    summary: message,
    nodes: [{
      kind: 'notice',
      tone: key === 'not-drawn' || key === 'conflicting-intents' ? 'warning' : 'info',
      title: text('studio', locale),
      spans: [{ text: detail ? `${message} ${detail.slice(0, 700)}` : message }],
    }],
  };
}

/** The unverified fallback is labelled as such wherever it appears, including in its own
 *  alt text: a drawing the verified lane did not produce must not read like one that did. */
export function unverifiedSvgView(svg: string, locale: string, reason: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    summary: text('unverified', locale),
    nodes: [
      { kind: 'notice', tone: 'warning', title: text('unverified', locale), spans: [{ text: `${text('notice.unverified-svg', locale)} ${reason.slice(0, 400)}` }] },
      svgNode(svg, text('unverified', locale), `${text('unverified', locale)}. ${reason.slice(0, 600)}`),
    ],
  };
}
