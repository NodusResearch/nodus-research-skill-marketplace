// Curated, deterministic registry for the Anatomy Visualization skill.
//
// Every entry maps a canonical English anatomical name and its reviewed aliases to a
// provider region that actually exists in the pinned graphical resources. The build
// verifies that each providerId is present in the extracted data, so the registry can
// never advertise a structure the renderer cannot draw.
//
// `fmaQuery` is the exact English term offered to the EMBL-EBI Ontology Lookup Service
// for the Foundational Model of Anatomy (FMA). The build accepts a cross-reference only
// when a returned FMA term has that exact label or synonym. No identifier is invented and
// no source namespace (UBERON) is rewritten as FMA.
//
// `generalised: true` marks a reviewed alias that is broader or narrower than the drawn
// region. The renderer reports those matches in an explicit figure notice.

const muscle = (id, name, providerId, aliases, fmaQuery, notes) => ({
  id, canonicalName: name, category: 'muscle', granularity: 'muscle',
  provider: 'anatome', providerId, laterality: 'bilateral', aliases, fmaQuery, notes,
});

const muscleGroup = (id, name, providerId, aliases, fmaQuery, notes) => ({
  id, canonicalName: name, category: 'muscle-group', granularity: 'muscle group',
  provider: 'anatome', providerId, laterality: 'bilateral', aliases, fmaQuery, notes,
});

const bodyRegion = (id, name, providerId, aliases, notes) => ({
  id, canonicalName: name, category: 'body-region', granularity: 'body region',
  provider: 'anatome', providerId, laterality: 'bilateral', aliases, notes,
});

const bodyStructure = (id, name, providerId, category, granularity, aliases, fmaQuery, laterality, notes) => ({
  id, canonicalName: name, category, granularity,
  provider: 'anatomogram', panel: 'body', providerId, aliases, fmaQuery, laterality, notes,
});

const brainRegion = (id, name, providerId, aliases, fmaQuery, notes) => ({
  id, canonicalName: name, category: 'brain-region', granularity: 'brain region',
  provider: 'anatomogram', panel: 'brain', providerId, laterality: 'bilateral',
  aliases, fmaQuery, notes,
});

