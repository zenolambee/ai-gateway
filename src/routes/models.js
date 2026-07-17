const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({
    object: 'list',
    data: [
      {
        id: 'deepseek-v4-flash',
        object: 'model',
      },
    ],
  });
});

module.exports = router;
