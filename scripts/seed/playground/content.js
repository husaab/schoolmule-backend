// scripts/seed/playground/content.js
//
// The hand-written part of the PLAYGROUND seed: staff, subjects, gradebook
// templates, calendar, quizzes and the words used in posts and threads.
// Everyone here is fictional; every address is on the reserved .test domain
// (utils/emailUtils.js never sends to it). generate.js turns this into SQL.

const DOMAIN = 'playground.test';
const STUDENT_DOMAIN = `students.${DOMAIN}`;
const PASSWORD = 'Playground2026!';
const YEAR_LABEL = '2026-2027';

// key, first, last, email (null = first.last@DOMAIN), base role, title, homeroom grade, avatar
const STAFF = [
  { key: 'admin', first: 'Nadia', last: 'Karim', email: `admin@${DOMAIN}`, role: 'ADMIN', title: 'Principal', avatar: ['hijab', 2, 5] },
  { key: 'vp', first: 'Yusuf', last: 'Rahman', role: 'ADMIN', title: 'Vice Principal', avatar: ['beard', 3, 1] },
  { key: 'office', first: 'Huda', last: 'Saleem', role: 'ADMIN', title: 'Office Manager', officeRole: true, avatar: ['hijab', 1, 6] },
  { key: 'jk', first: 'Mona', last: 'Aziz', role: 'TEACHER', homeroom: 'JK', avatar: ['hijab', 2, 3] },
  { key: 'sk', first: 'Rana', last: 'Khalil', role: 'TEACHER', homeroom: 'SK', avatar: ['long', 1, 4] },
  { key: 'g1', first: 'Hiba', last: 'Nasser', role: 'TEACHER', homeroom: '1', avatar: ['hijab', 3, 2] },
  { key: 'g2', first: 'Maryam', last: 'Darwish', role: 'TEACHER', homeroom: '2', avatar: ['hijab', 1, 7] },
  { key: 'g3', first: 'Samira', last: 'Odeh', role: 'TEACHER', homeroom: '3', avatar: ['long', 2, 0] },
  { key: 'g4', first: 'Bilal', last: 'Hamdan', role: 'TEACHER', homeroom: '4', avatar: ['beard', 2, 2] },
  { key: 'g5', first: 'Layla', last: 'Saleh', email: `teacher@${DOMAIN}`, role: 'TEACHER', homeroom: '5', avatar: ['hijab', 2, 1] },
  { key: 'g6', first: 'Omar', last: 'Farouk', role: 'TEACHER', homeroom: '6', avatar: ['short', 3, 3] },
  { key: 'g7', first: 'Zainab', last: 'Kassem', role: 'TEACHER', homeroom: '7', avatar: ['hijab', 4, 4] },
  { key: 'g8', first: 'Yousef', last: 'Barakat', role: 'TEACHER', homeroom: '8', avatar: ['kufi', 2, 5] },
  { key: 'fr', first: 'Claire', last: 'Dubois', role: 'TEACHER', subject: 'French', avatar: ['curly', 0, 6] },
  { key: 'ar', first: 'Ahmad', last: 'Mansour', role: 'TEACHER', subject: 'Arabic', avatar: ['beard', 2, 7] },
  // Arabic for JK to Grade 3, Islamic Studies in kindergarten.
  { key: 'ar2', first: 'Ruqayya', last: 'Hashemi', role: 'TEACHER', avatar: ['hijab', 0, 2] },
  { key: 'is', first: 'Hassan', last: 'Jaber', role: 'TEACHER', subject: 'Islamic Studies', avatar: ['kufi', 3, 0] },
  { key: 'pe', first: 'Daniel', last: 'Okafor', role: 'TEACHER', subject: 'Physical Education', avatar: ['short', 4, 2] },
  // Part-time: Mon, Tue, Thu, 6 hours a day.
  { key: 'art', first: 'Nour', last: 'Khoury', role: 'TEACHER', subject: 'Art', workDays: [1, 2, 4], hoursPerDay: 6, avatar: ['curly', 1, 5] },
];

// Accounts that signed up and are waiting in Approvals.
const PENDING_SIGNUPS = [
  { key: 'pending-parent-1', first: 'Sumaya', last: 'Qadri', role: 'PARENT', daysAgo: 2 },
  { key: 'pending-parent-2', first: 'Tamer', last: 'Hijazi', role: 'PARENT', daysAgo: 1 },
  { key: 'pending-teacher', first: 'Imran', last: 'Qadir', role: 'TEACHER', daysAgo: 3 },
];

const GRADES = ['JK', 'SK', '1', '2', '3', '4', '5', '6', '7', '8'];
const CLASS_SIZE = { JK: 8, SK: 9, 1: 12, 2: 12, 3: 11, 4: 12, 5: 12, 6: 11, 7: 12, 8: 11 };

// Who leads each subject. Homeroom teachers teach the core four of their
// grade, except Grade 6 Math (Layla Saleh) and Grade 7 Math (the VP).
const CORE = ['Math', 'Language Arts', 'Science', 'Social Studies'];
const leadFor = (grade, subject) => {
  if (grade === 'JK' || grade === 'SK') return subject === 'Arabic' || subject === 'Islamic Studies' ? 'ar2' : grade.toLowerCase();
  if (subject === 'Arabic' && Number(grade) <= 3) return 'ar2';
  if (subject === 'Math' && grade === '6') return 'g5';
  if (subject === 'Math' && grade === '7') return 'vp';
  if (CORE.includes(subject) || subject === 'History & Geography') return `g${grade}`;
  return STAFF.find((s) => s.subject === subject).key;
};
const subjectsFor = (grade) => {
  if (grade === 'JK' || grade === 'SK') return ['Kindergarten', 'Arabic', 'Islamic Studies'];
  const social = Number(grade) >= 7 ? 'History & Geography' : 'Social Studies';
  return ['Math', 'Language Arts', 'Science', social, 'French', 'Arabic', 'Islamic Studies', 'Physical Education', 'Art'];
};
// Co-teachers (class_teachers): Bilal Hamdan helps in Grade 5 Science.
const CO_TEACHERS = [{ grade: '5', subject: 'Science', key: 'g4' }];
// Classes whose students and parents see the class average.
const SHOW_AVERAGE = [['5', 'Math'], ['7', 'Science']];

