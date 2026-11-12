/** #175: a chat that is one run of a comparison links to the compare view (chat header chip, sidebar row action). */
import {GitCompare} from 'lucide-react';
import React from 'react';
import {comparisonOf, useComparisons} from '../comparisons';
import {openCompareScreen} from '../store';
import {Tip} from './Tooltip';
import './compare.css';

export function useComparisonOf(chatId: string | null | undefined) { return comparisonOf(useComparisons(), chatId); }

export function CompareChip({chatId}: {chatId: string}): React.ReactElement | null {
  const comparison = useComparisonOf(chatId);
  if (!comparison) return null;
  return <Tip label="Compare the runs of this prompt side by side">
    <button type="button" className="compare-chip" onClick={() => openCompareScreen(comparison.id)}>
      <GitCompare size={11} aria-hidden="true"/>Compare {comparison.runs.length} runs
    </button>
  </Tip>;
}

export function CompareRowAction({chatId, title, tabIndex}: {chatId: string; title: string; tabIndex?: number}): React.ReactElement | null {
  const comparison = useComparisonOf(chatId);
  if (!comparison) return null;
  return <Tip label="Compare runs"><button type="button" className="icon-button" tabIndex={tabIndex} aria-label={`Compare runs of ${title}`} onClick={() => openCompareScreen(comparison.id)}><GitCompare size={14}/></button></Tip>;
}
