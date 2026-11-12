/** The masked value field every private secret card uses (#842): the chat's secret and sudo card and a Project's secret request. */
import React from 'react';

export function SecretField({ label, value, disabled, placeholder = 'Paste the value', className = 'ws-input', onChange, onSubmit }: { label: string; value: string; disabled?: boolean; placeholder?: string; className?: string; onChange(value: string): void; onSubmit?(): void }): React.ReactElement {
  return <input type="password" className={className} autoComplete="off" spellCheck={false} aria-label={label} placeholder={placeholder} value={value} disabled={disabled}
    onChange={e => onChange(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && onSubmit) { e.preventDefault(); onSubmit(); } }}/>;
}
