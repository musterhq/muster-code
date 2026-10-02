(function () {
  'use strict';
  var match = /^\/connect\/([A-Za-z0-9_-]{10,100})$/.exec(location.pathname);
  var $ = function (id) { return document.getElementById(id); };
  function say(title, text, isError) { $('title').textContent = title; $('subtitle').textContent = isError ? '' : text; if (isError) { $('error').textContent = text; $('error').hidden = false; } $('form').hidden = true; }
  if (!match) return say('Not found', 'This link is not valid.', true);
  var id = match[1], csrf = '';
  function json(r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); }
  fetch('/api/connect/challenges/' + id + '/info', { headers: { accept: 'application/json' } }).then(json).then(function (info) {
    if (!info.ok) return say('Request not found', 'This sign-in request is not valid or has expired. Start again in the Muster app.', true);
    if (info.j.status !== 'pending') return say('Request closed', info.j.status === 'approved' ? 'This request was already approved. You can close this window.' : 'This request is no longer open. Start again in the Muster app.', true);
    return fetch('/api/auth/me', { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(json).then(function (me) {
      if (!me.ok) { location.replace('/login?next=' + encodeURIComponent(location.pathname)); return; }
      csrf = me.j.csrf || '';
      $('subtitle').textContent = 'Signed in as ' + me.j.user.displayName + ' (@' + me.j.user.username + ').';
      $('who').textContent = '“' + info.j.clientName + '” wants to connect to this server as you. It will see what you can see and do what you can do.';
      $('form').hidden = false;
    });
  }).catch(function () { say('Could not reach the server', 'Check your connection and reload this page.', true); });
  $('form').addEventListener('submit', function (e) {
    e.preventDefault(); $('approve').disabled = true;
    fetch('/api/connect/challenges/' + id + '/approve', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-muster-csrf': csrf }, body: '{}' }).then(json).then(function (x) {
      if (x.ok) say('Connected', 'The Muster app is connected. You can close this window.', false); else say('Not approved', x.j.error || 'The request could not be approved.', true);
    }).catch(function () { say('Could not reach the server', 'Try again.', true); });
  });
  $('cancel').addEventListener('click', function () {
    fetch('/api/connect/challenges/' + id + '/decline', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-muster-csrf': csrf }, body: '{}' }).then(function () { say('Cancelled', 'Nothing was connected. You can close this window.', false); });
  });
})();