export const MUSCLE_STRUCTURES = [
  muscle('deltoid', 'Deltoid', 'deltoids',
    [{ term: 'deltoid' }, { term: 'deltoids' }, { term: 'deltoid muscle' }], 'deltoid'),
  muscleGroup('pectoral-region', 'Pectoral region', 'chest',
    [{ term: 'chest' }, { term: 'chest muscles' }, { term: 'pectoral' }, { term: 'pectorals' },
      { term: 'pectoral muscles' }, { term: 'pectoralis' }, { term: 'pecs' },
      { term: 'pectoralis major', generalised: true }, { term: 'pectoralis minor', generalised: true }],
    null, 'The drawing shows the pectoral (chest) region, which includes the pectoralis major and minor muscles.'),
  muscle('rectus-abdominis', 'Rectus abdominis', 'abs',
    [{ term: 'abs' }, { term: 'abdominals' }, { term: 'rectus abdominis' }], 'rectus abdominis'),
  muscleGroup('abdominal-obliques', 'Abdominal oblique muscles', 'obliques',
    [{ term: 'obliques' }, { term: 'oblique muscles' }, { term: 'abdominal obliques' },
      { term: 'external oblique', generalised: true }, { term: 'internal oblique', generalised: true }], null),
  muscle('biceps-brachii', 'Biceps brachii', 'biceps',
    [{ term: 'biceps' }, { term: 'biceps brachii' }, { term: 'biceps muscle' }], 'biceps brachii'),
  muscle('triceps-brachii', 'Triceps brachii', 'triceps',
    [{ term: 'triceps' }, { term: 'triceps brachii' }, { term: 'triceps muscle' }], 'triceps brachii'),
  muscle('trapezius', 'Trapezius', 'trapezius',
    [{ term: 'trapezius' }, { term: 'trapezius muscle' }, { term: 'traps' }], 'trapezius'),
  muscleGroup('quadriceps', 'Quadriceps femoris', 'quadriceps',
    [{ term: 'quadriceps' }, { term: 'quads' }, { term: 'quadriceps femoris' },
      { term: 'quadriceps muscle group' }], 'quadriceps femoris'),
  muscleGroup('hamstrings', 'Hamstring muscles', 'hamstring',
    [{ term: 'hamstring' }, { term: 'hamstrings' }, { term: 'hamstring muscles' },
      { term: 'hamstring group' }], null),
  muscleGroup('gluteal-muscles', 'Gluteal muscles', 'gluteal',
    [{ term: 'glutes' }, { term: 'gluteal' }, { term: 'gluteal muscles' }, { term: 'gluteus' },
      { term: 'gluteus maximus', generalised: true }, { term: 'gluteus medius', generalised: true },
      { term: 'gluteus minimus', generalised: true }], null),
  muscleGroup('calf-muscles', 'Calf muscles', 'calves',
    [{ term: 'calf' }, { term: 'calves' }, { term: 'calf muscles' },
      { term: 'gastrocnemius', generalised: true }, { term: 'soleus', generalised: true }], null),
  muscleGroup('adductor-muscles', 'Adductor muscles', 'adductors',
    [{ term: 'adductors' }, { term: 'adductor muscles' }, { term: 'hip adductors' }], null),
  muscleGroup('forearm-muscles', 'Forearm muscles', 'forearm',
    [{ term: 'forearm' }, { term: 'forearms' }, { term: 'forearm muscles' }], null),
  muscleGroup('upper-back-muscles', 'Upper back muscles', 'upper-back',
    [{ term: 'upper back' }, { term: 'upper back muscles' },
      { term: 'lats', generalised: true }, { term: 'latissimus dorsi', generalised: true },
      { term: 'rhomboids', generalised: true }], null),
  muscleGroup('lower-back-muscles', 'Lower back muscles', 'lower-back',
    [{ term: 'lower back' }, { term: 'lower back muscles' }, { term: 'lumbar muscles' },
      { term: 'erector spinae', generalised: true }], null),
  muscle('tibialis-anterior', 'Tibialis anterior', 'tibialis',
    [{ term: 'tibialis' }, { term: 'tibialis anterior' }, { term: 'tibialis anterior muscle' },
      { term: 'shin muscle' }], 'tibialis anterior'),
  bodyRegion('neck', 'Neck region', 'neck', [{ term: 'neck' }, { term: 'cervical region' }],
    'The drawing shows the neck as a region, not individual neck muscles.'),
  bodyRegion('head', 'Head', 'head', [{ term: 'head' }], 'The drawing shows the head as a region.'),
  bodyRegion('hair', 'Hair', 'hair', [{ term: 'hair' }, { term: 'scalp hair' }],
    'The drawing shows scalp hair as a schematic region.'),
  bodyRegion('hands', 'Hands', 'hands', [{ term: 'hand' }, { term: 'hands' }],
    'The drawing shows each hand as a region, not individual hand muscles.'),
  bodyRegion('knees', 'Knees', 'knees', [{ term: 'knee' }, { term: 'knees' }, { term: 'knee region' }]),
  bodyRegion('ankles', 'Ankles', 'ankles', [{ term: 'ankle' }, { term: 'ankles' }, { term: 'ankle region' }]),
  bodyRegion('feet', 'Feet', 'feet', [{ term: 'foot' }, { term: 'feet' }],
    'The drawing shows each foot as a region, not individual foot muscles.'),
];

