const db = require('../config/database');
const parentQueries = require('../queries/parent.queries');
const logger = require('../logger');

async function getAllParents(req, res) {
  const school = req.query.school;
  if (!school) {
    return res.status(400).json({ status: 'failed', message: 'Missing school parameter' });
  }
  try {
    const { rows } = await db.query(parentQueries.selectParentsBySchool, [school]);
    const data = rows.map(u => ({
      userId:    u.user_id,
      firstName: u.first_name,
      lastName:  u.last_name,
      email:     u.email,
      school:    u.school,
      createdAt: u.created_at,
    }));
    logger.info(`Fetched ${data.length} parents for school ${school}`);
    res.status(200).json({ status: 'success', data });
  } catch (err) {
    logger.error('Error fetching parents:', err);
    res.status(500).json({ status: 'failed', message: 'Error fetching parents' });
  }
}

async function getParentById(req, res) {
  const { id } = req.params;
  try {
    const { rows } = await db.query(parentQueries.selectParentById, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ status: 'failed', message: `Parent with id ${id} not found` });
    }
    const u = rows[0];
    const data = {
      userId:    u.user_id,
      firstName: u.first_name,
      lastName:  u.last_name,
      email:     u.email,
      school:    u.school,
      createdAt: u.created_at,
    };
    logger.info(`Fetched parent ${id}`);
    res.status(200).json({ status: 'success', data });
  } catch (err) {
    logger.error(`Error fetching parent ${id}:`, err);
    res.status(500).json({ status: 'failed', message: 'Error fetching parent' });
  }
}

module.exports = { getAllParents, getParentById };
