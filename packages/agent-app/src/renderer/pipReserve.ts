/** Space to keep beside the transcript so the preview card never covers its text, or undefined when it does not
 *  overlap the (centred, max-width) column at all, or when reserving would leave the transcript too narrow to read. */
const PIP_GAP=8, ROW_INSET=32, MIN_TRANSCRIPT=520;
export function pipReserveFor(box:{left:number;right:number;width:number},max:number,innerWidth:number,anchor:{right:number;width:number},side:'left'|'right'):{side:'left'|'right';px:number}|undefined {
  const column=Math.min(box.width,max),textLeft=box.left+(box.width-column)/2+ROW_INSET,textRight=textLeft+column-2*ROW_INSET;
  const pipLeft=innerWidth-anchor.right-anchor.width,pipRight=pipLeft+anchor.width;
  const px=side==='right'?box.right-pipLeft+PIP_GAP:pipRight-box.left+PIP_GAP;
  const overlaps=side==='right'?pipLeft-PIP_GAP<textRight:pipRight+PIP_GAP>textLeft;
  return overlaps&&px>0&&box.width-px>=MIN_TRANSCRIPT?{side,px:Math.round(px)}:undefined;
}
