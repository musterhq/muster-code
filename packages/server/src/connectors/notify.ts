/**
 * Read-only notifications (Wave 4, G27): a connector with a notify channel and a notify project posts what needs you in that project, and
 * each new revision of its status cards and digests, to the channel. One-way: nothing said in the channel is read as a command by this path.
 *
 * Event-driven. Nothing runs unless a runtime event names a project that some enabled connector notifies for; then a single debounce timer
 * per project collects what is new, posts it, and remembers what it posted (so a restart never repeats a notice). Text is redacted for secrets.
 */
import { redactSecrets } from '../../../agent-app/src/runtime/secret-redaction.ts';
import { newId } from '../auth/tokens.ts';
import type { RuntimeHost } from '../runtime-host.ts';
import type { ConnectorRecord, ServerStore } from '../store/types.ts';
import type { ConnectorRegistry } from './registry.ts';

const DEBOUNCE_MS = 8000, TARGET_TTL_MS = 30_000, KEEP = 400;
export interface NotifyDeps { store: ServerStore; registry: () => ConnectorRegistry; runtime: () => RuntimeHost | null; publicUrl: () => string | null; log: (line: string) => void; debounceMs?: number }
interface Item { key: string; text: string }

export class NotificationBridge {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private targets: { at: number; list: ConnectorRecord[] } | null = null;
  private busy = new Set<string>();
  constructor(private d: NotifyDeps) {}
  invalidate() { this.targets = null; }
  private async notifying(projectId: string): Promise<ConnectorRecord[]> {
    if (!this.targets || Date.now() - this.targets.at > TARGET_TTL_MS) this.targets = { at: Date.now(), list: (await this.d.store.listConnectors()).filter(c => c.enabled && typeof c.config.notifyChannel === 'string' && c.config.notifyChannel && typeof c.config.notifyProject === 'string') };
    return this.targets.list.filter(c => c.config.notifyProject === projectId);
  }
  /** Called with every runtime event. Cheap when no connector notifies. */
  touch(event: { type: string; projectId?: unknown }) {
    if (typeof event.projectId !== 'string' || !['projectChanged', 'workChanged'].includes(event.type)) return;
    const projectId = event.projectId;
    if (this.timers.has(projectId)) return;
    void this.notifying(projectId).then(list => {
      if (!list.length || this.timers.has(projectId)) return;
      const t = setTimeout(() => { this.timers.delete(projectId); void this.flush(projectId).catch(e => this.d.log(`notify ${projectId} failed: ${(e as Error).message}`)); }, this.d.debounceMs ?? DEBOUNCE_MS); t.unref?.();
      this.timers.set(projectId, t);
    }).catch(() => undefined);
  }
  private async collect(projectId: string, projectName: string): Promise<Item[]> {
    const rt = this.d.runtime(); if (!rt?.running) return [];
    const link = this.d.publicUrl() ? `\nOpen: ${this.d.publicUrl()!.replace(/\/+$/, '')}/?project=${encodeURIComponent(projectId)}` : '';
    const items: Item[] = [];
    const gov = await rt.invoke('project.gov.summary', { projectId }) as { items: { id: string; title: string; why: string }[] };
    for (const i of gov.items) items.push({ key: `need:${i.id}`, text: `Needs you in ${projectName}: ${i.title}${i.why ? `\n${i.why}` : ''}${link}` });
    const ap = await rt.invoke('project.approvals.list', { projectId }) as { items: { id: string; kind: string; title: string; requestedBy: string; state: string }[] };
    for (const a of ap.items) if (a.state === 'pending' && a.kind === 'hire') items.push({ key: `approval:${a.id}`, text: `Approval in ${projectName}: ${a.title} (asked by ${a.requestedBy})${link}` });
    const cards = await rt.invoke('work.summaries.list', { projectId }) as { cards: { id: string; title: string; rev: number | null; text: string }[] };
    for (const c of cards.cards) if (c.rev && c.text.trim()) items.push({ key: `summary:${c.id}:${c.rev}`, text: `${c.title} (${projectName}, revision ${c.rev})\n${c.text.trim().slice(0, 1500)}${link}` });
    return items;
  }
  async flush(projectId: string): Promise<number> {
    if (this.busy.has(projectId)) return 0;
    this.busy.add(projectId);
    try {
      const list = await this.notifying(projectId); if (!list.length) return 0;
      const rt = this.d.runtime(); if (!rt?.running) return 0;
      const name = (await rt.snapshot()).projects.find(p => p.id === projectId)?.name ?? 'a project';
      const items = await this.collect(projectId, name);
      let sent = 0;
      for (const c of list) {
        const metaKey = `notify:${c.id}`, seen: string[] = JSON.parse((await this.d.store.meta(metaKey)) ?? '[]');
        const fresh = items.filter(i => !seen.includes(i.key));
        // The first run for a connector records what is already there instead of flooding the channel with the backlog.
        const first = (await this.d.store.meta(`${metaKey}:primed`)) === null;
        if (first) await this.d.store.setMeta(`${metaKey}:primed`, '1');
        const toSend = first && c.config.notifyBacklog !== true ? [] : fresh;
        for (const i of toSend.slice(0, 10)) {
          try { await this.d.registry().notify(c.id, redactSecrets(i.text), i.key); sent++; }
          catch (e) { await this.d.store.addConnectorEvent({ id: newId(), connectorId: c.id, ts: new Date().toISOString(), direction: 'error', externalId: null, conversation: String(c.config.notifyChannel), chatId: null, runId: null, status: 'notify-failed', detail: (e as Error).message.slice(0, 300) }); }
        }
        await this.d.store.setMeta(metaKey, JSON.stringify([...seen, ...fresh.map(i => i.key)].slice(-KEEP)));
      }
      return sent;
    } finally { this.busy.delete(projectId); }
  }
  dispose() { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}
