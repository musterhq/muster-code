/** Width classes (#326 phase 4), as Material defines them: compact under 600, medium 600–839, expanded 840 and up. Compact
 *  is the phone layout; medium adds the chat beside the list; expanded adds the inspector. */
export type WidthClass = 'compact' | 'medium' | 'expanded';
export const widthClass = (width: number): WidthClass => width < 600 ? 'compact' : width < 840 ? 'medium' : 'expanded';
/** The chat column never grows past this, so lines stay readable on a wide screen. */
export const CHAT_COLUMN_MAX = 760;
export const SIDEBAR_WIDTH = 320;
export const INSPECTOR_WIDTH = 320;
