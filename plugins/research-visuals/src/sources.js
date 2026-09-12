// Source adapters belong to this package. Native vision never knows about Wikimedia.
export const DEFAULT_SOURCES = Object.freeze({ wikimedia: true, met: false, aic: false });
const UA = 'Nodus-Research-Visuals/1.0 (https://github.com/NodusResearch/nodus-research-skill-marketplace)';
const CC0 = 'https://creativecommons.org/publicdomain/zero/1.0/';
export function plain(value, max = 1000) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/<[^>]*>/g, ' ').replace(/&(?:amp|quot|apos|lt|gt|nbsp);/g, s => ({'&amp;':'&','&quot;':'"','&apos;':"'",'&lt;':' ','&gt;':' ','&nbsp;':' '})[s]).replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => { const c = Number(n.startsWith('x') ? `0${n}` : n); return c > 31 && c < 0x10ffff && c !== 60 && c !== 62 ? String.fromCodePoint(c) : ' '; }).replace(/[<>]/g, ' ').replace(/\s+/g,' ').trim();
  return text.length <= max ? text : '';
}
export function approvedImage(url) {
  const parsed = new URL(url);
  const hosts = { 'upload.wikimedia.org': ['commons-upload','/wikipedia/commons/'], 'thumb.wikimedia.org': ['commons-thumb','/wikipedia/commons/'], 'images.metmuseum.org': ['met-images','/CRDImages/'], 'www.artic.edu': ['aic-images','/iiif/2/'] };
  const allowed = hosts[parsed.hostname];
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash || !allowed || !parsed.pathname.startsWith(allowed[1]) || /%(?:25|2f|5c)/i.test(parsed.pathname)) throw new Error('Image URL is outside approved sources.');
  return { kind: 'public', endpointId: allowed[0], path: parsed.pathname + parsed.search };
}
async function json(host, endpoint, path) {
  host.signal.throwIfAborted();
  const result = await host.network.fetch(endpoint, { path, headers: { 'User-Agent': UA, Accept: 'application/json' } });
  host.signal.throwIfAborted();
  if (result.status !== 200) throw new Error(`Source ${endpoint} returned HTTP ${result.status}.`);
  return JSON.parse(new TextDecoder().decode(result.body));
}
export async function imageBytes(host, source) {
  host.signal.throwIfAborted();
  const r = await host.network.fetch(source.endpointId, { path: source.path, headers: { 'User-Agent': UA } });
  host.signal.throwIfAborted();
  if (r.status !== 200) throw new Error('Selected image download failed.');
  const mimeType = (r.headers['content-type'] ?? '').split(';')[0].toLowerCase();
  if (!['image/jpeg','image/png','image/webp','image/gif','image/avif'].includes(mimeType)) throw new Error('Unsupported image media type.');
  return { bytes: r.body, mimeType };
}
const path = (base, params) => `${base}?${new URLSearchParams(params)}`;
export function wikimediaCandidate(page) {
  const info = page.imageinfo?.[0], meta = info?.extmetadata;
  if (!info || !meta || !Number.isSafeInteger(page.pageid)) return null;
  const license = plain(meta.LicenseShortName?.value,100);
  let licenseUrl;
  if (license === 'Public domain') licenseUrl = 'https://creativecommons.org/publicdomain/mark/1.0/';
  else if (license === 'CC0') licenseUrl = CC0;
  else {
    const match = /^CC BY(-SA)? (1\.0|2\.0|2\.5|3\.0|4\.0)$/.exec(license);
    if (!match) return null;
    licenseUrl = `https://creativecommons.org/licenses/by${match[1] ? '-sa' : ''}/${match[2]}/`;
    if (String(meta.LicenseUrl?.value ?? '').replace(/^http:/,'https:').replace(/\/$/,'') !== licenseUrl.replace(/\/$/,'')) return null;
  }
  const title = plain(page.title,300), creator = plain(meta.Artist?.value), credit = plain(meta.Credit?.value);
  if (!title || (!creator && license.startsWith('CC BY'))) return null;
  const attribution = [creator,credit,'Wikimedia Commons',license].filter(Boolean).join(' · ');
  if (attribution.length > 1000) return null;
  const source = approvedImage(info.thumburl);
  if (!source.endpointId.startsWith('commons-')) return null;
  return { id: `commons-${page.pageid}`, title, description: plain(meta.ImageDescription?.value), attribution, license, licenseUrl, sourceUrl: `https://commons.wikimedia.org/?curid=${page.pageid}`, imageUrl: info.thumburl, source, provider: 'wikimedia' };
}
export async function searchSource(host, provider, query, batch, limit) {
  const result = [];
  if (provider === 'wikimedia') {
    const data = await json(host,'commons',path('/w/api.php',{action:'query',format:'json',generator:'search',gsrsearch:query,gsrnamespace:'6',gsrlimit:String(limit),gsroffset:String(batch*limit),prop:'imageinfo',iiprop:'url|extmetadata',iiurlwidth:'600'}));
    if (data.error) throw new Error('Wikimedia search failed.');
    for (const page of Object.values(data.query?.pages ?? {}).sort((a,b)=>(a.index??0)-(b.index??0))) { try { const c = wikimediaCandidate(page); if (c) result.push(c); } catch { /* Unapproved assets are not candidates. */ } }
  } else if (provider === 'met') {
    const data = await json(host,'met',path('/public/collection/v1.1/search',{q:query,hasImages:'true',offset:String(batch*limit),limit:String(limit)}));
    for (const id of (data.objectIDs ?? []).slice(0,limit)) {
      if (!Number.isSafeInteger(id) || id < 1) continue;
      const item = await json(host,'met',`/public/collection/v1/objects/${id}`);
      if (item.objectID !== id || item.isPublicDomain !== true || !item.primaryImageSmall) continue;
      try {
        const source = approvedImage(item.primaryImageSmall); if (source.endpointId !== 'met-images') continue;
        const title = plain(item.title,300), attribution = plain([item.artistDisplayName,item.creditLine,'The Metropolitan Museum of Art','CC0'].filter(Boolean).join(' · '));
        if (title && attribution) result.push({id:`met-${id}`,title,description:plain([item.objectDate,item.medium].filter(Boolean).join(' · ')),attribution,license:'CC0',licenseUrl:CC0,sourceUrl:`https://www.metmuseum.org/art/collection/search/${id}`,imageUrl:item.primaryImageSmall,source,provider});
      } catch { /* No fallback URL. */ }
    }
  } else if (provider === 'aic') {
    const data = await json(host,'aic',path('/api/v1/artworks/search',{q:query,query:JSON.stringify({term:{is_public_domain:true}}),limit:String(limit),page:String(batch+1),fields:'id,title,image_id,is_public_domain,artist_display,credit_line,date_display'}));
    for (const item of (data.data ?? []).slice(0,limit)) {
      if (!Number.isSafeInteger(item.id) || item.is_public_domain !== true || !/^[a-f0-9-]{36}$/.test(item.image_id)) continue;
      const imageUrl = `https://www.artic.edu/iiif/2/${item.image_id}/full/600,/0/default.jpg`;
      const title=plain(item.title,300),attribution=plain([item.artist_display,item.credit_line,'Art Institute of Chicago','CC0'].filter(Boolean).join(' · '));
      if (title && attribution) result.push({id:`aic-${item.id}`,title,description:plain(item.date_display),attribution,license:'CC0',licenseUrl:CC0,sourceUrl:`https://www.artic.edu/artworks/${item.id}`,imageUrl,source:approvedImage(imageUrl),provider});
    }
  } else throw new Error('Unknown image source.');
  return result.slice(0,limit);
}
export async function searchBatch(host, settings, query, batch) {
  const enabled = Object.keys(DEFAULT_SOURCES).filter(id=>settings[id] === true);
  const candidates=[], errors=[];
  for (let i=0;i<enabled.length;i++) {
    const limit = Math.floor(5/enabled.length)+(i<5%enabled.length?1:0);
    try { candidates.push(...await searchSource(host,enabled[i],query,batch,limit)); }
    catch { host.signal.throwIfAborted(); errors.push(`${enabled[i]}: source unavailable`); }
  }
  return {candidates,errors};
}
