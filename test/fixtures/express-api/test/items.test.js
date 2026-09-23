const { test } = require('node:test')
const assert = require('node:assert/strict')
const router = require('../src/routes/items')

test('items router registers CRUD routes', () => {
  const paths = router.stack.map((layer) => `${Object.keys(layer.route.methods)[0]} ${layer.route.path}`)
  assert.deepEqual(paths, ['get /', 'post /', 'put /:id', 'delete /:id'])
})
