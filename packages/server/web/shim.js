/*
 * Muster Server web shim: provides window.muster (the same bridge the desktop preload exposes) over HTTP + WebSocket, so the web UI
 * is the desktop renderer, unchanged. Native-only interactions are handled in the browser where possible (menus, downloads, clipboard,
 * links); the rest answer with a clear "Desktop only" error the UI shows.
 */
(function () {
  'use strict';
  var state = { csrf: null, user: null, server: null, settings: null };
  var LOCAL_PREFS = 'muster-web-prefs';
  function signIn() { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search)); }
  var ready = fetch('/api/auth/me', { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(function (r) {
    if (r.status === 401) { signIn(); throw new Error('Signed out'); }
    if (!r.ok) throw new Error('Muster Server is unavailable (HTTP ' + r.status + ').');
    return r.json();
  }).then(function (j) { state.csrf = j.csrf; state.user = j.user; state.server = j.server; return j; });

  function rpc(command, input) {
    return ready.then(function () {
      return fetch('/rpc', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-muster-csrf': state.csrf }, body: JSON.stringify({ command: command, input: input === undefined ? null : input }) });
    }).then(function (r) {
      if (r.status === 401) { signIn(); throw new Error('Your session ended. Sign in again.'); }
      return r.json().then(function (j) {
        if (!j || !j.ok) { var e = new Error((j && j.error) || ('Request failed (HTTP ' + r.status + ').')); e.code = j && j.code; throw e; }
        return j.value === null ? undefined : j.value;
      });
    });
  }
  var isAdmin = function () { return !!state.user && (state.user.role === 'owner' || state.user.role === 'admin'); };

  // ---------------------------------------------------------------- events
  var listeners = new Set(), socket = null, attempts = 0, closedByUs = false;
  function emit(event) { listeners.forEach(function (l) { try { l(event); } catch (err) { console.error('muster:event listener failed', err); } }); }
  function connect() {
    if (socket || closedByUs) return;
    var url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/events';
    var ws = new WebSocket(url);
    socket = ws;
    ws.onopen = function () {
      if (attempts > 0) rpc('app.snapshot').then(function (snapshot) { emit({ type: 'snapshot', snapshot: snapshot }); }, function () {});
      attempts = 0;
    };
    ws.onmessage = function (m) {
      var event; try { event = JSON.parse(m.data); } catch (e) { return; }
      if (event && event.type === 'server:revoked') { closedByUs = true; alert(event.message || 'Your access was revoked.'); signIn(); return; }
      if (event && typeof event.type === 'string' && event.type.indexOf('server:') === 0) return;
      if (event && event.type === 'settingsChanged' && !isAdmin()) event = { type: 'settingsChanged', values: withLocalPrefs(event.values) };
      emit(event);
    };
    ws.onclose = function (e) {
      socket = null;
      if (closedByUs) return;
      if (e.code === 4401) { signIn(); return; }
      attempts++;
      setTimeout(connect, Math.min(30000, 500 * Math.pow(2, Math.min(attempts, 6))));
    };
  }

  // ---------------------------------------------------------------- per-browser preferences for non-admins
  function readPrefs() { try { return JSON.parse(localStorage.getItem(LOCAL_PREFS) || '{}') || {}; } catch (e) { return {}; } }
  function withLocalPrefs(values) { var p = readPrefs(), out = {}; for (var k in values) out[k] = values[k]; for (var k2 in p) out[k2] = p[k2]; return out; }
  var PERSONAL = /^(appearance\.|chat\.inlineDiffs|chat\.responseStyle|diff\.|composer\.|sidebar\.)/;

  // ---------------------------------------------------------------- DOM menu (stands in for native context menus)
  function menu(x, y, items) {
    return new Promise(function (resolve) {
      var old = document.getElementById('muster-web-menu'); if (old) old.remove();
      var el = document.createElement('div');
      el.id = 'muster-web-menu'; el.setAttribute('role', 'menu');
      el.style.cssText = 'position:fixed;z-index:2147483647;min-width:190px;padding:4px;border-radius:9px;font:13px system-ui,-apple-system,sans-serif;' +
        'background:var(--surface-elevated,#26262a);color:var(--text,#e8e8ea);border:1px solid rgba(127,127,127,.28);box-shadow:0 10px 30px rgba(0,0,0,.35)';
      var done = false;
      function finish(v) { if (done) return; done = true; el.remove(); document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', key, true); resolve(v); }
      function outside(e) { if (!el.contains(e.target)) finish(null); }
      function key(e) { if (e.key === 'Escape') { e.preventDefault(); finish(null); } }
      items.forEach(function (item) {
        if (item === '-') { var hr = document.createElement('div'); hr.style.cssText = 'height:1px;margin:4px 6px;background:rgba(127,127,127,.25)'; el.appendChild(hr); return; }
        var b = document.createElement('button');
        b.type = 'button'; b.setAttribute('role', 'menuitem'); b.textContent = item.label;
        b.style.cssText = 'display:block;width:100%;text-align:left;padding:6px 10px;border:0;border-radius:6px;background:transparent;color:' + (item.danger ? '#ff6b6b' : 'inherit') + ';font:inherit;cursor:pointer';
        b.onmouseenter = function () { b.style.background = 'rgba(127,127,127,.18)'; }; b.onmouseleave = function () { b.style.background = 'transparent'; };
        b.onclick = function () { finish(item.value); };
        el.appendChild(b);
      });
      document.body.appendChild(el);
      var r = el.getBoundingClientRect();
      el.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
      el.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
      setTimeout(function () { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', key, true); }, 0);
      var first = el.querySelector('button'); if (first) first.focus();
    });
  }
  function download(name, text, type) {
    var url = URL.createObjectURL(new Blob([text], { type: type }));
    var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function snapshotChat(id) { return rpc('app.snapshot').then(function (s) { return (s.chats || []).find(function (c) { return c.id === id; }); }); }

  var LOCAL = {
    'updates.status': function () { return { phase: 'disabled', current: (state.server && state.server.version) || '', channel: 'stable', autoCheck: false, message: 'Muster Server updates are installed by the server admin.' }; },
    'updates.check': function () { return LOCAL['updates.status'](); },
    'updates.setAutoCheck': function () { return LOCAL['updates.status'](); },
    'files.nativeAvailable': function () { return false; },
    'files.nativeHide': function () { return undefined; },
    'files.nativePosition': function () { return undefined; },
    'clipboard.write': function (input) { return navigator.clipboard.writeText(String(input && input.text || '')); },
    'link.open': function (input) {
      var u = new URL(String(input && input.url));
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Unsupported link.');
      window.open(u.href, '_blank', 'noopener,noreferrer');
    },
    'chat.export.file': function (input) {
      return rpc('chat.export', { id: input.id, format: input.format, redact: input.redact }).then(function (d) {
        download(d.fileName, d.text, input.format === 'json' ? 'application/json' : input.format === 'html' ? 'text/html' : 'text/markdown');
        return { saved: true, fileName: d.fileName };
      });
    },
    'project.export.file': function (input) {
      return rpc('project.export', { projectId: input.projectId }).then(function (d) {
        var name = String((d.project && d.project.name) || 'project').replace(/[^\w.-]+/g, '-') + '-muster-export.json';
        download(name, JSON.stringify(d, null, 2) + '\n', 'application/json');
        return { saved: true, fileName: name, truncated: !!(d.chats.truncated || d.tasks.truncated || d.decisions.truncated || d.activity.truncated) };
      });
    },
    'chat.contextMenu': function (input) {
      return snapshotChat(input.id).then(function (chat) {
        if (!chat) throw new Error('Chat no longer exists.');
        return menu(input.x, input.y, [
          { label: 'Rename', value: 'rename' }, { label: chat.pinned ? 'Unpin' : 'Pin', value: 'pin' },
          { label: chat.unread ? 'Mark as read' : 'Mark as unread', value: 'unread' }, { label: 'Fork', value: 'fork' },
          { label: 'Snooze…', value: 'snooze' }, { label: 'Share or export…', value: 'share' }, '-',
          { label: chat.archived ? 'Unarchive' : 'Archive', value: 'archive' }, { label: 'Delete…', value: 'delete', danger: true },
        ]).then(function (choice) {
          if (choice === 'unread') return rpc('chat.markUnread', { id: chat.id, unread: !chat.unread }).then(function () { return null; });
          if (choice === 'delete') {
            if (!confirm('Permanently delete "' + chat.title + '"? Its messages are removed from the server. This cannot be undone.')) return null;
            return rpc('chat.delete', { id: chat.id, force: chat.status === 'running' }).then(function () { return null; });
          }
          return choice;
        });
      });
    },
    'project.contextMenu': function (input) {
      return rpc('app.snapshot').then(function (s) {
        var p = (s.projects || []).find(function (x) { return x.id === input.id; });
        if (!p) throw new Error('Project no longer exists.');
        return menu(input.x, input.y, [{ label: 'Open', value: 'open' }, { label: 'New chat', value: 'new-chat' }, '-', { label: 'Rename', value: 'rename' },
          { label: 'Edit…', value: 'edit' }, { label: 'Export…', value: 'export' }, '-', p.archived ? { label: 'Restore', value: 'restore' } : { label: 'Archive…', value: 'archive' }]);
      });
    },
    'folder.contextMenu': function (input) {
      if (input.run === 'relink') throw new Error('Desktop only: relinking a folder picks a path with the native dialog. Ask an admin to re-add the folder on the server.');
      return menu(input.x, input.y, [{ label: 'New chat', value: 'new-chat' }, { label: 'Files', value: 'files' }, { label: 'Rename', value: 'rename' }, { label: 'Default model…', value: 'default-model' }]);
    },
    'folder.pick': function () {
      if (!isAdmin()) throw new Error('Only server admins can add folders: a folder here is a directory on the server, not on your computer.');
      var p = prompt('Path of a folder on the server (for example /srv/repos/app):');
      if (!p) return null;
      return rpc('folder.add', { path: p.trim() });
    },
    'settings.get': function (input) { return rpc('settings.get', input).then(function (v) { return isAdmin() || !v || !v.values ? v : Object.assign({}, v, { values: withLocalPrefs(v.values) }); }); },
    'settings.set': function (input) {
      if (isAdmin()) return rpc('settings.set', input);
      var keys = Object.keys((input && input.values) || {});
      if (!keys.length || !keys.every(function (k) { return PERSONAL.test(k); })) throw new Error('Only server admins can change server-wide settings.');
      var p = readPrefs(); keys.forEach(function (k) { p[k] = input.values[k]; });
      try { localStorage.setItem(LOCAL_PREFS, JSON.stringify(p)); } catch (e) { /* storage unavailable: applies for this page only */ }
      return rpc('settings.get', {}).then(function (v) { var merged = Object.assign({}, v, { values: withLocalPrefs(v.values) }); emit({ type: 'settingsChanged', values: merged.values }); return merged; });
    },
  };

  window.muster = {
    host: 'web',
    invoke: function (command, input) {
      var local = LOCAL[command];
      if (local) { try { return Promise.resolve(local(input)); } catch (err) { return Promise.reject(err); } }
      return rpc(command, input);
    },
    subscribe: function (listener) { listeners.add(listener); ready.then(connect, function () {}); return function () { listeners.delete(listener); }; },
  };
  window.musterMenu = { onAction: function () { return function () {}; }, closeWindow: function () {} };
  window.musterServer = {
    ready: ready,
    info: function () { return { user: state.user, server: state.server }; },
    invoke: rpc,
    signOut: function () {
      closedByUs = true; if (socket) socket.close();
      return fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'x-muster-csrf': state.csrf || '' } }).finally(function () { location.replace('/login'); });
    },
  };
})();
