// Runs before first paint so a saved light/dark choice never flashes the other theme.
(function () {
  try {
    var t = JSON.parse(localStorage.getItem('mailean:theme') || '"system"');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* storage blocked: follow the system theme */ }
})();
