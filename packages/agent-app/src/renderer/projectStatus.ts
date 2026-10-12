import { PROJECT_STATUSES, type ProjectStatus } from '../shared/domains/work-protocol.ts';

/** A project with no tasks has no progress to report: the default 'In progress' badge is left off until there is work. */
export const showsStatusChip = (status: string, taskCount: number | null | undefined): boolean => !(taskCount === 0 && (status === 'in_progress' || !PROJECT_STATUSES.includes(status as ProjectStatus)));
