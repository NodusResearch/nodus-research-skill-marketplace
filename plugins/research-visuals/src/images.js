import { createHash } from 'node:crypto';
import { validateVisionReviewResult, validateViewDocument } from '../../../scripts/contract-v2.mjs';
import { DEFAULT_SOURCES, imageBytes, searchBatch } from './sources.js';

export function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k=>!['query','maximum'].includes(k)) || typeof input.query !== 'string' || input.query.trim().length < 2 || input.query.length > 180 || /[<>\x00-\x1f]/.test(input.query)) throw new Error('Provide a public image search query of 2–180 characters.');
  if (input.maximum !== undefined && (!Number.isInteger(input.maximum) || input.maximum < 1 || input.maximum > 5)) throw new Error('Maximum must be between 1 and 5.');
  return { query: input.query.trim(), maximum: input.maximum ?? 3 };
}
export function metadataRanking(candidates, query) {
  const tokens = [...new Set(query.toLocaleLowerCase('en').match(/[\p{L}\p{N}]{3,}/gu) ?? [])];
  return candidates.map(c=>({ id:c.id, score:tokens.length ? tokens.filter(t=>`${c.title} ${c.description}`.toLocaleLowerCase('en').includes(t)).length/tokens.length : 0 }))
    .filter(c=>c.score >= 0.5).sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id)).map(c=>c.id);
}
function assertReceipt(review, prepared) {
  validateVisionReviewResult(review);
  if (review.candidates.length !== prepared.length || review.candidates.some(c=>!prepared.some(p=>p.id===c.id && p.imageId===c.imageId && (!c.inspected || c.thumbnailSha256===p.provenance.thumbnailSha256)))) throw new Error('Review does not match the images supplied to the host.');
  return review;
}
export async function retrieveImages(host, input, question, settings, search = searchBatch) {
  const plan = validateInput(input);
  if (typeof question !== 'string' || !question.trim()) throw new Error('Image search requires the original conversation request.');
  host.signal.throwIfAborted();
  const enabled = Object.keys(DEFAULT_SOURCES).filter(id=>settings[id] === true);
  const result = { schemaVersion:1, query:plan.query, enabledSources:enabled, outcome:'no_relevant_candidate', mode:'vision', rounds:[], selected:[], errors:[] };
  if (!enabled.length) return { ...result, outcome:'sources_disabled', mode:'skipped' };
  const seen = new Set();
  for (let batch=0;batch<3;batch++) {
    host.signal.throwIfAborted();
    const found = await search(host,settings,plan.query,batch);
    result.errors.push(...found.errors);
    const candidates = found.candidates.filter(c=>!seen.has(c.id)).slice(0,5);
    for (const c of candidates) seen.add(c.id);
    if (!candidates.length) continue;
    let prepared, review;
    try {
      prepared = await host.vision.prepareImages(candidates.map(c=>({ id:c.id,metadata:{title:c.title,...(c.description?{description:c.description}:{}),attribution:c.attribution},source:c.source })));
      host.signal.throwIfAborted();
      review = assertReceipt(await host.vision.reviewImages({ request:question,candidates:prepared.map(({id,imageId})=>({id,imageId})) }),prepared);
    } catch (error) {
      host.signal.throwIfAborted();
      // Fail closed: malformed receipts are never relabelled as metadata success.
      result.outcome='review_failed'; result.errors.push('Image preparation or review failed; no inspection is claimed.'); break;
    }
    result.rounds.push({batch:batch+1,review,candidates:candidates.map(c=>({id:c.id,sourceUrl:c.sourceUrl,license:c.license,licenseUrl:c.licenseUrl})),prepared});
    let ids = [];
    if (review.outcome === 'vision_unavailable') {
      result.mode = 'metadata';
      ids = metadataRanking(candidates, plan.query);
    } else if (review.status === 'reviewed') ids = review.selected;
    else { result.outcome = review.outcome; break; }
    for (const id of ids.slice(0,plan.maximum)) {
      host.signal.throwIfAborted();
      const c = candidates.find(c=>c.id===id), receipt = prepared.find(p=>p.id===id);
      if (!c || !receipt) throw new Error('Unknown selected image.');
      try {
        const asset = await imageBytes(host,c.source);
        // The displayed bytes must be the bytes the host prepared, even if a URL changes.
        if (createHash('sha256').update(asset.bytes).digest('hex') !== receipt.provenance.sha256) throw new Error('Image changed after review.');
        const name = `${c.id}.${asset.mimeType === 'image/jpeg'?'jpg':asset.mimeType.split('/')[1]}`;
        const stored = await host.media.store({...asset,name});
        result.selected.push({...c,prepared:receipt,inspected:review.status==='reviewed',asset:{attachmentId:stored.attachmentId,bytes:stored.bytes,mimeType:asset.mimeType,name}});
      } catch { host.signal.throwIfAborted(); result.errors.push(`${id}: selected image could not be stored or changed after review`); }
    }
    if (result.selected.length) { result.outcome='selected'; break; }
    if (ids.length) { result.outcome='media_unavailable'; break; }
    if (result.mode === 'metadata') break;
    if (review.remainingRounds === 0) break;
  }
  if (!result.rounds.length && result.errors.length && result.outcome==='no_relevant_candidate') result.outcome='sources_unavailable';
  return result;
}
export function imageView(data) {
  const explanation = data.mode==='metadata' ? 'Vision unavailable: these are metadata matches. No model inspected the images.' : 'Visual review uses only the thumbnails recorded in the host receipts. Selection is a relevance judgement, not authentication.';
  const nodes = [{kind:'heading',level:2,text:'Open Image Finder'},{kind:'paragraph',spans:[{text:explanation}]}];
  for (const c of data.selected) nodes.push({kind:'image',...c.asset,title:c.title,alt:c.title}, {kind:'paragraph',spans:[{text:c.attribution},{text:' · Source',href:c.sourceUrl},{text:` · ${c.license}`,href:c.licenseUrl},{text:' · Thumbnail; no editorial alterations.'}]});
  if (!data.selected.length) nodes.push({kind:'notice',tone:'warning',spans:[{text:data.outcome==='sources_disabled'?'Enable at least one source in this capability’s settings.':`No images selected (${data.outcome}). No substitute image was invented.`}]});
  if (data.errors.length) nodes.push({kind:'list',items:data.errors.map(text=>[{text}])});
  if (data.download) nodes.push({kind:'download',...data.download,label:'Sources, licences and review receipts (JSON)'});
  return validateViewDocument({schemaVersion:1,summary:`Image search: ${data.outcome}; ${data.selected.length} selected`,nodes});
}
export default host => {
  const settings = async () => { const saved=await host.storage.state.get('sources'); return Object.fromEntries(Object.entries(DEFAULT_SOURCES).map(([id,value])=>[id,typeof saved?.[id]==='boolean'?saved[id]:value])); };
  const state = async () => ({fields:Object.fromEntries(Object.entries(await settings()).map(([id,value])=>[id,{value}]))});
  return {
    async health() { return {status:'ready',dataVersion:0}; },
    getSettings:state,
    async applySettings({fields}) {
      if (!fields || Object.entries(fields).some(([id,v])=>!Object.hasOwn(DEFAULT_SOURCES,id) || typeof v!=='boolean')) throw new Error('Invalid image source settings.');
      await host.storage.state.set('sources',{...await settings(),...fields}); return state();
    },
    async invoke({toolId,input,chat}) {
      if (toolId!=='search-images') throw new Error('Unknown image tool.');
      const data=await retrieveImages(host,input,chat?.question,await settings());
      const bytes=new TextEncoder().encode(JSON.stringify(data,null,2));
      const name='image-search-provenance.json',mimeType='application/json';
      data.download={...await host.attachments.store({bytes,name,mimeType}),name,mimeType};
      const view=imageView(data);
      return {artifacts:[{artifactType:'research-images',artifactVersion:1,summary:view.summary,data,view}]};
    },
    async renderArtifact({artifactType,artifactVersion,data}) { if(artifactType!=='research-images'||artifactVersion!==1) throw new Error('Unknown image artifact.');return imageView(data); },
    async shutdown() {},
  };
};
