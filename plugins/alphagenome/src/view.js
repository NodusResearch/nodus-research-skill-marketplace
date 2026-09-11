import { trackSvg } from './chart.js';
import { CITATION, NOTICE, OUTPUT_TERMS, TERMS } from './plan.js';
import { text } from './messages.js';

/** The prediction view.
 *
 *  What it says about itself is part of the result: a model signal, not a probability of
 *  disease; a 16 kb window; a REF allele taken on trust. The drawing carries the same
 *  statements in its own metadata, so an exported image cannot be separated from them. */
export function resultView(result, locale) {
  const nodes = [
    {
      kind: 'badges',
      items: [
        { label: result.plan.variant, tone: 'info' },
        { label: result.plan.output },
        { label: result.plan.tissue },
        { label: 'GRCh38' },
        { label: `${result.tracks.length}/${result.totalTracks} ${text('tracks', locale)}` },
      ],
    },
    { kind: 'notice', tone: 'warning', title: text('research', locale), spans: [{ text: text('context', locale) }] },
  ];

  for (let index = 0; index < result.tracks.length; index++) {
    const track = result.tracks[index];
    nodes.push({
      kind: 'svg',
      svg: trackSvg(result, index),
      title: `${result.plan.variant} · ${track.name.slice(0, 80)}`,
      alt: `${text('prediction', locale)}: ${track.name}. ${text('research', locale)}`,
    });
  }

  nodes.push({
    kind: 'notice', tone: 'info', title: text('provenance', locale),
    spans: [{ text: text('localOnly', locale) }],
  });
  nodes.push({
    kind: 'details',
    summary: text('provenance', locale),
    children: [
      { kind: 'paragraph', spans: [{ text: NOTICE }] },
      { kind: 'paragraph', spans: [{ text: CITATION }] },
      { kind: 'paragraph', spans: [{ text: result.modifications }] },
      { kind: 'links', items: [
        { href: OUTPUT_TERMS, label: text('terms', locale) },
        { href: TERMS, label: 'AlphaGenome terms' },
      ] },
    ],
  });

  return {
    schemaVersion: 1,
    title: `${text('prediction', locale)} · ${result.plan.variant}`,
    summary: summarize(result, locale),
    nodes,
  };
}

export function summarize(result, locale) {
  return `${text('prediction', locale)}: ${result.plan.variant}, ${result.plan.output}, ${result.plan.tissue}`.slice(0, 500);
}

export function noticeView(code, locale) {
  return {
    schemaVersion: 1,
    summary: text(`error.${code}`, locale),
    nodes: [{ kind: 'notice', tone: 'warning', title: 'AlphaGenome', spans: [{ text: text(`error.${code}`, locale) }] }],
  };
}