// Gradebook templates per subject family. Categories carry the weight
// (sums to 100); items: [category, name, max, week of term, kind].
// kind: plain | done | text | quiz | lab (text when past, file when upcoming).
const GRADEBOOK = {
  Math: {
    day: 2,
    categories: [['Homework', 15], ['Quizzes', 25], ['Unit Tests', 40], ['Projects', 20]],
    units: ['Unit 1 · Number sense', 'Unit 2 · Operations', 'Unit 3 · Fractions & decimals'],
    items: [
      ['Homework', 'Homework 1 · Number sense', 10, 2, 'done'],
      ['Homework', 'Homework 2 · Place value', 10, 3, 'done'],
      ['Homework', 'Homework 3 · Addition & subtraction', 10, 5, 'done'],
      ['Homework', 'Homework 4 · Multiplication', 10, 7, 'done'],
      ['Homework', 'Homework 5 · Division', 10, 9, 'done'],
      ['Homework', 'Homework 6 · Fractions', 10, 12, 'done'],
      ['Homework', 'Homework 7 · Decimals', 10, 15, 'done'],
      ['Quizzes', 'Quiz 1 · Place value', 20, 3, 'plain'],
      ['Quizzes', 'Quiz 2 · Operations', 20, 6, 'plain'],
      ['Quizzes', 'Quiz 3 · Multiplication facts', 20, 9, 'plain'],
      ['Quizzes', 'Quiz 4 · Fractions', 20, 13, 'plain'],
      ['Unit Tests', 'Unit 1 test · Number sense', 50, 4, 'plain'],
      ['Unit Tests', 'Unit 2 test · Operations', 50, 8, 'plain'],
      ['Unit Tests', 'Unit 3 test · Fractions', 50, 14, 'plain'],
      ['Unit Tests', 'Unit 4 test · Decimals & measurement', 50, 19, 'plain'],
      ['Projects', 'Project · Budget a class party', 25, 10, 'text'],
      ['Projects', 'Project · Measurement scavenger hunt', 25, 18, 'text'],
    ],
  },
  'Language Arts': {
    day: 1,
    categories: [['Reading', 30], ['Writing', 35], ['Oral Communication', 15], ['Spelling & Grammar', 20]],
    units: ['Unit 1 · Reading', 'Unit 2 · Writing workshop', 'Unit 3 · Novel study'],
    items: [
      ['Reading', 'Reading response · Chapters 1–3', 20, 2, 'text'],
      ['Reading', 'Reading response · Chapters 4–6', 20, 4, 'text'],
      ['Reading', 'Book report', 25, 8, 'text'],
      ['Reading', 'Reading comprehension check', 20, 11, 'plain'],
      ['Reading', 'Novel study', 25, 15, 'text'],
      ['Writing', 'Personal narrative', 25, 3, 'text'],
      ['Writing', 'Descriptive paragraph', 25, 5, 'text'],
      ['Writing', 'Persuasive letter', 25, 9, 'text'],
      ['Writing', 'Short story draft', 25, 13, 'text'],
      ['Writing', 'Final short story', 25, 18, 'text'],
      ['Oral Communication', 'Show and tell presentation', 10, 6, 'plain'],
      ['Oral Communication', 'Poetry recitation', 10, 12, 'plain'],
      ['Oral Communication', 'Book talk', 10, 19, 'plain'],
      ['Spelling & Grammar', 'Spelling test 1', 20, 2, 'plain'],
      ['Spelling & Grammar', 'Spelling test 2', 20, 4, 'plain'],
      ['Spelling & Grammar', 'Grammar quiz · Nouns & verbs', 20, 6, 'plain'],
      ['Spelling & Grammar', 'Spelling test 3', 20, 8, 'plain'],
      ['Spelling & Grammar', 'Grammar quiz · Punctuation', 20, 11, 'plain'],
      ['Spelling & Grammar', 'Spelling test 4', 20, 14, 'plain'],
    ],
  },
  Science: {
    day: 3,
    categories: [['Labs', 30], ['Quizzes', 20], ['Projects', 20], ['Tests', 30]],
    units: ['Unit 1 · Matter & energy', 'Unit 2 · Structures & mechanisms', 'Unit 3 · Life systems'],
    items: [
      ['Labs', 'Lab 1 · Observation skills', 20, 2, 'lab'],
      ['Labs', 'Lab 2 · States of matter', 20, 5, 'lab'],
      ['Labs', 'Lab 3 · Simple machines', 20, 9, 'lab'],
      ['Labs', 'Lab 4 · Plant growth', 20, 14, 'lab'],
      ['Quizzes', 'Quiz · Scientific method', 20, 3, 'quiz'],
      ['Quizzes', 'Quiz · Matter', 20, 6, 'quiz'],
      ['Quizzes', 'Quiz · Forces', 20, 10, 'quiz'],
      ['Quizzes', 'Quiz · Ecosystems', 20, 15, 'quiz'],
      ['Projects', 'Science fair proposal', 25, 8, 'text'],
      ['Projects', 'Ecosystem diorama', 25, 18, 'plain'],
      ['Tests', 'Unit test · Matter & energy', 50, 7, 'plain'],
      ['Tests', 'Unit test · Structures & mechanisms', 50, 12, 'plain'],
      ['Tests', 'Unit test · Life systems', 50, 19, 'plain'],
    ],
  },
  Social: {
    day: 4,
    categories: [['Assignments', 40], ['Projects', 30], ['Tests', 30]],
    units: ['Unit 1 · Communities', "Unit 2 · Canada's regions", 'Unit 3 · Early peoples'],
    items: [
      ['Assignments', 'Map skills worksheet', 20, 2, 'text'],
      ['Assignments', 'Community helpers chart', 20, 5, 'text'],
      ['Assignments', 'Timeline activity', 20, 8, 'text'],
      ['Assignments', 'Primary source analysis', 20, 12, 'text'],
      ['Assignments', 'Current events report', 20, 15, 'text'],
      ['Projects', 'My heritage project', 25, 9, 'text'],
      ['Projects', "Canada's regions poster", 25, 18, 'plain'],
      ['Tests', 'Unit test · Communities', 50, 6, 'plain'],
      ['Tests', "Unit test · Canada's regions", 50, 13, 'plain'],
      ['Tests', 'Unit test · Early peoples', 50, 19, 'plain'],
    ],
  },
  French: {
    day: 1,
    categories: [['Oral', 30], ['Written', 40], ['Quizzes', 30]],
    units: ['Unité 1 · Moi et ma famille', "Unité 2 · À l'école", 'Unité 3 · Les saisons'],
    items: [
      ['Oral', 'Présentation · Ma famille', 10, 4, 'plain'],
      ['Oral', 'Dialogue · Au café', 10, 10, 'plain'],
      ['Oral', 'Présentation · Mon école', 10, 15, 'plain'],
      ['Written', 'Écriture · Ma journée', 20, 3, 'plain'],
      ['Written', 'Vocabulaire · Les couleurs', 20, 5, 'plain'],
      ['Written', 'Écriture · Mes loisirs', 20, 9, 'plain'],
      ['Written', 'Dictée', 20, 12, 'plain'],
      ['Written', 'Écriture · Les saisons', 20, 18, 'plain'],
      ['Quizzes', 'Quiz · Les nombres', 20, 2, 'plain'],
      ['Quizzes', 'Quiz · Les verbes en -er', 20, 7, 'plain'],
      ['Quizzes', 'Quiz · Les animaux', 20, 13, 'plain'],
    ],
  },
  Arabic: {
    day: 2,
    categories: [['Reading', 35], ['Writing', 35], ['Vocabulary', 30]],
    units: ['Unit 1 · Letters & sounds', 'Unit 2 · Reading', 'Unit 3 · Writing'],
    items: [
      ['Reading', 'Reading · Letters review', 10, 2, 'plain'],
      ['Reading', 'Reading · Short vowels', 10, 5, 'plain'],
      ['Reading', 'Reading passage 1', 10, 9, 'plain'],
      ['Reading', 'Reading passage 2', 10, 14, 'plain'],
      ['Writing', 'Writing · Letter forms', 10, 3, 'plain'],
      ['Writing', 'Dictation 1', 10, 6, 'plain'],
      ['Writing', 'Dictation 2', 10, 10, 'plain'],
      ['Writing', 'Writing · My family', 10, 15, 'plain'],
      ['Vocabulary', 'Vocabulary quiz · Colours', 20, 4, 'plain'],
      ['Vocabulary', 'Vocabulary quiz · At home', 20, 8, 'plain'],
      ['Vocabulary', 'Vocabulary quiz · At school', 20, 13, 'plain'],
    ],
  },
  Islamic: {
    day: 5,
    categories: [['Memorization', 35], ['Assignments', 30], ['Tests', 35]],
    units: ['Unit 1 · Pillars of Islam', 'Unit 2 · Stories of the Prophets', 'Unit 3 · Worship'],
    items: [
      ['Memorization', 'Memorization · Surah Al-Fatiha', 10, 2, 'plain'],
      ['Memorization', 'Memorization · Surah Al-Ikhlas', 10, 4, 'plain'],
      ['Memorization', 'Memorization · Surah Al-Falaq', 10, 7, 'plain'],
      ['Memorization', 'Memorization · Surah An-Nas', 10, 10, 'plain'],
      ['Memorization', 'Memorization · Surah Al-Asr', 10, 14, 'plain'],
      ['Assignments', 'Pillars of Islam worksheet', 20, 3, 'plain'],
      ['Assignments', 'Prophet stories reflection', 20, 6, 'plain'],
      ['Assignments', 'Akhlaq (manners) journal', 20, 11, 'plain'],
      ['Assignments', 'Getting ready for Ramadan', 20, 18, 'plain'],
      ['Tests', 'Unit test · Pillars of Islam', 50, 8, 'plain'],
      ['Tests', 'Unit test · Prophets', 50, 13, 'plain'],
      ['Tests', 'Unit test · Wudu & Salah', 50, 19, 'plain'],
    ],
  },
  PE: {
    day: 3,
    categories: [['Participation', 50], ['Skills', 50]],
    units: ['Fitness', 'Team sports', 'Gymnastics'],
    items: [
      ['Participation', 'Participation · September', 10, 4, 'plain'],
      ['Participation', 'Participation · October', 10, 8, 'plain'],
      ['Participation', 'Participation · November', 10, 12, 'plain'],
      ['Participation', 'Participation · December', 10, 15, 'plain'],
      ['Skills', 'Skills · Running & fitness', 10, 5, 'plain'],
      ['Skills', 'Skills · Basketball', 10, 10, 'plain'],
      ['Skills', 'Skills · Volleyball', 10, 14, 'plain'],
      ['Skills', 'Skills · Gymnastics', 10, 19, 'plain'],
    ],
  },
  Art: {
    day: 4,
    categories: [['Projects', 70], ['Sketchbook', 30]],
    units: ['Drawing', 'Painting', 'Sculpture & patterns'],
    items: [
      ['Projects', 'Self-portrait', 25, 4, 'plain'],
      ['Projects', 'Colour wheel painting', 25, 8, 'plain'],
      ['Projects', 'Clay sculpture', 25, 13, 'plain'],
      ['Projects', 'Islamic geometric patterns', 25, 18, 'plain'],
      ['Sketchbook', 'Sketchbook check 1', 10, 6, 'plain'],
      ['Sketchbook', 'Sketchbook check 2', 10, 12, 'plain'],
      ['Sketchbook', 'Sketchbook check 3', 10, 19, 'plain'],
    ],
  },
};
const FAMILY_OF_SUBJECT = {
  Math: 'Math', 'Language Arts': 'Language Arts', Science: 'Science', 'Social Studies': 'Social',
  'History & Geography': 'Social', French: 'French', Arabic: 'Arabic', 'Islamic Studies': 'Islamic',
  'Physical Education': 'PE', Art: 'Art',
};

