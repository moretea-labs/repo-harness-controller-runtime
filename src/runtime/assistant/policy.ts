import type { AssistantPluginActionDescriptor } from '../plugins/types';
import type { AssistantPolicyDecision } from './types';

function hasExternalAttendees(args: Record<string, unknown>): boolean {
  return Array.isArray(args.attendees) && args.attendees.length > 0;
}

export function evaluateAssistantActionPolicy(
  pluginId: string,
  action: AssistantPluginActionDescriptor,
  args: Record<string, unknown>,
  options: { automatedRoutine?: boolean } = {},
): AssistantPolicyDecision {
  if (action.readOnly || action.risk === 'readonly') {
    return { decision: 'allow', reason: 'Read-only action is safe for assistant execution.', autoConfirmAuthorization: false };
  }

  if (action.risk === 'destructive') {
    return {
      decision: 'approval_required',
      reason: 'Destructive external effects require explicit human approval.',
      autoConfirmAuthorization: false,
      requiredConfirmationText: action.requiredConfirmationText,
    };
  }

  if (pluginId === 'google_tasks' && action.actionId === 'create_task') {
    return {
      decision: 'allow',
      reason: 'Creating a personal reminder/task is allowed as a low-risk assistant write.',
      autoConfirmAuthorization: action.confirmation !== 'none',
    };
  }

  if (pluginId === 'gmail' && action.actionId === 'create_draft') {
    return {
      decision: 'allow',
      reason: 'Creating a draft is reversible and does not send external mail.',
      autoConfirmAuthorization: action.confirmation !== 'none',
    };
  }

  if (pluginId === 'google_calendar' && action.actionId === 'create_event' && !hasExternalAttendees(args)) {
    return {
      decision: 'allow',
      reason: 'Creating a self calendar event without attendees is allowed as a personal assistant write.',
      autoConfirmAuthorization: action.confirmation !== 'none',
    };
  }

  if (options.automatedRoutine) {
    return {
      decision: 'approval_required',
      reason: 'Scheduled routines may not perform this write without a fresh human approval.',
      autoConfirmAuthorization: false,
      requiredConfirmationText: action.requiredConfirmationText,
    };
  }

  return {
    decision: 'approval_required',
    reason: 'Remote write action requires explicit human approval before execution.',
    autoConfirmAuthorization: false,
    requiredConfirmationText: action.requiredConfirmationText,
  };
}

export function defaultRoutineAllowedActions(): string[] {
  return [
    'gmail.list_messages',
    'gmail.get_message',
    'google_calendar.list_events',
    'google_calendar.get_event',
    'google_tasks.list_tasks',
    'google_tasks.list_tasklists',
    'gmail.create_draft',
  ];
}

export function defaultRoutineForbiddenActions(): string[] {
  return [
    'gmail.send_message',
    'gmail.trash_message',
    'google_calendar.cancel_event',
    'google_calendar.reschedule_event',
    'google_tasks.delete_task',
    'google_tasks.reschedule_task',
  ];
}
