import type { Subagent } from './subagent.js';

export interface Team {
  id: string;
  team_name: string;
  description?: string;
  lead_session_id?: string;
  created_at: string;
  ended_at?: string;
  member_count: number;
  members?: Subagent[];
  metadata: Record<string, unknown>;
}