// What a turn-in item asks for, by template kind and category.
const INSTRUCTIONS = {
  done: 'Complete the worksheet in your duotang, then press Mark as done. Bring the paper copy to class.',
  text: 'Type your answer in the box below. Write in full sentences and check your spelling before you turn it in.',
  lab: 'Write up your lab: your question, your prediction, what you observed and what you concluded. Upcoming labs: upload a clear photo of your lab sheet.',
  quiz: 'One try only. Read every question carefully; you can save and come back before you turn it in.',
};
const TEXT_ANSWERS = [
  'I think the most important part was the conclusion. We found that our prediction was mostly right, but the results changed when we repeated it a second time.',
  'My answer is that the main character changes a lot. At the start she is shy, but by the end she speaks up for her friend in front of the whole class.',
  'First I made a plan, then I tested it. It worked better the second time because I measured more carefully.',
  'Our community has many helpers: the crossing guard, the librarian, the nurse and the firefighters. Each one keeps us safe or helps us learn.',
  'I chose this topic because my family visits the lake every summer. I described the sound of the waves, the smell of the pine trees and the cold water on my feet.',
  'To solve it I broke the big number into hundreds, tens and ones, then added each part. I checked my answer with the inverse operation.',
];
const FEEDBACK = [
  'Great work — your explanation is clear and complete.',
  'Nice effort! Check your units next time.',
  'Good start. Add more detail to your conclusion.',
  'Excellent! Well organized and neat.',
  'Please see me about question 3 — let’s go over it together.',
  'Watch the spelling of key vocabulary words.',
  'Very thoughtful answer. I like how you used evidence from the text.',
];