export const BODY_STRUCTURES = [
  bodyStructure('brain', 'Brain', 'UBERON:0000955', 'organ', 'organ',
    [{ term: 'brain' }, { term: 'whole brain' }], 'brain', 'unpaired'),
  bodyStructure('heart', 'Heart', 'UBERON:0000948', 'organ', 'organ',
    [{ term: 'heart' }], 'heart', 'unpaired'),
  bodyStructure('lungs', 'Lungs', 'UBERON:0002048', 'organ', 'organ',
    [{ term: 'lung' }, { term: 'lungs' }, { term: 'pulmonary organ' }], 'lung', 'bilateral'),
  bodyStructure('liver', 'Liver', 'UBERON:0002107', 'organ', 'organ',
    [{ term: 'liver' }], 'liver', 'unpaired'),
  bodyStructure('kidneys', 'Kidneys', 'UBERON:0002113', 'organ', 'organ',
    [{ term: 'kidney' }, { term: 'kidneys' }], 'kidney', 'bilateral'),
  bodyStructure('stomach', 'Stomach', 'UBERON:0000945', 'organ', 'organ',
    [{ term: 'stomach' }, { term: 'gastric organ' }], 'stomach', 'unpaired'),
  bodyStructure('pancreas', 'Pancreas', 'UBERON:0001264', 'organ', 'organ',
    [{ term: 'pancreas' }], 'pancreas', 'unpaired'),
  bodyStructure('spleen', 'Spleen', 'UBERON:0002106', 'organ', 'organ',
    [{ term: 'spleen' }], 'spleen', 'unpaired'),
  bodyStructure('gallbladder', 'Gallbladder', 'UBERON:0002110', 'organ', 'organ',
    [{ term: 'gallbladder' }, { term: 'gall bladder' }], 'gallbladder', 'unpaired'),
  bodyStructure('small-intestine', 'Small intestine', 'UBERON:0002108', 'organ', 'organ',
    [{ term: 'small intestine' }, { term: 'small bowel' }], 'small intestine', 'unpaired'),
  bodyStructure('colon', 'Colon', 'UBERON:0001155', 'organ', 'organ',
    [{ term: 'colon' }, { term: 'large intestine', generalised: true }, { term: 'large bowel', generalised: true }],
    'colon', 'unpaired', 'The drawing shows the colon; the caecum and rectum are separate structures in this catalog.'),
  bodyStructure('rectum', 'Rectum', 'UBERON:0001052', 'organ', 'organ',
    [{ term: 'rectum' }], 'rectum', 'unpaired'),
  bodyStructure('appendix', 'Appendix', 'UBERON:0001154', 'organ', 'organ',
    [{ term: 'appendix' }, { term: 'vermiform appendix' }], 'appendix', 'unpaired'),
  bodyStructure('urinary-bladder', 'Urinary bladder', 'UBERON:0001255', 'organ', 'organ',
    [{ term: 'urinary bladder' }, { term: 'bladder' }], 'urinary bladder', 'unpaired'),
  bodyStructure('esophagus', 'Esophagus', 'UBERON:0001043', 'organ', 'organ',
    [{ term: 'esophagus' }, { term: 'oesophagus' }, { term: 'food pipe' }], 'esophagus', 'unpaired'),
  bodyStructure('thyroid-gland', 'Thyroid gland', 'UBERON:0002046', 'organ', 'gland',
    [{ term: 'thyroid gland' }, { term: 'thyroid' }], 'thyroid gland', 'unpaired'),
  bodyStructure('adrenal-glands', 'Adrenal glands', 'UBERON:0002369', 'organ', 'gland',
    [{ term: 'adrenal gland' }, { term: 'adrenal glands' }, { term: 'adrenals' },
      { term: 'suprarenal glands' }], 'adrenal gland', 'bilateral'),
  bodyStructure('aorta', 'Aorta', 'UBERON:0000947', 'vessel', 'artery',
    [{ term: 'aorta' }], 'aorta', 'unpaired'),
  bodyStructure('spinal-cord', 'Spinal cord', 'UBERON:0002240', 'organ', 'central nervous system structure',
    [{ term: 'spinal cord' }], 'spinal cord', 'unpaired',
    'Only the male anatomogram draws the spinal cord; select the male body for this structure.'),
  bodyStructure('diaphragm', 'Diaphragm', 'UBERON:0001103', 'muscle', 'muscle',
    [{ term: 'diaphragm' }, { term: 'thoracic diaphragm' }], 'diaphragm', 'unpaired',
    'The diaphragm is drawn on the organ panel, not on the muscle panels.'),
  bodyStructure('tongue', 'Tongue', 'UBERON:0001723', 'organ', 'muscular organ',
    [{ term: 'tongue' }], 'tongue', 'unpaired'),
  bodyStructure('pituitary-gland', 'Pituitary gland', 'UBERON:0000007', 'organ', 'gland',
    [{ term: 'pituitary gland' }, { term: 'pituitary' }, { term: 'hypophysis' }], 'pituitary gland', 'unpaired'),
  bodyStructure('oral-cavity', 'Oral cavity', 'UBERON:0000167', 'body-region', 'body cavity',
    [{ term: 'oral cavity' }, { term: 'mouth' }], null, 'unpaired'),
  bodyStructure('nose', 'Nose', 'UBERON:0000004', 'body-region', 'body region',
    [{ term: 'nose' }], 'nose', 'unpaired'),
  bodyStructure('eyes', 'Eyes', 'UBERON:0000970', 'organ', 'sensory organ',
    [{ term: 'eye' }, { term: 'eyes' }], 'eye', 'bilateral'),
  bodyStructure('breasts', 'Breasts', 'UBERON:0000310', 'organ', 'gland',
    [{ term: 'breast' }, { term: 'breasts' }, { term: 'mammary gland' },
      { term: 'mammary glands' }], 'breast', 'bilateral'),
  bodyStructure('prostate-gland', 'Prostate gland', 'UBERON:0002367', 'organ', 'gland',
    [{ term: 'prostate' }, { term: 'prostate gland' }], 'prostate', 'unpaired'),
  bodyStructure('testes', 'Testes', 'UBERON:0000473', 'organ', 'gonad',
    [{ term: 'testis' }, { term: 'testes' }, { term: 'testicle' }, { term: 'testicles' }], 'testis', 'bilateral'),
  bodyStructure('epididymis', 'Epididymis', 'UBERON:0001301', 'organ', 'organ',
    [{ term: 'epididymis' }, { term: 'epididymides' }], 'epididymis', 'bilateral'),
  bodyStructure('uterus', 'Uterus', 'UBERON:0000995', 'organ', 'organ',
    [{ term: 'uterus' }, { term: 'womb' }], 'uterus', 'unpaired'),
  bodyStructure('ovaries', 'Ovaries', 'UBERON:0000992', 'organ', 'gonad',
    [{ term: 'ovary' }, { term: 'ovaries' }], 'ovary', 'bilateral'),
  bodyStructure('vagina', 'Vagina', 'UBERON:0000996', 'organ', 'organ',
    [{ term: 'vagina' }], 'vagina', 'unpaired'),
  bodyStructure('fallopian-tubes', 'Fallopian tubes', 'UBERON:0003889', 'organ', 'organ',
    [{ term: 'fallopian tube' }, { term: 'fallopian tubes' }, { term: 'uterine tube' },
      { term: 'uterine tubes' }], 'uterine tube', 'bilateral'),
  bodyStructure('uterine-cervix', 'Uterine cervix', 'UBERON:0000002', 'organ', 'organ region',
    [{ term: 'uterine cervix' }, { term: 'cervix' }, { term: 'cervix uteri' }], 'cervix uteri', 'unpaired'),
  bodyStructure('endometrium', 'Endometrium', 'UBERON:0001295', 'tissue', 'mucosa',
    [{ term: 'endometrium' }, { term: 'uterine lining' }], 'endometrium', 'unpaired'),
  bodyStructure('placenta', 'Placenta', 'UBERON:0001987', 'organ', 'temporary organ',
    [{ term: 'placenta' }], 'placenta', 'unpaired'),
];

