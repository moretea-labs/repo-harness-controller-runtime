import { FACADE_TOOLS } from '../../runtime/control-plane/facade/types';

/** Preferred ChatGPT-facing facade tools. Must stay small and stable. */
export const PREFERRED_FACADE_TOOL_NAMES = [...FACADE_TOOLS] as const;

/** Default tools/list for the controller core toolset. */
export const DEFAULT_CONTROLLER_TOOL_NAMES = [
  'rh_status',
  'rh_inbox',
  'rh_context',
  'rh_work',
  'rh_access',
  'repository_access_get',
  'repository_list',
  'repository_get',
  'repository_register',
  'repository_latest_source_diagnose',
  'repository_bootstrap_local_project',
] as const;
