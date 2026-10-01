let paperOnly = false;

function setPaperOnly(value) {
  paperOnly = !!value;
  if (paperOnly) process.env.KT_PAPER_ONLY = '1';
  else delete process.env.KT_PAPER_ONLY;
}

function isPaperOnly() {
  return paperOnly || String(process.env.KT_PAPER_ONLY || '').trim() === '1';
}

module.exports = {
  setPaperOnly,
  isPaperOnly,
};
