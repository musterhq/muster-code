/** Space to keep beside the transcript so the preview card never covers its text, or undefined when it does not
 *  overlap the (centred, max-width) column at all, or when reserving would leave the transcript too narrow to read.
 *  The reserve is the smallest that clears the card: the column re-centres in what is left, so a wide pane gives up
 *  roughly twice the overlap and a pane narrower than the column gives up exactly the overlap. */
const PIP_GAP=8, ROW_INSET=32, MIN_COLUMN=440;
export function pipReserveFor(box:{left:number;right:number;width:number},max:number,innerWidth:number,anchor:{right:number;width:number},side:'left'|'right'):{side:'left'|'right';px:number}|undefined {
  const pipLeft=innerWidth-anchor.right-anchor.width,pipRight=pipLeft+anchor.width;
  // Mirror the left side onto the right so one formula serves both: distance from the pane's near edge.
  const width=box.width, edge=side==='right'?pipLeft-PIP_GAP-box.left:box.right-(pipRight+PIP_GAP);
  const column=Math.min(width,max), textEnd=(width-column)/2+column-ROW_INSET;
  if(textEnd<=edge)return undefined;
  // Column at full width after the reserve: it re-centres, so its text ends at (width-R)/2 + max/2 - inset.
  let px=width-2*(edge-(max/2-ROW_INSET));
  // Narrower than the column after the reserve: the column fills what is left and its text ends at width-R-inset.
  if(width-px<max)px=width-(edge+ROW_INSET);
  if(px<=0||width-px<MIN_COLUMN)return undefined;
  return {side,px:Math.ceil(px)};
}
