(function () {
  'use strict';
  var invite = /^\/invite\/([A-Za-z0-9_-]{10,200})$/.exec(location.pathname);
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var next = params.get('next');
  var safeNext = next && /^\/(?!\/)/.test(next) && !/^\/(login|invite)/.test(next) ? next : '/';
  function fail(message) { $('error').textContent = message; $('error').hidden = false; $('submit').disabled = false; }
  if (params.get('reason') === 'revoked') fail('Your session ended. Sign in again.');
  if (invite) {
    document.title = 'Join · Muster Server';
    $('title').textContent = 'Join this Muster Server';
    $('subtitle').textContent = 'Checking your invite…';
    $('name-row').hidden = false; $('pw-hint').hidden = false;
    $('password').setAttribute('autocomplete', 'new-password');
    $('submit').textContent = 'Create account';
    $('foot').textContent = 'Invite links work once and expire.';
    fetch('/api/invites/' + invite[1], { headers: { accept: 'application/json' } }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (x) {
      if (!x.ok) { $('subtitle').textContent = ''; $('form').hidden = true; fail(x.j.error || 'This invite link is not valid.'); $('error').hidden = false; $('card').appendChild($('error')); return; }
      $('subtitle').textContent = 'You were invited as ' + (x.j.role === 'admin' || x.j.role === 'owner' ? 'an ' : 'a ') + x.j.role + '. The link expires ' + new Date(x.j.expiresAt).toLocaleString() + '.';
    });
  }
  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    $('error').hidden = true; $('submit').disabled = true;
    var body = { username: $('username').value.trim(), password: $('password').value };
    if (invite) body.displayName = $('displayName').value.trim();
    var url = invite ? '/api/invites/' + invite[1] + '/accept' : '/api/auth/login';
    fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) { if (x.ok) location.replace(invite ? '/' : safeNext); else fail(x.j.error || 'Sign-in failed.'); })
      .catch(function () { fail('Could not reach the server.'); });
  });
})();
