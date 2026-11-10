/**
 * Settings › Integrations › Git hosts (#329): sign in to GitLab (gitlab.com or a self-hosted host) and Bitbucket Cloud so
 * the PR and CI surfaces work there too. glab, when signed in, needs nothing here. A token is kept in the encrypted
 * secret store under its host and sent only to that host; it never comes back to this screen.
 */
import React, {useEffect, useState} from 'react';
import type {ForgeAccounts as Accounts} from '../../../shared/domains/forge-protocol';
import {invoke} from '../../bridge';
import {notifySuccess} from '../../store';
import {cleanIpcError} from '../resourceErrors';
import {SecretField} from '../SecretField';
import './forge-accounts.css';

type Kind = 'gitlab' | 'bitbucket';
const LABEL: Record<Kind, string> = {gitlab: 'GitLab', bitbucket: 'Bitbucket'};

export function ForgeAccounts(): React.ReactElement {
  const [view, setView] = useState<Accounts>();
  const [kind, setKind] = useState<Kind>('gitlab');
  const [host, setHost] = useState('gitlab.com');
  const [username, setUsername] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { let live = true; invoke('forge.accounts', {}).then(value => { if (live) setView(value); }, cause => { if (live) setError(cleanIpcError(cause)); }); return () => { live = false; }; }, []);
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (busy || !token.trim()) return;
    setBusy(true); setError('');
    try {
      setView(await invoke('forge.account.save', {kind, ...(kind === 'gitlab' ? {host} : {}), ...(username.trim() ? {username: username.trim()} : {}), token}));
      setToken(''); notifySuccess(`${LABEL[kind]} token saved for ${kind === 'gitlab' ? host : 'bitbucket.org'}`);
    } catch (cause) { setError(cleanIpcError(cause)); }
    finally { setBusy(false); }
  };
  const remove = async (target: {kind: Kind; host: string}) => {
    setBusy(true); setError('');
    try { setView(await invoke('forge.account.remove', target)); } catch (cause) { setError(cleanIpcError(cause)); } finally { setBusy(false); }
  };
  return <section className="forge-accounts" aria-label="Git hosts">
    <ul className="forge-account-list" role="list">
      {view?.glab.hosts.map(name => <li key={`glab:${name}`} className="forge-account"><span className="forge-account-host">GitLab · {name}</span><span className="forge-account-meta">Signed in with glab</span></li>)}
      {view?.accounts.map(account => <li key={`${account.kind}:${account.host}`} className="forge-account">
        <span className="forge-account-host">{LABEL[account.kind]} · {account.host}{account.username ? ` · ${account.username}` : ''}</span>
        <span className="forge-account-meta">{account.hasToken ? 'Token saved' : 'Token missing'}</span>
        <button type="button" className="forge-button" disabled={busy} onClick={() => void remove({kind: account.kind, host: account.host})} aria-label={`Remove ${LABEL[account.kind]} account for ${account.host}`}>Remove</button>
      </li>)}
    </ul>
    <form className="forge-form" onSubmit={event => void save(event)} aria-label="Add a Git host account">
      <label>Host
        <select className="ws-input" value={kind} disabled={busy} onChange={event => { const next = event.target.value as Kind; setKind(next); setHost(next === 'gitlab' ? 'gitlab.com' : 'bitbucket.org'); }} aria-label="Git host">
          <option value="gitlab">GitLab</option><option value="bitbucket">Bitbucket Cloud</option>
        </select>
      </label>
      {kind === 'gitlab'
        ? <label>Host name<input className="ws-input" value={host} disabled={busy} spellCheck={false} placeholder="gitlab.com or git.example.com" onChange={event => setHost(event.target.value)}/></label>
        : <label>Username or Atlassian email<input className="ws-input" value={username} disabled={busy} spellCheck={false} autoComplete="off" placeholder="Leave empty for an access token" onChange={event => setUsername(event.target.value)}/></label>}
      <label className="is-wide">{kind === 'gitlab' ? 'Personal access token (api scope)' : 'App password or API token'}
        <SecretField label={kind === 'gitlab' ? 'GitLab token' : 'Bitbucket token'} value={token} disabled={busy} placeholder="Paste the token" onChange={setToken}/>
      </label>
      {error && <p className="forge-error is-wide" role="alert">{error}</p>}
      {view && !view.secureStorage && <p className="forge-note is-wide">No secure keychain is available, so tokens can’t be saved here.{kind === 'gitlab' ? ' Sign in with glab instead.' : ''}</p>}
      <div className="forge-form-actions"><button type="submit" className="forge-button is-primary" disabled={busy || !token.trim() || (kind === 'gitlab' && !host.trim())}>{busy ? 'Saving…' : 'Save token'}</button></div>
    </form>
    <p className="forge-note">{view?.glab.installed ? 'glab is installed: run `glab auth login` for a host and Muster uses it with no token here. ' : ''}Tokens are kept in the encrypted secret store and sent only to the host they were saved for. Review threads, reviews and reviewer requests stay GitHub-only for now.</p>
  </section>;
}
