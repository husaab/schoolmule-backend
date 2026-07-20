const express = require('express');
const supabase = require('../config/supabaseClient');
const {
  upload,
  getAgendasBySchool,
  createAgenda,
  getAgendaById,
  updateAgenda,
  deleteAgenda,
  updateAgendaMonth,
  uploadCustomPage,
  reorderCustomPages,
  updateCustomPage,
  deleteCustomPage,
  getCustomPageSignedUrl,
  getAgendaManifest,
  renderMonthPages,
  generateAgenda,
  downloadGeneratedAgenda,
  cloneAgenda
} = require('../controllers/agenda.controller');

const router = express.Router();

// Signed URL for the assembled agenda PDF (before /:agendaId so 'signed-url'
// isn't captured as an ID)
router.get('/signed-url', async (req, res) => {
  const { path } = req.query;

  if (!path) return res.status(400).json({ error: 'Missing file path' });

  const { data, error } = await supabase
    .storage
    .from('agendas')
    .createSignedUrl(path, 60 * 10); // valid for 10 minutes

  if (error) return res.status(500).json({ error: error.message });

  res.json({ url: data.signedUrl });
});

router.get('/', getAgendasBySchool);
router.post('/', createAgenda);
router.get('/:agendaId', getAgendaById);
router.patch('/:agendaId', updateAgenda);
router.delete('/:agendaId', deleteAgenda);
router.post('/:agendaId/clone', cloneAgenda);

router.patch('/:agendaId/months/:month', updateAgendaMonth);

router.post('/:agendaId/pages', upload.single('file'), uploadCustomPage);
router.patch('/:agendaId/pages/reorder', reorderCustomPages);
router.patch('/:agendaId/pages/:pageId', updateCustomPage);
router.delete('/:agendaId/pages/:pageId', deleteCustomPage);
router.get('/:agendaId/pages/:pageId/signed-url', getCustomPageSignedUrl);

router.get('/:agendaId/manifest', getAgendaManifest);
router.get('/:agendaId/render/month/:month', renderMonthPages);
router.post('/:agendaId/generate', generateAgenda);
router.get('/:agendaId/download', downloadGeneratedAgenda);

module.exports = router;
