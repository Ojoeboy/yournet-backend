const express = require('express');
const jwt = require('jsonwebtoken');
const { verifyPassword } = require('../utils/passwordHash');
const validate = require('../utils/validate');

const router = express.Router();

// This is YOU (the platform owner), not a tenant. Separate credentials,
// separate token, separate secret - so a leaked tenant JWT_SECRET can
// never be used to forge owner access, and vice versa.
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const missingError = validate.required(req.body, ['username', 'password']);
  if (missingError) return res.status(400).json({ error: missingError });

  const validUsername = username === process.env.OWNER_USERNAME;
  const validPassword = verifyPassword(password, process.env.OWNER_PASSWORD_HASH);

  if (!validUsername || !validPassword) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = jwt.sign({ role: 'owner' }, process.env.OWNER_JWT_SECRET, { expiresIn: '4h' });
  res.json({ token });
});

module.exports = router;
