  // Optional atlas data is a declared, hash-verified JSON asset. No geometry crosses
  // the model context or the sandbox; native nodus:3d opens packaged model assets.
  if (request.toolId === 'render-anatomy-3d' || request.toolId === 'query-anatomy' || (request.toolId === 'list-supported-structures' && request.input && request.input.dimension === 'model')) {
    if (!host || !host.assets || typeof host.assets.read !== 'function') throw new Error('Packaged assets are unavailable. Install the compatible Nodus build; never fetch a model remotely.');
    const ATLAS = await host.assets.read('atlas');
    if (!ATLAS || ATLAS.schemaVersion !== 1 || !Array.isArray(ATLAS.entities) || !Array.isArray(ATLAS.relations)) throw new Error('Atlas resource-integrity error. Reinstall the verified package.');
    const entities = new Map(ATLAS.entities.map(entry => [entry.id, entry]));
    const index = new Map();
    const addTerm = (term, id, generalised) => {
      const key = normalizedTerm(term);
      if (!index.has(key)) index.set(key, []);
      if (!index.get(key).some(match => match.id === id)) index.get(key).push({id, generalised:Boolean(generalised)});
    };
    for (const entry of ATLAS.entities) {
      addTerm(entry.canonicalName, entry.id, false); addTerm(entry.id, entry.id, false);
      if (entry.ontology) addTerm(entry.ontology.id, entry.id, false);
      for (const alias of entry.aliases) addTerm(alias.term, entry.id, alias.generalised);
    }
    // Reuse existing canonical identities by explicit ontology cross-reference only.
    const canonical = new Map();
    for (const structure of DATA.structures) {
      const id = structure.id === 'uterus' ? 'HRA:uterus' : structure.id === 'ovaries' ? 'HRA:ovaries' : structure.fma && structure.fma.id.replace(':', '');
      if (!id || !entities.has(id)) continue;
      canonical.set(id, structure);
      if (structure.ontology && entities.has(structure.ontology.id)) {
        const ontologyId=structure.ontology.id;canonical.set(ontologyId,structure);
        addTerm(structure.canonicalName,ontologyId,false);
        for(const alias of structure.aliases)addTerm(alias.term,ontologyId,alias.generalised);
      }
      addTerm(structure.id,id,false); addTerm(structure.canonicalName,id,false);
      for (const alias of structure.aliases) addTerm(alias.term,id,alias.generalised);
    }
    const input = request.input || {};
    const language = input.language || 'en';
    const nameOf = entry => {
      const current = canonical.get(entry.id);
      return language === 'es' ? ((current && current.labels.es) || entry.labels.es || entry.canonicalName) : (current ? current.canonicalName : entry.canonicalName);
    };
    const lookup = raw => {
      if (typeof raw !== 'string' || !raw.trim() || raw.length > 64) throw new Error('Provide one anatomy term of 1 to 64 characters.');
      let term = normalizedTerm(raw), side = null;
      for (const prefix of ['left','right','both','bilateral']) if (term.startsWith(prefix + ' ')) {side=prefix;term=term.slice(prefix.length+1);break;}
      for (const [suffix,value] of [[' izquierdo','left'],[' izquierda','left'],[' derecho','right'],[' derecha','right']]) if (term.endsWith(suffix)) {if(side) throw new Error('Conflicting laterality.');side=value;term=term.slice(0,-suffix.length);break;}
      for (const prefix of ['ambos ','ambas ']) if(term.startsWith(prefix)){if(side)throw new Error('Conflicting laterality.');side='both';term=term.slice(prefix.length);}
      if (term === 'deltoid' || term === 'deltoids' || term === 'deltoides') {
        const portionSide = side === 'left' || side === 'right' ? side : 'bilateral';
        return { ids:ATLAS.deltoidPortions[portionSide],side:portionSide,notice:'Deltoid is a curated collection of the source-labelled clavicular, acromial and spinal portions; whole-muscle geometry is not claimed.' };
      }
      const matches = index.get(term);
      if (!matches || !matches.length) throw new Error('Unsupported structure: ' + raw + '. No anatomy or translation is invented.');
      // Sex alternatives from independent sources are resolved during rendering, not
      // treated as competing ontology mappings. HRA entries retain their own namespace.
      const fma = matches.filter(match => match.id.startsWith('FMA'));
      const uberon = matches.filter(match => match.id.startsWith('UBERON:'));
      const preferred = request.toolId === 'query-anatomy' && !side && uberon.length ? uberon : fma;
      const exact = preferred.length ? preferred : matches;
      if (exact.length > 1) throw new Error('Ambiguous structure: ' + raw + '. Candidates: ' + exact.map(m=>entities.get(m.id).canonicalName).join(', '));
      let id = exact[0].id;
      if ((side === 'both' || side === 'bilateral') && !ATLAS.laterality[id] && entities.get(id).laterality !== 'bilateral') throw new Error('Unsupported bilateral request: '+raw);
      if (side === 'left' || side === 'right') {
        const sides=ATLAS.laterality[id];
        if (!sides || !sides[side]) throw new Error('Unsupported laterality: ' + raw + '. The curated source does not distinguish this side.');
        id=sides[side];
      }
      return { ids:[id], side, notice:exact[0].generalised ? 'Generalised alias: '+raw+' resolves to '+entities.get(id).canonicalName : null };
    };
    const metadata = entry => ({
      id:canonical.has(entry.id) ? canonical.get(entry.id).id : entry.id,
      sourceIdentity:entry.id, canonicalName:entry.canonicalName, displayName:nameOf(entry),
      labels:entry.labels, aliases:[...entry.aliases,...(canonical.has(entry.id)?canonical.get(entry.id).aliases:[])],
      ontology:entry.ontology, laterality:entry.laterality, lateralitySupport:ATLAS.laterality[entry.id] || null,
      availability:{svg:canonical.has(entry.id),model:entry.geometry.length>0},
      views:entry.geometry.length?['interactive-3d']:[], sexes:[...new Set(entry.geometry.map(g=>g.sex))],
      geometry:entry.geometry, relationships:ATLAS.relations.filter(r=>r.subject===entry.id||r.object===entry.id),
      granularity:ATLAS.collections.some(c=>c.id===entry.id)?'partial semantic collection':'source anatomical entity',
      limitations:ATLAS.collections.some(c=>c.id===entry.id)?'Only the explicitly packaged subset is renderable; this is not the complete system.':null,
    });
    if (request.toolId === 'list-supported-structures') {
      validateInput(input,['dimension','search','limit','offset','language','category']);
      if (input.category !== undefined) throw new Error('category filters apply to SVG metadata; use search for model metadata.');
      const limit=input.limit===undefined?20:input.limit, offset=input.offset===undefined?0:input.offset;
      if (!Number.isInteger(limit)||limit<1||limit>50||!Number.isInteger(offset)||offset<0) throw new Error('Invalid metadata pagination.');
      let entries=ATLAS.entities.filter(e=>e.geometry.length);
      if(input.search)entries=entries.filter(e=>[e.canonicalName,...e.aliases.map(a=>a.term),...(canonical.has(e.id)?canonical.get(e.id).aliases.map(a=>a.term):[])].some(t=>normalizedTerm(t).includes(normalizedTerm(input.search))));
      return {kind:'json',value:{catalogVersion:2,dimension:'model',total:entries.length,offset,nextOffset:offset+limit<entries.length?offset+limit:null,structures:entries.slice(offset,offset+limit).map(metadata),sources:ATLAS.sources,limitations:ATLAS.limitations}};
    }
    if (request.toolId === 'query-anatomy') {
      validateInput(input,['structure','relation','language','depth','limit']);
      if (!['part-of','has-part','is-a'].includes(input.relation)) throw new Error('relation must be part-of, has-part or is-a.');
      const match=lookup(input.structure);
      if(match.ids.length!==1||match.notice)throw new Error('Semantic queries require one exact source entity, not a generalised collection.');
      const root=match.ids[0], depth=input.depth===undefined?1:input.depth, limit=input.limit===undefined?100:input.limit;
      if(!Number.isInteger(depth)||depth<1||depth>8||!Number.isInteger(limit)||limit<1||limit>200)throw new Error('Query bounds: depth 1 to 8, limit 1 to 200.');
      const visited=new Set([root]), queue=[{id:root,level:0}], edges=[];
      let truncated=false;
      for(let i=0;i<queue.length;i++) {
        const item=queue[i];if(item.level>=depth)continue;
        for(const edge of ATLAS.relations) {
          const inverse=input.relation==='has-part';
          if(edge.predicate!==(inverse?'part-of':input.relation)||(inverse?edge.object:edge.subject)!==item.id)continue;
          const target=inverse?edge.subject:edge.object;
          if(!visited.has(target)&&visited.size>=limit){truncated=true;continue;}
          edges.push({...edge,queriedAs:input.relation});
          if(!visited.has(target)){visited.add(target);queue.push({id:target,level:item.level+1});}
        }
      }
      return {kind:'json',value:{root,relation:input.relation,depth,truncated,status:edges.length?'curated-assertions':'no-curated-assertions',nodes:[...visited].map(id=>{const e=entities.get(id);return {id,canonicalName:e.canonicalName,displayName:nameOf(e),ontology:e.ontology,renderable:e.geometry.length>0};}),edges,sources:ATLAS.sources.filter(s=>s.file.includes('inclusion_relation') || s.file.startsWith('uberon-')),limitations:ATLAS.limitations}};
    }
    validateInput(input,['structures','sex','language','title']);
    if(!Array.isArray(input.structures)||!input.structures.length||input.structures.length>12)throw new Error('Provide 1 to 12 structures.');
    const sex=input.sex===undefined?'auto':input.sex;if(!['auto','male','female','both'].includes(sex))throw new Error('Invalid sex.');
    const title=input.title===undefined?(language==='es'?'Atlas anatómico 3D':'3D anatomy atlas'):input.title;
    if(typeof title!=='string'||!title.trim()||title.length>80||/[<>]/.test(title))throw new Error('Invalid title.');
    const matches=input.structures.map(lookup), selected=[];
    const notices=matches.map(m=>m.notice).filter(Boolean);
    // Reviewed source identity alternatives for the HRA female objects. No FMA/UBERON mapping
    // is fabricated: these are cross-provider selections by matching source-labelled names.
    const femaleAlternatives={FMA7203:['HRA:kidney-left','HRA:kidney-right'],FMA7204:['HRA:kidney-right'],FMA7205:['HRA:kidney-left']};
    const resolveGeometry=(id,targetSex)=>{
      const ids=targetSex==='female'&&femaleAlternatives[id]?femaleAlternatives[id]:[id];
      return ids.flatMap(key=>{const e=entities.get(key);return e.geometry.filter(g=>g.sex===targetSex).map(g=>({entry:e,geometry:g}));});
    };
    for (const match of matches) for(const id of match.ids) {
      const entry=entities.get(id);if(!entry)throw new Error('Atlas resource-integrity: missing identity.');
      let targets=sex==='both'?['male','female']:sex==='auto'?[entry.geometry.some(g=>g.sex==='male')?'male':'female']:[sex];
      let found=[];
      for(const targetSex of targets)found.push(...resolveGeometry(id,targetSex));
      if(!found.length)throw new Error('No verified 3D geometry for '+entry.canonicalName+' with sex '+sex+'. Semantic support does not imply renderability.');
      if(sex==='both'&&targets.some(s=>!found.some(x=>x.geometry.sex===s)))notices.push(entry.canonicalName+': only '+found.map(x=>x.geometry.sex).join(', ')+' reference geometry is packaged; the missing sex is not inferred.');
      const collection=ATLAS.collections.find(c=>c.id===id);if(collection)notices.push(collection.canonicalName+': partial curated system subset; '+collection.unavailableMembers.length+' semantic members have no packaged geometry.');
      if(language==='es'&&!entry.labels.es&&!(canonical.get(id)&&canonical.get(id).labels.es))notices.push(entry.canonicalName+': no reviewed Spanish output label; canonical English retained.');
      selected.push(...found);
    }
    const panels=new Map();
    for(const item of selected){const g=item.geometry;const sexLabel=language==='es'?(g.sex==='male'?'masculino':'femenino'):g.sex;if(!panels.has(g.assetId))panels.set(g.assetId,{assetId:g.assetId,nodeIds:[],title:title+' ('+sexLabel+'; '+g.assetId+')',alt:language==='es'?'Anatomía de referencia. ':'Reference anatomy. '});const panel=panels.get(g.assetId);panel.nodeIds.push(...g.nodeIds);panel.alt+=nameOf(item.entry)+'. ';}
    for(const panel of panels.values()){panel.nodeIds=[...new Set(panel.nodeIds)].sort();panel.alt+=language==='es'?'Marco de referencia independiente; solo investigación y enseñanza.':'Independent source frame; research and teaching only.';}
    const provenance=selected.some(s=>s.geometry.assetId==='bodyparts3d-male')?[ATLAS.provenance.bodyparts3d]:[];
    for(const id of new Set(selected.map(s=>s.entry.id))){const entry=entities.get(id);if(entry.provenance)provenance.push(entry.provenance);}
    return {kind:'model',panels:[...panels.values()],metadata:{catalogVersion:2,language,sex,structures:[...new Set(selected.map(s=>s.entry.id))].map(id=>metadata(entities.get(id))),provenance,notices,limitations:ATLAS.limitations}};
  }
