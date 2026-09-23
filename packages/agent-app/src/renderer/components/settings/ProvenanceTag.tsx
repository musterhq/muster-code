import React from 'react';
import type {Provenance} from './provenance';

/** PRO-10: where a value comes from, plus "Reset to inherited" while it overrides the level above. */
export function ProvenanceTag({provenance,title,onReset}:{provenance:Provenance;title:string;onReset?:()=>void}):React.ReactElement {
  return <span className="preference-provenance" data-level={provenance.level}>
    <span className="preference-provenance-label">{provenance.label}</span>
    {provenance.canReset&&onReset&&<button type="button" aria-label={`Reset ${title} to ${provenance.inherits}`} title={`Use ${provenance.inherits} again`} onClick={onReset}>Reset to inherited</button>}
  </span>;
}
