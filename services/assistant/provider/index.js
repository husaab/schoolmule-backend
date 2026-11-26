// services/assistant/provider/index.js
// The adapter Muley talks to the model through. Tests swap in a scripted one
// (__tests__/helpers/fakeProvider.js) so no test ever calls a real model.
const openaiAdapter = require('./openaiAdapter');

let adapter = openaiAdapter;

module.exports = {
  getAdapter: () => adapter,
  __setAdapterForTests: (replacement) => {
    adapter = replacement || openaiAdapter;
  },
};
