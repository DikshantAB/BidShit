// Creates the BidShitter DevTools panel. Runs in the devtools page context.
chrome.devtools.panels.create('BidShitter', '', 'index.html', () => {
  // Panel created; the panel page (index.html) handles its own connection.
});
