/**
 * PRO-10: where a setting's value comes from, in inheritance order built-in → you (this Mac) → folder → Project → chat,
 * and whether it can be reset to the level it inherits from. Pure, so the shell and tests share it.
 */
import {SETTING_DEFAULTS, type AppSettings, type SettingKey} from '../../../shared/domains/settings-protocol.ts';

export type ProvenanceLevel = 'built-in' | 'user' | 'folder' | 'project' | 'chat';
export interface Provenance {
  level: ProvenanceLevel;
  /** Short chip text, e.g. "Built-in default" or "Set by you". */
  label: string;
  /** What "Reset to inherited" returns to; absent when the value already is the inherited one. */
  inherits?: string;
  canReset: boolean;
}
const LABELS: Record<ProvenanceLevel, string> = {'built-in': 'Built-in default', user: 'Set by you', folder: 'Folder override', project: 'Project override', chat: 'This chat only'};
const PARENT: Record<ProvenanceLevel, string> = {'built-in': '', user: 'the built-in default', folder: 'your default', project: 'your default', chat: 'the Project or your default'};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function provenance(level: ProvenanceLevel): Provenance {
  return level === 'built-in' ? {level, label: LABELS[level], canReset: false} : {level, label: LABELS[level], inherits: PARENT[level], canReset: true};
}
/** An app setting is "Set by you" only while it differs from the built-in default. */
export function settingProvenance<K extends SettingKey>(key: K, values: AppSettings): Provenance {
  return provenance(same(values[key], SETTING_DEFAULTS[key]) ? 'built-in' : 'user');
}
/** A group of values that is stored as one record (diff defaults): overridden when a stored record exists and differs. */
export function recordProvenance<T>(stored: boolean, value: T, inherited: T, level: ProvenanceLevel = 'user'): Provenance {
  return stored && !same(value, inherited) ? provenance(level) : provenance('built-in');
}