// Science quizzes: 4 questions each (one 4, many 6 with partial credit,
// short 4, long 6) = 20 points, matching the template's max.
const SCIENCE_QUIZZES = {
  'Quiz · Scientific method': [
    ['one', 'What is the first step of the scientific method?', ['Make a hypothesis', 'Ask a question', 'Draw a conclusion', 'Record data'], ['b']],
    ['many', 'Which of these could you change in a plant-growth experiment?', ['Amount of water', 'Amount of sunlight', "The plant's name", 'Type of soil'], ['a', 'b', 'd']],
    ['short', 'A testable prediction is called a ____.', null, ['hypothesis', 'a hypothesis']],
    ['long', 'Describe a fair test you could do to find out which paper towel absorbs the most water.'],
  ],
  'Quiz · Matter': [
    ['one', 'Which state of matter has a definite shape?', ['Solid', 'Liquid', 'Gas', 'Plasma'], ['a']],
    ['many', 'Which of these are physical changes?', ['Melting ice', 'Burning wood', 'Cutting paper', 'Dissolving sugar in water'], ['a', 'c', 'd']],
    ['short', 'Water turning into water vapour is called ____.', null, ['evaporation']],
    ['long', 'Explain the difference between a physical change and a chemical change. Give one example of each.'],
  ],
  'Quiz · Forces': [
    ['one', 'Which force pulls objects toward the Earth?', ['Friction', 'Magnetism', 'Gravity', 'Tension'], ['c']],
    ['many', 'Which of these are simple machines?', ['Lever', 'Pulley', 'Bicycle', 'Inclined plane'], ['a', 'b', 'd']],
    ['short', 'The force that slows down a sliding object is called ____.', null, ['friction']],
    ['long', 'Explain how a ramp makes it easier to move a heavy box onto a truck.'],
  ],
  'Quiz · Ecosystems': [
    ['one', 'Which organism is a producer?', ['Hawk', 'Grass', 'Mushroom', 'Rabbit'], ['b']],
    ['many', 'Which of these are decomposers?', ['Earthworms', 'Fungi', 'Bacteria', 'Deer'], ['a', 'b', 'c']],
    ['short', 'An animal that eats only plants is called a ____.', null, ['herbivore', 'a herbivore']],
    ['long', 'Describe a food chain from a forest ecosystem and explain what would happen if one link disappeared.'],
  ],
};
const LONG_ANSWERS = [
  'I would use three paper towels of the same size and pour the same amount of water on each one. Then I would measure how much water is left in the cup after one minute.',
  'A physical change only changes how something looks, like ice melting. A chemical change makes something new, like wood burning into ash and smoke.',
  'The ramp spreads the work over a longer distance, so you need less force to push the box up than to lift it straight up.',
  'Grass is eaten by a rabbit, and the rabbit is eaten by a fox. If the rabbits disappeared, the foxes would go hungry and the grass would grow too much.',
];

