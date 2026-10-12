/** 3D device frame (#363): built on the shared three-engine of workstream B (#362). Until that engine is in this build,
 *  the 3D toggle is hidden and the flat view is the only view. */
import type React from 'react';
import type {DeviceSession} from '../../../shared/device-protocol';
import type {DeviceFeed} from '../../devices/deviceFeed';

export const threeAvailable = (): boolean => false;
export function DeviceFrame3D(_props: {session: DeviceSession; feed?: DeviceFeed; tick: number; input: unknown; onFallback(): void}): React.ReactElement | null { return null; }
