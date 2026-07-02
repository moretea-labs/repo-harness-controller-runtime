import type { ExecutionJobPayload, ExecutionJobPriority, ResourceClaimSpec } from '../../execution/jobs/types';
import type { Campaign, CampaignCheckpoint, CampaignReviewPacket, CampaignSupervisorDecision } from './types';

export interface CampaignSupervisorTriggerSpec {
  operation: string;
  arguments: Record<string, unknown>;
  target?: ExecutionJobPayload['target'];
  priority: ExecutionJobPriority;
  resourceClaims: ResourceClaimSpec[];
  timeoutMs?: number;
}

export interface CampaignSupervisorAdapter {
  readonly mode: Campaign['supervisor']['mode'];
  reviewPacket(campaign: Campaign, checkpoint: CampaignCheckpoint): CampaignReviewPacket;
  triggerSpec(campaign: Campaign, checkpoint: CampaignCheckpoint): CampaignSupervisorTriggerSpec | undefined;
  validateDecision(campaign: Campaign, checkpoint: CampaignCheckpoint, decision: CampaignSupervisorDecision): void;
}

function validateOpenDecision(checkpoint: CampaignCheckpoint, decision: CampaignSupervisorDecision): void {
  if (checkpoint.status !== 'open') throw new Error(`CAMPAIGN_CHECKPOINT_ALREADY_SUBMITTED: ${checkpoint.checkpointId}`);
  if (!decision.summary.trim()) throw new Error('CAMPAIGN_REVIEW_SUMMARY_REQUIRED');
}

export class PullCampaignSupervisorAdapter implements CampaignSupervisorAdapter {
  readonly mode = 'pull' as const;
  reviewPacket(_campaign: Campaign, checkpoint: CampaignCheckpoint): CampaignReviewPacket { return checkpoint.packet; }
  triggerSpec(): undefined { return undefined; }
  validateDecision(_campaign: Campaign, checkpoint: CampaignCheckpoint, decision: CampaignSupervisorDecision): void {
    validateOpenDecision(checkpoint, decision);
  }
}

export class OperationCampaignSupervisorAdapter implements CampaignSupervisorAdapter {
  readonly mode = 'operation' as const;
  reviewPacket(_campaign: Campaign, checkpoint: CampaignCheckpoint): CampaignReviewPacket { return checkpoint.packet; }
  triggerSpec(campaign: Campaign, checkpoint: CampaignCheckpoint): CampaignSupervisorTriggerSpec | undefined {
    const operation = campaign.supervisor.operation?.trim();
    if (!operation) return undefined;
    return {
      operation,
      arguments: {
        ...(campaign.supervisor.arguments ?? {}),
        repo_id: campaign.repoId,
        campaign_id: campaign.campaignId,
        checkpoint_id: checkpoint.checkpointId,
        checkpoint_nonce: checkpoint.nonce,
        goal_revision: checkpoint.goalRevision,
      },
      priority: campaign.supervisor.priority ?? 'P1',
      resourceClaims: campaign.supervisor.resourceClaims ?? [],
    };
  }
  validateDecision(_campaign: Campaign, checkpoint: CampaignCheckpoint, decision: CampaignSupervisorDecision): void {
    validateOpenDecision(checkpoint, decision);
  }
}

function workspaceAgentPrompt(campaign: Campaign, checkpoint: CampaignCheckpoint): string {
  return [
    'Review one repo-harness Campaign checkpoint and write the decision back through the connected repo-harness MCP tools.',
    '',
    `Repository id: ${campaign.repoId}`,
    `Campaign id: ${campaign.campaignId}`,
    `Checkpoint id: ${checkpoint.checkpointId}`,
    `Checkpoint nonce: ${checkpoint.nonce}`,
    `Goal revision: ${checkpoint.goalRevision}`,
    `Campaign revision at trigger: ${campaign.revision}`,
    '',
    'Required workflow:',
    '1. Call get_campaign_review_packet with repo_id, campaign_id, and checkpoint_id. Read any referenced Evidence Plane artifacts needed for a grounded review.',
    '2. Review the goal, acceptance criteria, task result, incremental evidence, risks, and any failed checks.',
    `3. Call submit_campaign_review exactly once with request_id workspace-agent-review:${checkpoint.checkpointId}:${checkpoint.nonce}, the same checkpoint nonce, and the same goal revision.`,
    '4. Choose the most appropriate action. Use request_changes or retry only with concrete instructions; use pause or escalate when human input is required; use approve_final only when the final packet is ready for human acceptance.',
    '5. Do not merely answer in chat. The MCP write-back is the durable result of this review.',
  ].join('\n');
}

export class WorkspaceAgentCampaignSupervisorAdapter implements CampaignSupervisorAdapter {
  readonly mode = 'workspace_agent' as const;
  reviewPacket(_campaign: Campaign, checkpoint: CampaignCheckpoint): CampaignReviewPacket { return checkpoint.packet; }
  triggerSpec(campaign: Campaign, checkpoint: CampaignCheckpoint): CampaignSupervisorTriggerSpec | undefined {
    const agentId = campaign.supervisor.workspaceAgentId?.trim();
    if (!agentId) return undefined;
    return {
      operation: 'trigger-workspace-agent',
      target: 'workspace-agent',
      arguments: {
        agent_id: agentId,
        input: workspaceAgentPrompt(campaign, checkpoint),
        conversation_key: campaign.supervisor.conversationKey?.trim()
          || `repo-harness:${campaign.repoId}:${campaign.campaignId}`,
        idempotency_key: `${checkpoint.checkpointId}:${checkpoint.triggerAttempts + 1}`,
      },
      priority: campaign.supervisor.priority ?? 'P1',
      resourceClaims: [],
      timeoutMs: 30_000,
    };
  }
  validateDecision(_campaign: Campaign, checkpoint: CampaignCheckpoint, decision: CampaignSupervisorDecision): void {
    validateOpenDecision(checkpoint, decision);
  }
}

export function campaignSupervisorAdapter(campaign: Campaign): CampaignSupervisorAdapter {
  if (campaign.supervisor.mode === 'operation') return new OperationCampaignSupervisorAdapter();
  if (campaign.supervisor.mode === 'workspace_agent') return new WorkspaceAgentCampaignSupervisorAdapter();
  return new PullCampaignSupervisorAdapter();
}