// Links for materials, by subject family.
const MATERIALS = {
  Math: [['Times tables practice', 'Practise for five minutes a day. Try to beat your own score!', 'https://www.mathplayground.com/', 'Math Playground'], ['Fractions videos', 'Watch these before the fractions unit.', 'https://www.khanacademy.org/math', 'Khan Academy · Math']],
  'Language Arts': [['Stories read aloud', 'Pick any story and listen at home.', 'https://storylineonline.net/', 'Storyline Online']],
  Science: [['Climate Kids', 'Explore the weather and climate games.', 'https://climatekids.nasa.gov/', 'NASA Climate Kids'], ['Animals and habitats', 'Use this for the ecosystem diorama research.', 'https://kids.nationalgeographic.com/', 'National Geographic Kids']],
  Social: [['Interactive map of Canada', 'Find each province and its capital.', 'https://www.canada.ca/en.html', 'Government of Canada']],
  French: [['Écoute et répète', 'Practise the vocabulary from this week.', 'https://www.tv5monde.com/', 'TV5MONDE']],
  Arabic: [['Arabic letters song', 'Sing along to review the letters.', 'https://www.youtube.com/results?search_query=arabic+alphabet+song', 'Arabic alphabet songs']],
  Islamic: [['Stories of the Prophets', 'Read one story with your family this week.', 'https://www.youtube.com/results?search_query=stories+of+the+prophets+for+kids', 'Stories for kids']],
  PE: [['At-home warm-up', 'Do this warm-up before practice.', 'https://www.gonoodle.com/', 'GoNoodle']],
  Art: [['Colour wheel guide', 'Primary, secondary and tertiary colours.', 'https://www.tate.org.uk/kids', 'Tate Kids']],
  Kindergarten: [['Songs we sing in class', 'Our favourite songs — sing them at home!', 'https://www.youtube.com/results?search_query=kindergarten+songs', 'Kindergarten songs']],
};

// Closed days and events. [start, end|null, title, category, closed, staffDay, notes]
const CALENDAR = [
  ['2026-09-07', null, 'Labour Day', 'holiday', true, 'paid', null],
  ['2026-09-08', null, 'First day of school', 'event', false, 'off', 'Doors open at 8:15. Kindergarten families: staggered entry this week.'],
  ['2026-09-18', null, 'Meet the Teacher night', 'event', false, 'off', '6:00–7:30 pm in the gym, then classroom visits.'],
  ['2026-09-24', null, 'Picture Day', 'event', false, 'off', 'Full uniform please.'],
  ['2026-09-30', null, 'Orange Shirt Day', 'other', false, 'off', 'National Day for Truth and Reconciliation. Wear orange.'],
  ['2026-10-09', null, 'PA Day — no school for students', 'pa-day', true, 'work', 'Staff professional development.'],
  ['2026-10-12', null, 'Thanksgiving', 'holiday', true, 'paid', null],
  ['2026-10-23', null, 'Grade 5 trip · Royal Ontario Museum', 'event', false, 'off', 'Bus leaves at 8:45, back by 2:30. Pack a lunch.'],
  ['2026-10-30', null, 'Fall Fun Fair', 'event', false, 'off', 'Games, food and a bake sale. Volunteers welcome.'],
  ['2026-11-06', null, 'Progress reports go home', 'event', false, 'off', null],
  ['2026-11-11', null, 'Remembrance Day assembly', 'event', false, 'off', '10:45 in the gym.'],
  ['2026-11-19', '2026-11-20', 'Parent–teacher interviews', 'event', false, 'off', 'Book a time through the parent portal.'],
  ['2026-11-20', null, 'PA Day — interviews', 'pa-day', true, 'work', null],
  ['2026-12-11', null, 'Winter concert', 'event', false, 'off', '6:30 pm. Doors open at 6.'],
  ['2026-12-21', '2027-01-01', 'Winter break', 'holiday', true, 'off', 'School reopens Monday, January 4.'],
  ['2027-01-15', null, 'Science fair', 'event', false, 'off', 'Grades 4–8 in the gym; families welcome from 1 pm.'],
  ['2027-01-25', '2027-01-28', 'End-of-term assessments', 'exam', false, 'off', null],
  ['2027-01-29', null, 'Last day of Term 1', 'event', false, 'off', null],
  ['2027-02-01', null, 'Term 2 begins', 'event', false, 'off', null],
  ['2027-02-08', null, 'Ramadan begins (tentative)', 'other', false, 'off', 'Shortened lunch for fasting students.'],
  ['2027-02-12', null, 'Report cards go home', 'event', false, 'off', null],
  ['2027-02-15', null, 'Family Day', 'holiday', true, 'paid', null],
  ['2027-03-10', null, 'Eid al-Fitr (tentative)', 'holiday', true, 'paid', 'Date depends on the moon sighting.'],
  ['2027-03-15', '2027-03-19', 'March break', 'holiday', true, 'off', null],
  ['2027-03-26', null, 'Good Friday', 'holiday', true, 'paid', null],
  ['2027-04-23', null, 'PA Day — no school for students', 'pa-day', true, 'work', null],
  ['2027-05-17', null, 'Eid al-Adha (tentative)', 'holiday', true, 'paid', null],
  ['2027-05-24', null, 'Victoria Day', 'holiday', true, 'paid', null],
  ['2027-06-04', null, 'Sports Day', 'event', false, 'off', 'Rain date June 7.'],
  ['2027-06-18', null, 'Grade 8 graduation', 'event', false, 'off', '6 pm at the community hall.'],
  ['2027-06-25', null, 'Last day of school', 'event', false, 'off', 'Half day — dismissal at 12:00.'],
  ['2027-06-28', null, 'PA Day', 'pa-day', true, 'work', null],
];
const TERMS = [
  { no: 1, name: 'Term 1', start: '2026-09-08', end: '2027-01-29', monday: '2026-09-07' },
  { no: 2, name: 'Term 2', start: '2027-02-01', end: '2027-06-25', monday: '2027-02-01' },
];