export const BRAIN_STRUCTURES = [
  brainRegion('cerebral-cortex', 'Cerebral cortex', 'UBERON:0000956',
    [{ term: 'cerebral cortex' }, { term: 'cortex', generalised: true }], 'cerebral cortex'),
  brainRegion('cerebellum', 'Cerebellum', 'UBERON:0002037', [{ term: 'cerebellum' }], 'cerebellum'),
  brainRegion('thalamus', 'Thalamus', 'UBERON:0001897', [{ term: 'thalamus' }], 'thalamus'),
  brainRegion('diencephalon', 'Diencephalon', 'UBERON:0001894', [{ term: 'diencephalon' }], 'diencephalon'),
  brainRegion('occipital-lobe', 'Occipital lobe', 'UBERON:0002021', [{ term: 'occipital lobe' }], 'occipital lobe'),
  brainRegion('temporal-lobe', 'Temporal lobe', 'UBERON:0001871', [{ term: 'temporal lobe' }], 'temporal lobe'),
  brainRegion('frontal-cortex', 'Frontal cortex', 'UBERON:0001870', [{ term: 'frontal cortex' }], 'frontal cortex'),
  brainRegion('prefrontal-cortex', 'Prefrontal cortex', 'UBERON:0000451', [{ term: 'prefrontal cortex' }], 'prefrontal cortex'),
  brainRegion('medulla-oblongata', 'Medulla oblongata', 'UBERON:0001896', [{ term: 'medulla oblongata' }, { term: 'medulla' }], 'medulla oblongata'),
  brainRegion('parietal-lobe', 'Parietal lobe', 'UBERON:0001872', [{ term: 'parietal lobe' }], 'parietal lobe'),
  brainRegion('hippocampus', 'Hippocampus', 'UBERON:0002421', [{ term: 'hippocampus' }], 'hippocampus'),
  brainRegion('hypothalamus', 'Hypothalamus', 'UBERON:0001898', [{ term: 'hypothalamus' }], 'hypothalamus'),
  brainRegion('pineal-gland', 'Pineal gland', 'UBERON:0001905', [{ term: 'pineal gland' }, { term: 'pineal body' }], 'pineal body'),
  brainRegion('nucleus-accumbens', 'Nucleus accumbens', 'UBERON:0001882', [{ term: 'nucleus accumbens' }], 'nucleus accumbens'),
  brainRegion('locus-ceruleus', 'Locus ceruleus', 'UBERON:0002148', [{ term: 'locus ceruleus' }, { term: 'locus coeruleus' }], 'locus ceruleus'),
  brainRegion('amygdala', 'Amygdala', 'UBERON:0001876', [{ term: 'amygdala' }], 'amygdala'),
  brainRegion('middle-frontal-gyrus', 'Middle frontal gyrus', 'UBERON:0002702', [{ term: 'middle frontal gyrus' }], 'middle frontal gyrus'),
  brainRegion('middle-temporal-gyrus', 'Middle temporal gyrus', 'UBERON:0002771', [{ term: 'middle temporal gyrus' }], 'middle temporal gyrus'),
  brainRegion('cingulate-cortex', 'Cingulate cortex', 'UBERON:0003027', [{ term: 'cingulate cortex' }, { term: 'cingulate gyrus' }], 'cingulate cortex'),
  brainRegion('telencephalic-ventricle', 'Telencephalic ventricle', 'UBERON:0002285', [{ term: 'telencephalic ventricle' }, { term: 'lateral ventricle' }], 'telencephalic ventricle'),
];

// Reviewed broad terms that name more than one supported structure. The resolver must
// ask for a specific structure instead of guessing.
export const AMBIGUOUS_TERMS = [
  { term: 'abdominal muscles', candidates: ['rectus-abdominis', 'abdominal-obliques'] },
  { term: 'back muscles', candidates: ['upper-back-muscles', 'lower-back-muscles'] },
];

export const ALL_STRUCTURES = [...MUSCLE_STRUCTURES, ...BODY_STRUCTURES, ...BRAIN_STRUCTURES];

export const RESOURCE_TARGETS = {
  body: [...BODY_STRUCTURES.map((entry) => entry.providerId)],
  brain: [...BRAIN_STRUCTURES.map((entry) => entry.providerId)],
};
