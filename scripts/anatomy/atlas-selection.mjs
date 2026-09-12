// Exact source-table labels, not ontology terms advertised without geometry.
export const BODY_PARTS_SELECTION = [
  'kidney', 'liver', 'heart', 'right lung', 'left lung', 'stomach', 'pancreas', 'spleen', 'gallbladder',
  'small intestine', 'ascending colon', 'transverse colon', 'descending colon', 'rectum', 'urinary bladder', 'prostate', 'testis', 'aorta',
  'renal artery', 'renal vein', 'common carotid artery', 'adrenal gland', 'pituitary gland',
  'femur', 'humerus', 'tibia', 'fibula', 'scapula', 'clavicle', 'sternum', 'rib',
  'supraspinatus', 'infraspinatus', 'psoas major', 'tibialis anterior', 'short head of biceps brachii', 'long head of biceps brachii',
  'long head of triceps brachii', 'medial head of triceps brachii', 'lateral head of triceps brachii', 'rectus femoris', 'vastus medialis', 'vastus lateralis',
  'clavicular part of deltoid', 'acromial part of deltoid', 'spinal part of deltoid',
  'optic nerve', 'trochlear nerve', 'ophthalmic nerve', 'neuraxis',
];
// Curated source roots. Membership is the transitive closure of the source's PART-OF table.
export const SYSTEMS = {
  FMA7152: ['digestive system'], FMA7157: ['nervous system'], FMA7158: ['respiratory system'],
  FMA7159: ['urinary system'], FMA7160: ['reproductive system'], FMA7161: ['cardiovascular system'],
  FMA23881: ['skeletal system', 'skeleton'], FMA9668: ['endocrine system'],
};
// These groups expose precisely the named portions, and always disclose that granularity.
export const DELTOID_PORTIONS = {
  bilateral: ['FMA34677', 'FMA34678', 'FMA34679'],
  left: ['FMA34681', 'FMA34683', 'FMA34685'],
  right: ['FMA34680', 'FMA34682', 'FMA34684'],
};
