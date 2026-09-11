import { validateResult, OUTPUT_TERMS } from './plan.js';

/** The track drawing, carried over from the built-in unchanged.
 *
 *  It is not decoration: the SVG embeds the notice, the citation, the exact plan, the
 *  model revision and what Nodus changed, so an exported image still says where it came
 *  from and what it is not. Redrawing it prettier would quietly drop that.
 */

export function trackSvg(result, trackIndex) {
  const r = validateResult(result), track = r.tracks[trackIndex];
  if (!track) throw new Error('Invalid track.');
  const escape = (s) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const values = [...track.reference, ...track.alternate];
  const min = Math.min(0, ...values), max = Math.max(...values, min + 1e-12);
  const points = (data) => data.map((v, i) => `${(75 + (i + .5) * 780 / data.length).toFixed(2)},${(280 - (v - min) / (max - min) * 165).toFixed(2)}`).join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 940 535"><title>AlphaGenome — ${escape(r.plan.variant)}</title><desc>${escape(r.notice + '. ' + r.modifications + ' Provenance: ' + JSON.stringify({ plan: r.plan, model: r.model, sdkRevision: r.sdkRevision, createdAt: r.createdAt, citation: r.citation }))}</desc><metadata>${escape(JSON.stringify({ notice: r.notice, citation: r.citation, plan: r.plan, modifications: r.modifications, model: r.model, sdkRevision: r.sdkRevision, createdAt: r.createdAt }))}</metadata><rect width="940" height="535" fill="#ffffff"/><g font-family="sans-serif" fill="#182433"><text x="30" y="35" font-size="22">AlphaGenome · ${escape(r.plan.variant)} · ${escape(r.plan.output)}</text><text x="30" y="61" font-size="15">${escape(track.name.slice(0, 95))} (${escape(track.strand)})</text><text x="30" y="86" font-size="14">GRCh38 · ${escape(r.plan.tissue)} · ALL_FOLDS · model signal / señal del modelo</text><path d="M75 110 V280 H855" fill="none" stroke="#64748b"/><text x="12" y="122" font-size="13">${max.toPrecision(3)}</text><text x="12" y="280" font-size="13">${min.toPrecision(3)}</text><polyline points="${points(track.reference)}" stroke="#475569" fill="none" stroke-width="2"/><polyline points="${points(track.alternate)}" stroke="#c02647" fill="none" stroke-width="2"/><path d="M465 110 V280" stroke="#94a3b8" stroke-dasharray="4 4"/><text x="75" y="307" font-size="14">${r.interval.start + 1}</text><text x="855" y="307" text-anchor="end" font-size="14">${r.interval.end}</text><text x="75" y="334" font-size="15" fill="#475569">REF</text><text x="140" y="334" font-size="15" fill="#c02647">ALT</text><text x="215" y="334" font-size="14">${track.reference.length} mean bins · source resolution ${track.resolution} bp · positions 1-based</text><text x="30" y="366" font-size="14">Google DeepMind · Avsec et al., Nature (2026) · doi:10.1038/s41586-025-10014-0</text><text x="30" y="391" font-size="14">Modified by Nodus: track selection, bin averaging and visualization. Research only; no clinical use.</text><text x="30" y="416" font-size="14">By using this information, you agree to AlphaGenome Output Terms of Use found at</text><text x="30" y="441" font-size="14">${OUTPUT_TERMS}</text><text x="30" y="475" font-size="13">Non-commercial use restrictions apply. No endorsement by Google. ${escape(r.createdAt)}</text><text x="30" y="507" font-size="13">16 kb context only. User-supplied REF allele; not independently checked against GRCh38.</text></g></svg>`;
}