// The day: seven 45-minute periods (six on Friday, for Jumu'ah).
const PERIODS = [[510, 555], [555, 600], [615, 660], [660, 705], [750, 795], [795, 840], [840, 885]];
const FIXED_BLOCKS = [
  ['Recess', [1, 2, 3, 4, 5], 600, 615],
  ['Lunch & Salah', [1, 2, 3, 4, 5], 705, 750],
  ["Jumu'ah prayer", [5], 750, 795],
];
const PERIODS_PER_WEEK = { 'Math': 6, 'Language Arts': 7, 'Science': 4, 'Social Studies': 4, 'History & Geography': 4, 'French': 3, 'Arabic': 3, 'Islamic Studies': 3, 'Physical Education': 2, 'Art': 2 };
// Kindergarten's homeroom time is two timetable courses (the planner caps a
// course at 20 sessions a week); the class itself is one "Kindergarten" class.
const K_PERIODS = { 'Circle & Literacy': 15, 'Play & Centres': 15, Arabic: 2, 'Islamic Studies': 2 };
const K_HOMEROOM = ['Circle & Literacy', 'Play & Centres'];
const ROOM_OF = (grade, subject) => {
  if (subject === 'Physical Education') return 'Gym';
  if (subject === 'Art') return 'Art Room';
  if (grade === 'JK') return 'Kindergarten Room A';
  if (grade === 'SK') return 'Kindergarten Room B';
  return `Room ${100 + Number(grade)}`;
};

// JK and SK skill frameworks (per school, not per year).
const JK_DOMAINS = {
  progress_report: [
    ['Language and Communication Skills', ['Speaks clearly and fluently.', 'Responds to direct questions.', 'Follows routines.', 'Engages in conversations.', 'Expands vocabulary.', 'Expresses thoughts and ideas.']],
    ['Social Skills', ['Knows first name, last name and age.', 'Interacts well with peers.', 'Demonstrates good manners.', 'Follows classroom rules.', 'Shares well with others and takes turns.', 'Listens and responds to others.']],
    ['Emotional Development', ['Expresses emotions appropriately.', 'Demonstrates independence.', 'Shows empathy towards others.', 'Copes with frustration and disappointment.']],
    ['Reading and Writing Skills', ['Knows how to say the ABCs.', 'Recognizes the ABCs.', 'Can print first name.', 'Can print last name.']],
    ['Colours and Shapes', ['Knows primary colours.', 'Knows shapes.', 'Understands sizes (big/small).']],
    ['Numbers', ['Recognizes numbers one to ten.', 'Understands empty and full.', 'Understands more or less.']],
    ['Fine Motor Skills', ['Holds and uses a pencil or crayon.', 'Holds and uses scissors.', 'Cuts and pastes with coordination.', 'Manipulates small objects.', 'Demonstrates hand-eye coordination.']],
  ],
  report_card: [
    ['Approaches to Learning', ['Play/Curiosity', 'Persistence', 'Self-Organization', 'Reasoning', 'Application']],
    ['Social/Emotional Development', ['Self-Concept', 'Self-Control', 'Interactions with Others', 'Sense of Community', 'Self-Expression', 'Empathy']],
    ['Language Development & Communication', ['Listening & Understanding', 'Verbal Interaction', 'Speaking & Communicating', 'Initiating Communication']],
    ['Literacy', ['Writing', 'Reading', 'Phonemic & Phonological Awareness', 'Book Knowledge & Comprehension', 'Print Awareness & Concepts']],
    ['Mathematics', ['Number Sense', 'Measurement', 'Geometry & Spatial Sense', 'Patterning']],
  ],
};
const SK_SUBJECTS = {
  progress_report: [
    ['Mathematics', ['Counts to 100 by ones and tens', 'Writes numbers from 0 to 100', 'Demonstrates one-to-one correspondence', 'Identifies and describes shapes', 'Builds and draws shapes']],
    ['Language', ['Waits and takes turns during conversations', 'Clearly communicates needs and thoughts', 'Understands and uses question words', 'Follows multiple-step instructions']],
    ['Literacy - Reading', ['Recognizes and names all upper and lowercase letters', 'Reads common high-frequency words by sight', 'Recognizes and produces rhyming words', 'Produces the primary sound for each consonant']],
    ['Literacy - Writing', ['Prints all upper and lowercase letters correctly', 'Spells simple words phonetically', 'Expresses an idea using pictures', 'Independently forms sentences']],
    ['Science and Social Studies', ['Participates in class discussions', 'Asks questions through simple investigations', 'Makes simple observations']],
    ['Islamic Studies', ['Shows good values by caring, sharing and taking turns', 'Shows understanding of and interest in Islamic stories']],
    ['Arabic and Quran', ['Recognizes and writes Arabic letters', 'Memorizes and pronounces surahs independently']],
    ['French', ['Recognizes and writes French letters', 'Uses basic vocabulary']],
  ],
  report_card: [
    ['Mathematics - Counting and Cardinality', ['Counts to 100 by ones and tens', 'Counts groups of up to 20 objects accurately', 'Fluently adds within 10', 'Fluently subtracts within 10']],
    ['English/Language Arts - Reading', ['Retells familiar stories', 'Identifies characters, settings and major events', 'Makes connections between self, text and the world']],
    ['English/Language Arts - Writing', ['Uses drawing, dictating and writing to share information', 'Uses drawing, dictating and writing to tell a story']],
    ['Social Skills and Work Habits', ['Shows enthusiasm for learning', 'Demonstrates appropriate self-control', 'Follows instructions with minimal supervision', 'Displays respect and cooperation']],
  ],
};
const LEARNING_SKILLS = ['Responsibility', 'Organization', 'Independent Work', 'Initiative', 'Collaboration', 'Self-Regulation'];

