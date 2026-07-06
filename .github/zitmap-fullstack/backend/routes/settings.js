const express = require('express');
const db = require('../db/database');
const { requireAuth, requireAdmin, requireResourceAccess } = require('../middleware/auth');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    res.json(await db.getSettings());
  } catch (err) {
    console.error('GET /api/settings failed:', err);
    res.status(500).json({ error: 'Could not load settings' });
  }
});

router.put('/', requireAuth, requireAdmin, requireResourceAccess('settings'), async (req, res) => {
  try {
    const {
      portalName, contactEmail, contactPhone, officeAddress, workingHours,
      facebook, youtube, tiktok,
      welcomeMsg, selfReg, privacyPolicy, aboutUs, termsConditions,
      term1Start, term1End, term2Start, term2End, term3Start, term3End,
    } = req.body;

    // Only include fields that were actually sent in this request — a
    // partial update (e.g. just portalName) must not blank out every
    // other setting that wasn't included in the payload.
    const rawPatch = {
      portal_name: portalName, contact_email: contactEmail, contact_phone: contactPhone,
      office_address: officeAddress, working_hours: workingHours,
      facebook, youtube, tiktok,
      welcome_msg: welcomeMsg, self_reg: selfReg, privacy_policy: privacyPolicy,
      about_us: aboutUs, terms_conditions: termsConditions,
      term1_start: term1Start, term1_end: term1End,
      term2_start: term2Start, term2_end: term2End,
      term3_start: term3Start, term3_end: term3End,
    };
    const patch = {};
    Object.keys(rawPatch).forEach((k) => { if (rawPatch[k] !== undefined) patch[k] = rawPatch[k]; });

    const updated = await db.setSettings(patch);
    res.json({ message: 'Settings saved', settings: updated });
  } catch (err) {
    console.error('PUT /api/settings failed:', err);
    res.status(500).json({ error: 'Could not save settings' });
  }
});

module.exports = router;
