export const GENERAL_WORKFLOW_CATEGORIES = [
  'Audio, video and presentations',
  'Data and statistics',
  'Design and visual communication',
  'Learning and teaching',
  'Planning and productivity',
  'Research and evidence',
  'Software and automation',
  'Sources, citations and knowledge management',
  'Thinking and decision-making',
  'Writing and communication',
];

export const FIELD_OF_KNOWLEDGE_CATEGORIES = [
  'Agriculture, food and veterinary research',
  'Earth and environmental sciences',
  'Economics, business and finance',
  'Engineering and technology',
  'Health and medicine',
  'Humanities and arts',
  'Law and public policy',
  'Life sciences',
  'Mathematics and computing',
  'Physical sciences',
  'Social and behavioural sciences',
];

export const OFFICIAL_SKILL_CATEGORIES = [
  ...GENERAL_WORKFLOW_CATEGORIES,
  ...FIELD_OF_KNOWLEDGE_CATEGORIES,
];

export const isOfficialSkillCategory = category => OFFICIAL_SKILL_CATEGORIES.includes(category);