// Progress-report comment openings by level (first name only, no pronouns).
const PROGRESS_COMMENTS = {
  high: [
    '{first} has made an excellent start to the year in {subject}. {first} works independently, explains thinking clearly and is a positive role model for classmates.',
    '{first} consistently produces high-quality work in {subject} and takes on challenges with enthusiasm. Keep up the outstanding effort!',
  ],
  mid: [
    '{first} is meeting expectations in {subject} and participates well in class discussions. A next step is to check work carefully before handing it in.',
    '{first} shows a good understanding of the key ideas in {subject}. Reviewing class notes at home each week will help build even more confidence.',
  ],
  low: [
    '{first} is working towards the expectations in {subject}. With regular practice at home and asking for help when stuck, {first} will continue to grow.',
    '{first} is building skills in {subject}. Completing homework on time and reading instructions closely are important next steps for {first}.',
  ],
};
const JK_COMMENTS = {
  academic_achievement: '{first} enjoys circle time and is beginning to recognize letters and numbers. {first} loves story time and joins in with songs and rhymes.',
  socio_emotional: '{first} has settled well into the classroom routine, plays happily with friends and is learning to share and take turns.',
};

// Posts. scope: school | grade | class | custom; by: staff key; daysAgo
// (from today); class: [grade, subject]; ack: asks for "Got it";
// pinDays: pinned until today + n; custom: student keys (filled in generate.js).
const ANNOUNCEMENTS = [
  { key: 'welcome', scope: 'school', by: 'admin', daysAgo: 48, title: 'Welcome to the 2026–2027 school year!', body: 'Assalamu alaikum and welcome back! We are excited to start a new year together. Please check the calendar for important dates and make sure your contact information is up to date in the parent portal.' },
  { key: 'picture-day', scope: 'school', by: 'office', daysAgo: 33, title: 'Picture Day — Thursday, September 24', body: 'Picture Day is next Thursday. Students should wear full uniform. Order forms went home in backpacks today; online ordering is also available.' },
  { key: 'thanksgiving', scope: 'school', by: 'admin', daysAgo: 14, title: 'Long weekend: PA Day and Thanksgiving', body: 'Reminder that there is no school on Friday, October 9 (PA Day) or Monday, October 12 (Thanksgiving). Classes resume Tuesday, October 13. Enjoy the long weekend!' },
  { key: 'fun-fair', scope: 'school', by: 'vp', daysAgo: 5, title: 'Fall Fun Fair — volunteers needed', body: 'Our Fall Fun Fair is on Friday, October 30. We need parent volunteers for the game booths and the bake sale. Reply to this post or contact the office if you can help for an hour.' },
  { key: 'interviews', scope: 'school', by: 'admin', daysAgo: 1, ack: true, pinDays: 31, title: 'Parent–teacher interviews: booking opens November 2', body: 'Interviews take place on Thursday, November 19 (evening) and Friday, November 20. Booking opens in the parent portal on November 2. Please press "Got it" so we know you have seen this.' },
  { key: 'hot-lunch', scope: 'school', by: 'office', daysAgo: 0, title: 'Hot lunch orders due Friday', body: 'November hot lunch orders are due this Friday. Menus are posted on the office door and in the parent portal.' },
  { key: 'g5-trip', scope: 'grade', grade: '5', by: 'g5', daysAgo: 7, ack: true, title: 'Grade 5 trip to the Royal Ontario Museum — Friday, Oct 23', body: 'Grade 5 is visiting the ROM this Friday as part of our Science unit. Please return the signed permission form and pack a nut-free lunch. Press "Got it" once you have read this.' },
  { key: 'g8-grad', scope: 'grade', grade: '8', by: 'g8', daysAgo: 12, title: 'Grade 8 graduation committee — first meeting', body: 'The graduation committee meets every second Wednesday at lunch, starting next week. All Grade 8 students are welcome to join.' },
  { key: 'sk-pajama', scope: 'grade', grade: 'SK', by: 'sk', daysAgo: 1, title: 'SK pajama & book day this Friday', body: 'Friday is pajama and book day in SK! Send your child in comfy pajamas with a favourite book to share.' },
  { key: 'g5-math-tables', scope: 'class', class: ['5', 'Math'], by: 'g5', daysAgo: 11, title: 'Times tables challenge starts Monday', body: 'Starting Monday we are doing a two-week times tables challenge. Practise for five minutes a day using the link in Classwork. Small prizes for everyone who improves!' },
  { key: 'g5-sci-leaf', scope: 'class', class: ['5', 'Science'], by: 'g5', daysAgo: 0, ack: true, title: 'Bring a leaf on Thursday', body: 'We are looking at real plant cells under the microscope on Thursday. Please bring one fresh leaf from home in a zip bag.' },
  { key: 'g5-la-bookfair', scope: 'class', class: ['5', 'Language Arts'], by: 'g5', daysAgo: 6, title: 'Book fair this week', body: 'The Scholastic book fair is in the library all week. Our class visits on Wednesday afternoon.' },
  { key: 'g6-math-test', scope: 'class', class: ['6', 'Math'], by: 'g5', daysAgo: 4, title: 'Unit 2 test moved to next Thursday', body: 'Because of the PA day, the Unit 2 test is moving to next Thursday. We will review in class on Tuesday and Wednesday.' },
  { key: 'g2-reading-logs', scope: 'class', class: ['2', 'Language Arts'], by: 'g2', daysAgo: 29, title: 'Reading logs go home every Monday', body: 'Reading logs go home every Monday and come back on Friday. Please read with your child for 15 minutes each night and initial the log.' },
  { key: 'g7-sci-fair', scope: 'class', class: ['7', 'Science'], by: 'g7', daysAgo: 15, title: 'Science fair proposals due November 2', body: 'Your science fair proposal is due November 2. Use the template in Classwork and talk to me if you need help choosing a question.' },
  { key: 'g1-arabic-letter', scope: 'class', class: ['1', 'Arabic'], by: 'ar2', daysAgo: 1, title: 'Letter of the week: ب', body: 'This week we are learning the letter ب (baa). Ask your child to show you how it is written at the start, middle and end of a word.' },
  { key: 'math-club', scope: 'custom', by: 'vp', daysAgo: 8, title: 'Math club — you are invited!', body: 'You have been invited to join Math Club on Tuesdays at lunch in Room 107. We will work on puzzles and get ready for the spring math contest.' },
];

// Threads. kind: general | assessment | item; with: staff key; family member
// keys resolve in generate.js. messages: [who, minutesAgo, body] where who is
// 'parent' | 'teacher' | 'student' | 'father'.
const THREADS = [
  { key: 'adam-absence', kind: 'general', student: 'adam', class: ['5', 'Math'], with: 'g5', starter: 'parent', title: 'Adam missed Tuesday', messages: [
    ['parent', 30240, 'Salam Ms. Saleh, Adam was at a medical appointment on Tuesday. Could you tell me what he missed in Math and Science?'],
    ['teacher', 30000, 'Wa alaikum salam! No problem. We wrote the Unit 1 test in Math, so Adam can write it on Thursday at lunch. In Science we started the matter unit — the notes are in Classwork.'],
    ['parent', 29900, 'Thank you so much, Thursday works.'],
  ] },
  { key: 'adam-unit1', kind: 'assessment', student: 'adam', class: ['5', 'Math'], assessment: 'Unit 1 test · Number sense', with: 'g5', starter: 'parent', title: 'Unit 1 test · Number sense', unreadFor: 'teacher', messages: [
    ['parent', 2880, 'Hi Ms. Saleh, Adam was disappointed with his Unit 1 test. Is there anything he can do to improve before the next one?'],
    ['teacher', 2700, 'Adam understood the place value questions well. Most of the marks he lost were on rounding. I would practise rounding to the nearest ten and hundred — there is a link in Classwork.'],
    ['parent', 2600, 'Thank you, that helps. Would a retest be possible?'],
    ['parent', 95, 'Just following up on the retest question when you have a moment.'],
  ] },
  { key: 'karim-homework', kind: 'general', student: 'adam', class: ['5', 'Language Arts'], with: 'g5', starter: 'father', title: 'Homework load', resolved: true, messages: [
    ['father', 14400, 'Hello, Adam has been spending close to two hours a night on homework. Is that expected for Grade 5?'],
    ['teacher', 14100, 'Thanks for letting me know. Homework should take about 40 minutes. I will check in with Adam — he may be redoing work he already finished in class.'],
  ] },
  { key: 'adam-lab2', kind: 'item', student: 'adam', class: ['5', 'Science'], item: 'Lab 2 · States of matter', with: 'g5', starter: 'student', title: 'Lab 2 · States of matter', messages: [
    ['student', 9000, 'Ms. Saleh, I turned in my lab late because I was away. Is that okay?'],
    ['teacher', 8800, 'Yes, that is fine Adam. I left you some feedback — next time add a sentence about what surprised you.'],
    ['student', 8700, 'Okay thank you!'],
  ] },
  { key: 'lina-reading', kind: 'general', student: 'lina', class: ['2', 'Language Arts'], with: 'g2', starter: 'parent', title: "Lina's reading level", messages: [
    ['parent', 7200, 'Hi Ms. Darwish, how is Lina doing with her reading? She says the books are too easy.'],
    ['teacher', 7000, 'Lina is reading very well! I moved her up a level this week, so she should bring home more challenging books now.'],
    ['parent', 6900, 'Wonderful, thank you!'],
  ] },
  { key: 'sara-first-weeks', kind: 'general', student: 'sara', class: ['SK', 'Kindergarten'], with: 'sk', starter: 'teacher', title: "Sara's first weeks", unreadFor: 'parent', messages: [
    ['teacher', 1500, 'Just a quick note: Sara has settled in beautifully. She loves the painting centre and has made two good friends.'],
    ['teacher', 1490, 'She did ask for you at nap time on Monday, but she was fine after a story.'],
  ] },
  { key: 'adam-bus', kind: 'principal', student: 'adam', with: 'admin', starter: 'parent', title: 'Bus route question', messages: [
    ['parent', 4300, 'Salam, is there a school bus stop closer to Eglinton and Hurontario this year?'],
    ['teacher', 4100, 'Wa alaikum salam. Yes — the new stop is at Eglinton and Kennedy at 7:52 am. The office will send the updated route sheet home this week.'],
  ] },
];

module.exports = {
  DOMAIN, STUDENT_DOMAIN, PASSWORD, YEAR_LABEL, STAFF, PENDING_SIGNUPS, GRADES, CLASS_SIZE, CORE, leadFor,
  subjectsFor, CO_TEACHERS, SHOW_AVERAGE, GRADEBOOK, FAMILY_OF_SUBJECT, INSTRUCTIONS, TEXT_ANSWERS, FEEDBACK,
  SCIENCE_QUIZZES, LONG_ANSWERS, MATERIALS, CALENDAR, TERMS, PERIODS, FIXED_BLOCKS, PERIODS_PER_WEEK, K_PERIODS, K_HOMEROOM,
  ROOM_OF, JK_DOMAINS, SK_SUBJECTS, LEARNING_SKILLS, PROGRESS_COMMENTS, JK_COMMENTS, ANNOUNCEMENTS, THREADS,
};
